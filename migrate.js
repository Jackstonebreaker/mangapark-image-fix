/* global chrome */

/**
 * migrate.js
 *
 * Panneau interne de migration (publishable) :
 * - lit mp_export_follows (fallback mp_export_partial)
 * - persiste mp_migrate_state = { index, targetSite, openNewTab }
 * - ouvre uniquement des URLs de recherche (aucune automatisation)
 * - permet de supprimer des items et d'exporter CSV/JSON
 * - respecte la langue UI (uiLanguage) via chrome.i18n + fallback locale JSON
 */

(function () {
  const EXPORT_DATA_KEY = "mp_export_follows";
  const EXPORT_PARTIAL_KEY = "mp_export_partial";
  const MIGRATE_STATE_KEY = "mp_migrate_state";
  // If sync storage is readable but not writable (quota / policy / transient), popup.js stores a marker locally.
  // Migration panel must respect it so it doesn't show an empty library when export data is stored locally.
  const CONFIG_STORAGE_MODE_KEY = "mp_config_storage_mode"; // "sync" | "local"
  // MangaDex auto-match state (local-only behavior; safe for a public extension)
  const MD_MATCH_STATE_KEY = "md_match_state";
  const MD_MATCH_RESULTS_KEY = "md_match_results";
  const MD_MATCH_CANCEL_KEY = "md_match_cancel";
  // MangaDex advanced auth (opt-in)
  const MD_AUTH_SETTINGS_KEY = "md_auth_settings"; // local
  const MD_FOLLOW_CANCEL_KEY = "md_follow_cancel";
  const MD_FOLLOW_SETTINGS_KEY = "md_follow_settings"; // local: { threshold, noOpenAfterFollow }

  const MD_API_BASE = "https://api.mangadex.org";
  const MD_SITE_BASE = "https://mangadex.org";
  const MD_MATCH_MIN_SCORE = 0.72;
  const MD_THROTTLE_MS = 500; // keep it gentle for a public extension
  const MD_FOLLOW_THROTTLE_MS = 800;

  const DEFAULT_MIGRATE_STATE = {
    index: 0,
    targetSite: "mangadex",
    openNewTab: true,
  };

  const DEFAULT_CONFIG = {
    uiLanguage: "auto",
    theme: "dark",
  };

  const LOCALES_BASE_PATH = "_locales";

  // Utils (pure helpers). Loaded via <script src="migrate_utils.js"> before this file.
  const U = window.MP_MIGRATE_UTILS;

  function $(id) {
    return document.getElementById(id);
  }

  function getChromeLastErrorMessage() {
    try {
      return chrome?.runtime?.lastError?.message || "";
    } catch {
      return "";
    }
  }

  function storageGet(area, keys) {
    return new Promise((resolve) => {
      try {
        area.get(keys, (items) => {
          const err = getChromeLastErrorMessage();
          if (err) return resolve({ __error: err });
          resolve(items || {});
        });
      } catch (e) {
        resolve({ __error: String(e) });
      }
    });
  }

  function storageSet(area, items) {
    return new Promise((resolve) => {
      try {
        area.set(items, () => {
          const err = getChromeLastErrorMessage();
          if (err) return resolve({ ok: false, error: err });
          resolve({ ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function getStorageMode() {
    try {
      const res = await storageGet(chrome.storage.local, [CONFIG_STORAGE_MODE_KEY]);
      if (res && !res.__error && typeof res[CONFIG_STORAGE_MODE_KEY] === "string") {
        const m = String(res[CONFIG_STORAGE_MODE_KEY] || "");
        return m === "local" ? "local" : "sync";
      }
    } catch {
      // no-op
    }
    return "sync";
  }

  async function getFromStorage(keys) {
    const mode = await getStorageMode();
    if (mode === "local") {
      const localRes = await storageGet(chrome.storage.local, keys);
      if (!localRes.__error) return { area: "local", data: localRes };
      const syncRes = await storageGet(chrome.storage.sync, keys);
      if (!syncRes.__error) return { area: "sync", data: syncRes };
      return { area: "none", data: {} };
    }
    const syncRes = await storageGet(chrome.storage.sync, keys);
    if (!syncRes.__error) return { area: "sync", data: syncRes };
    const localRes = await storageGet(chrome.storage.local, keys);
    if (!localRes.__error) return { area: "local", data: localRes };
    return { area: "none", data: {} };
  }

  async function setToStorage(items) {
    const mode = await getStorageMode();
    if (mode === "local") {
      const rLocal = await storageSet(chrome.storage.local, items);
      if (rLocal.ok) {
        // Best-effort: keep sync updated when possible.
        await storageSet(chrome.storage.sync, items);
        return true;
      }
      const rSync = await storageSet(chrome.storage.sync, items);
      return rSync.ok;
    }
    const rSync = await storageSet(chrome.storage.sync, items);
    if (rSync.ok) return true;
    const rLocal = await storageSet(chrome.storage.local, items);
    return rLocal.ok;
  }

  // i18n
  let i18nDict = null;

  function applyTheme(theme) {
    try {
      const t = String(theme || "dark").toLowerCase();
      // Figma Make uses `.dark` class on the root wrapper.
      document.documentElement.classList.toggle("dark", t === "dark");
      const root = document.getElementById("root");
      if (root) root.classList.toggle("dark", t === "dark");
    } catch {
      // no-op
    }
  }

  async function loadLocaleDict(lang) {
    const locale = String(lang || "").toLowerCase();
    if (!locale || locale === "auto") return null;
    const candidates = [locale, "en"];
    for (const cand of candidates) {
      try {
        const url = chrome.runtime.getURL(`${LOCALES_BASE_PATH}/${cand}/messages.json`);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const json = await res.json();
        const dict = {};
        for (const [k, v] of Object.entries(json || {})) {
          if (v && typeof v.message === "string") dict[k] = v.message;
        }
        return dict;
      } catch {
        // try next
      }
    }
    return null;
  }

  function t(key, substitutions) {
    const k = String(key || "");
    const subs = Array.isArray(substitutions) ? substitutions : [];

    if (i18nDict && typeof i18nDict[k] === "string") {
      let s = i18nDict[k];
      for (let i = 0; i < subs.length && i < 9; i += 1) {
        const idx = i + 1;
        s = s.replaceAll(`$${idx}`, String(subs[i]));
        s = s.replaceAll(`$${idx}$`, String(subs[i]));
      }
      return s;
    }

    try {
      const msg = chrome.i18n.getMessage(k, subs);
      return msg || "";
    } catch {
      return "";
    }
  }

  function applyI18nToDom() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const value = t(key);
      if (value) el.textContent = value;
    });

    // Titles/tooltips
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      const value = t(key);
      if (value) el.setAttribute("title", value);
    });

    // aria-label
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const key = el.getAttribute("data-i18n-aria-label");
      const value = t(key);
      if (value) el.setAttribute("aria-label", value);
    });
  }

  // Data state
  /** @type {{meta?: any, items?: any[]}|null} */
  let exportPayload = null;
  /** @type {any[]} */
  let items = [];
  /** @type {{index:number, targetSite:string, openNewTab:boolean}} */
  let migrateState = { ...DEFAULT_MIGRATE_STATE };
  /** @type {{status:string,index:number,total:number,matched:number,openIndex:number,updated_at?:string,error?:string}|null} */
  let mdMatchState = null;
  /** @type {any[]|null} */
  let mdMatchResults = null;
  let mdMatchRunning = false;
  let mdFollowRunning = false;

  function clampIndex(i) {
    if (!items.length) return 0;
    return Math.max(0, Math.min(items.length - 1, i));
  }

  function setError(msg) {
    const el = $("error");
    if (!el) return;
    if (!msg) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.style.display = "block";
    el.textContent = msg;
  }

  function normalizeTitle(s) {
    return U?.normalizeTitle ? U.normalizeTitle(s) : String(s || "").trim();
  }

  function buildSearchUrl(siteId, title) {
    return U?.buildSearchUrl ? U.buildSearchUrl(siteId, title) : "";
  }

  function openUrl(url) {
    if (!url) return;
    // Publishable constraint: NO chrome.tabs.* usage here.
    if (migrateState.openNewTab) {
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        // no-op
      }
      return;
    }

    // If user chose not to open in new tab, reuse current panel tab.
    try {
      window.location.href = url;
    } catch {
      // fallback
      try {
        window.open(url, "_self");
      } catch {
        // no-op
      }
    }
  }

  function downloadBlob(filename, mime, content) {
    try {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      // Some Chromium builds may ignore the download if we revoke too early.
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // no-op
        }
      }, 1000);
      setTimeout(() => {
        try {
          a.remove();
        } catch {
          // no-op
        }
      }, 0);
    } catch {
      // no-op
    }
  }

  function setMdMatchProgressText(text) {
    const el = document.getElementById("mdMatchProgressText");
    if (el) el.textContent = String(text || "-");
  }

  function setMdUiVisible(visible) {
    const panel = document.getElementById("mdAutoMatchPanel");
    if (!panel) return;
    panel.style.display = visible ? "block" : "none";
  }

  function setMdFollowUiVisible(visible) {
    const panel = document.getElementById("mdAutoFollowPanel");
    if (!panel) return;
    panel.style.display = visible ? "block" : "none";
  }

  function setMdAuthStatusText(text) {
    const el = document.getElementById("mdAuthStatus");
    if (el) el.textContent = String(text || "-");
  }

  function setMdFollowProgressText(text) {
    const el = document.getElementById("mdFollowProgressText");
    if (el) el.textContent = String(text || "-");
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const err = getChromeLastErrorMessage();
          if (err) return resolve({ ok: false, error: err });
          resolve(resp || null);
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function mdSaveAuthSettingsLocal({ clientId, clientSecret, username }) {
    await runtimeSendMessage({
      type: "MD_AUTH_SAVE_SETTINGS",
      clientId: String(clientId || ""),
      clientSecret: String(clientSecret || ""),
      username: String(username || ""),
    });
  }

  async function mdAuthStatus() {
    const resp = await runtimeSendMessage({ type: "MD_AUTH_STATUS" });
    if (!resp || resp.ok !== true) return { connected: false, error: resp?.error || "unknown" };
    return { connected: !!resp.connected, expiresAtIso: resp.expiresAtIso || "" };
  }

  async function mdAuthLogin({ clientId, clientSecret, username, password }) {
    const resp = await runtimeSendMessage({
      type: "MD_AUTH_LOGIN_PASSWORD",
      clientId: String(clientId || ""),
      clientSecret: String(clientSecret || ""),
      username: String(username || ""),
      password: String(password || ""),
    });
    if (!resp || resp.ok !== true) throw new Error(resp?.error || "login_failed");
    return resp;
  }

  async function mdAuthLogout() {
    await runtimeSendMessage({ type: "MD_AUTH_LOGOUT" });
  }

  async function mdFollow(mangaId) {
    const resp = await runtimeSendMessage({ type: "MD_FOLLOW", mangaId: String(mangaId || "") });
    if (!resp || resp.ok !== true) throw new Error(resp?.error || "follow_failed");
    return true;
  }

  async function mdSetFollowCancelFlag(v) {
    await setToStorage({ [MD_FOLLOW_CANCEL_KEY]: !!v });
  }

  async function mdIsFollowCancelRequested() {
    try {
      const { data } = await getFromStorage([MD_FOLLOW_CANCEL_KEY]);
      return !!data[MD_FOLLOW_CANCEL_KEY];
    } catch {
      return false;
    }
  }

  function mdCanUseAdvanced() {
    const chk = document.getElementById("mdAcknowledgeRisk");
    return !!chk?.checked;
  }

  function mdReadFollowSettingsFromUi() {
    const sel = document.getElementById("mdFollowThreshold");
    const raw = sel ? String(sel.value || "") : "";
    const threshold = Number(raw);
    const noOpen = !!document.getElementById("mdNoOpenAfterFollow")?.checked;
    const safeThreshold =
      Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : MD_MATCH_MIN_SCORE;
    return { threshold: safeThreshold, noOpenAfterFollow: noOpen };
  }

  async function mdPersistFollowSettingsLocal(settings) {
    try {
      const safe = {
        threshold:
          typeof settings?.threshold === "number" && Number.isFinite(settings.threshold)
            ? settings.threshold
            : MD_MATCH_MIN_SCORE,
        noOpenAfterFollow: !!settings?.noOpenAfterFollow,
      };
      await storageSet(chrome.storage.local, { [MD_FOLLOW_SETTINGS_KEY]: safe });
      return safe;
    } catch {
      return { threshold: MD_MATCH_MIN_SCORE, noOpenAfterFollow: false };
    }
  }

  async function mdLoadFollowSettingsLocal() {
    try {
      const res = await storageGet(chrome.storage.local, [MD_FOLLOW_SETTINGS_KEY]);
      if (res && !res.__error) {
        const st =
          res[MD_FOLLOW_SETTINGS_KEY] && typeof res[MD_FOLLOW_SETTINGS_KEY] === "object"
            ? res[MD_FOLLOW_SETTINGS_KEY]
            : null;
        if (st) {
          const threshold =
            typeof st.threshold === "number" && Number.isFinite(st.threshold) ? st.threshold : MD_MATCH_MIN_SCORE;
          const noOpenAfterFollow = !!st.noOpenAfterFollow;
          return { threshold, noOpenAfterFollow };
        }
      }
    } catch {
      // no-op
    }
    return { threshold: MD_MATCH_MIN_SCORE, noOpenAfterFollow: false };
  }

  function mdReadAuthForm() {
    const clientId = String(document.getElementById("mdClientId")?.value || "");
    const clientSecret = String(document.getElementById("mdClientSecret")?.value || "");
    const username = String(document.getElementById("mdUsername")?.value || "");
    const password = String(document.getElementById("mdPassword")?.value || "");
    return { clientId, clientSecret, username, password };
  }

  async function mdRefreshAuthUi() {
    if (migrateState.targetSite !== "mangadex") {
      setMdFollowUiVisible(false);
      return;
    }
    setMdFollowUiVisible(true);

    if (!mdCanUseAdvanced()) {
      setMdAuthStatusText(t("migMdAuthStatusNeedRisk") || "Check the box to enable");
      setMdButtonsState();
      return;
    }

    const st = await mdAuthStatus();
    if (st.connected) {
      setMdAuthStatusText(t("migMdAuthStatusConnected") || "Status: connected");
    } else {
      setMdAuthStatusText(t("migMdAuthStatusDisconnected") || "Status: disconnected");
    }
    setMdButtonsState();
  }

  async function mdAutoFollowNext() {
    if (!mdCanUseAdvanced()) return;
    if (!Array.isArray(mdMatchResults) || !mdMatchResults.length) return;
    if (mdFollowRunning) return;

    mdFollowRunning = true;
    setError("");
    setMdButtonsState();
    setMdFollowProgressText("-");

    try {
      const settings = mdReadFollowSettingsFromUi();
      await mdPersistFollowSettingsLocal(settings);
      // Find next match starting from mdMatchState.openIndex (so user can interleave).
      if (!mdMatchState) {
        const { state, results } = await getMdMatchStateFromStorage();
        mdMatchState = state;
        mdMatchResults = results || mdMatchResults;
      }

      let start = typeof mdMatchState?.openIndex === "number" ? mdMatchState.openIndex : 0;
      start = Math.max(0, Math.min(mdMatchResults.length, start));

      let target = null;
      for (let i = start; i < mdMatchResults.length; i += 1) {
        const r = mdMatchResults[i];
        if (!r || !r.processed) continue;
        const md = r.md && typeof r.md === "object" ? r.md : null;
        const score = typeof r.score === "number" ? r.score : 0;
        // Guardrail: only auto-follow high-confidence matches
        if (md && md.id && score >= settings.threshold) {
          target = { id: md.id, at: i, title: md.title || r.mpTitle || "" };
          break;
        }
      }
      if (!target) {
        setMdFollowProgressText(t("migMdFollowDone") || "Auto-follow done");
        return;
      }

      await mdFollow(target.id);
      setMdFollowProgressText(t("migMdFollowProgressFmt", ["1", "1"]) || "Followed: 1 / 1");

      // Advance openIndex so next click continues
      await persistMdMatchStateAndResults({ ...(mdMatchState || {}), openIndex: target.at + 1 }, null);
      // Option A behavior: open title page after auto-follow (so user can confirm),
      // unless user enabled "no open after follow".
      if (!settings.noOpenAfterFollow) openUrl(mdTitlePageUrl(target.id));
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      setMdFollowProgressText((t("migMdFollowErrorFmt", [msg]) || `Auto-follow error: ${msg}`).slice(0, 220));
    } finally {
      mdFollowRunning = false;
      setMdButtonsState();
    }
  }

  async function mdAutoFollowAll() {
    if (!mdCanUseAdvanced()) return;
    if (!Array.isArray(mdMatchResults) || !mdMatchResults.length) return;
    if (mdFollowRunning) return;

    mdFollowRunning = true;
    setError("");
    setMdButtonsState();
    setMdFollowProgressText("-");

    try {
      const settings = mdReadFollowSettingsFromUi();
      await mdPersistFollowSettingsLocal(settings);
      await mdSetFollowCancelFlag(false);
      let total = 0;
      let done = 0;

      // Precompute targets
      const targets = [];
      for (let i = 0; i < mdMatchResults.length; i += 1) {
        const r = mdMatchResults[i];
        if (!r || !r.processed) continue;
        const md = r.md && typeof r.md === "object" ? r.md : null;
        const score = typeof r.score === "number" ? r.score : 0;
        if (md && md.id && score >= settings.threshold) targets.push({ id: md.id, at: i });
      }
      total = targets.length;
      if (!total) {
        setMdFollowProgressText(t("migMdFollowDone") || "Auto-follow done");
        return;
      }

      for (const tItem of targets) {
        if (await mdIsFollowCancelRequested()) {
          setMdFollowProgressText(t("migMdAutoMatchPaused") || "Paused");
          return;
        }
        try {
          await mdFollow(tItem.id);
        } catch (e) {
          // Continue but show last error
          const msg = e && e.message ? String(e.message) : String(e);
          setMdFollowProgressText((t("migMdFollowErrorFmt", [msg]) || `Auto-follow error: ${msg}`).slice(0, 220));
        }
        done += 1;
        setMdFollowProgressText(
          t("migMdFollowProgressFmt", [String(done), String(total)]) || `Followed: ${done} / ${total}`
        );
        await new Promise((x) => setTimeout(x, MD_FOLLOW_THROTTLE_MS));
      }

      setMdFollowProgressText(t("migMdFollowDone") || "Auto-follow done");
    } finally {
      mdFollowRunning = false;
      setMdButtonsState();
    }
  }

  async function mdStopAutoFollow() {
    await mdSetFollowCancelFlag(true);
  }

  function setMdButtonsState() {
    const startBtn = document.getElementById("mdMatchStartBtn");
    const pauseBtn = document.getElementById("mdMatchPauseBtn");
    const openNextBtn = document.getElementById("mdOpenNextBtn");
    const exportBtn = document.getElementById("mdExportMappingBtn");
    const followNextBtn = document.getElementById("mdFollowNextBtn");
    const followAllBtn = document.getElementById("mdFollowAllBtn");
    const followStopBtn = document.getElementById("mdFollowStopBtn");
    const loginBtn = document.getElementById("mdLoginBtn");
    const logoutBtn = document.getElementById("mdLogoutBtn");
    const testBtn = document.getElementById("mdTestBtn");

    const st = mdMatchState || { status: "idle", index: 0, total: items.length, matched: 0, openIndex: 0 };
    const hasAny = Array.isArray(mdMatchResults) && mdMatchResults.length > 0;
    const canOpenNext = hasAny;
    const canExport = hasAny;
    const isRunning = mdMatchRunning || st.status === "running";
    const advancedEnabled = mdCanUseAdvanced();

    if (startBtn) {
      const startLabelKey =
        st.status === "paused" ? "migMdMatchResumeBtn" : "migMdMatchStartBtn";
      startBtn.textContent = t(startLabelKey) || (st.status === "paused" ? "Resume" : "Start");
      startBtn.disabled = !items.length || isRunning;
    }
    if (pauseBtn) pauseBtn.disabled = !isRunning;
    if (openNextBtn) openNextBtn.disabled = !canOpenNext;
    if (exportBtn) exportBtn.disabled = !canExport;

    const followDisabled = !advancedEnabled || mdFollowRunning || !hasAny;
    if (followNextBtn) followNextBtn.disabled = followDisabled;
    if (followAllBtn) followAllBtn.disabled = followDisabled;
    if (followStopBtn) followStopBtn.disabled = !mdFollowRunning;

    // Auth buttons require risk ack
    if (loginBtn) loginBtn.disabled = !advancedEnabled;
    if (logoutBtn) logoutBtn.disabled = !advancedEnabled;
    if (testBtn) testBtn.disabled = !advancedEnabled;
  }

  async function getMdMatchStateFromStorage() {
    const { data } = await getFromStorage([MD_MATCH_STATE_KEY, MD_MATCH_RESULTS_KEY]);
    const st = data[MD_MATCH_STATE_KEY] && typeof data[MD_MATCH_STATE_KEY] === "object" ? data[MD_MATCH_STATE_KEY] : null;
    const res = data[MD_MATCH_RESULTS_KEY];
    const safeSt = {
      status: typeof st?.status === "string" ? st.status : "idle",
      index: typeof st?.index === "number" ? st.index : 0,
      total: typeof st?.total === "number" ? st.total : 0,
      matched: typeof st?.matched === "number" ? st.matched : 0,
      openIndex: typeof st?.openIndex === "number" ? st.openIndex : 0,
      updated_at: typeof st?.updated_at === "string" ? st.updated_at : "",
      error: typeof st?.error === "string" ? st.error : "",
    };
    const safeRes = Array.isArray(res) ? res : null;
    return { state: safeSt, results: safeRes };
  }

  async function persistMdMatchStateAndResults(state, results) {
    const st = { ...(state || {}) };
    st.updated_at = new Date().toISOString();
    await setToStorage({
      [MD_MATCH_STATE_KEY]: st,
      ...(results ? { [MD_MATCH_RESULTS_KEY]: results } : {}),
    });
    mdMatchState = st;
    if (results) mdMatchResults = results;
  }

  async function setMdCancelFlag(v) {
    await setToStorage({ [MD_MATCH_CANCEL_KEY]: !!v });
  }

  async function isMdCancelRequested() {
    try {
      const { data } = await getFromStorage([MD_MATCH_CANCEL_KEY]);
      return !!data[MD_MATCH_CANCEL_KEY];
    } catch {
      return false;
    }
  }

  function pickBestMdTitle(attributes) {
    const tObj = attributes && attributes.title && typeof attributes.title === "object" ? attributes.title : {};
    const candidates = [];
    if (typeof tObj.en === "string") candidates.push(tObj.en);
    // pick any other language title as fallback
    for (const v of Object.values(tObj)) {
      if (typeof v === "string") candidates.push(v);
    }
    return candidates.find(Boolean) || "";
  }

  function extractAltTitles(attributes) {
    const alt = attributes && Array.isArray(attributes.altTitles) ? attributes.altTitles : [];
    const out = [];
    for (const obj of alt) {
      if (!obj || typeof obj !== "object") continue;
      for (const v of Object.values(obj)) {
        if (typeof v === "string" && v.trim()) out.push(v.trim());
      }
    }
    return out;
  }

  function scoreMdCandidate(mpTitle, mdTitle, mdAltTitles) {
    const base = U?.diceCoefficient ? U.diceCoefficient(mpTitle, mdTitle) : 0;
    let best = base;
    const alts = Array.isArray(mdAltTitles) ? mdAltTitles : [];
    for (const a of alts) {
      const s = U?.diceCoefficient ? U.diceCoefficient(mpTitle, a) : 0;
      if (s > best) best = s;
    }
    return best;
  }

  async function mdFetchJson(url) {
    // No auth headers in public mode. Per MangaDex guidance, only send Authorization to {api, auth}.mangadex.org when needed.
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const retryAfter = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null, json };
  }

  async function mdSearchMangaByTitle(title) {
    const q = String(title || "").trim();
    if (!q) return [];

    const params = new URLSearchParams();
    params.set("title", q);
    params.set("limit", "5");
    params.set("order[relevance]", "desc");
    // include all ratings so users with mixed libraries don't miss results
    for (const r of ["safe", "suggestive", "erotica", "pornographic"]) params.append("contentRating[]", r);

    const url = `${MD_API_BASE}/manga?${params.toString()}`;
    // Basic backoff on 429
    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      const r = await mdFetchJson(url);
      if (r.ok && r.json && Array.isArray(r.json.data)) return r.json.data;
      if (r.status === 429) {
        const waitMs = (r.retryAfterSeconds != null ? r.retryAfterSeconds * 1000 : 3000);
        await new Promise((x) => setTimeout(x, Math.min(15000, Math.max(1000, waitMs))));
        continue;
      }
      // On other errors, bail out; caller handles pause.
      throw new Error(`MD_HTTP_${r.status || "ERR"}`);
    }
    throw new Error("MD_HTTP_429");
  }

  async function mdRunAutoMatch() {
    if (mdMatchRunning) return;
    if (!items.length) return;
    if (migrateState.targetSite !== "mangadex") return;

    mdMatchRunning = true;
    setError("");
    setMdButtonsState();

    try {
      await setMdCancelFlag(false);

      // Load existing
      if (!mdMatchState || !Array.isArray(mdMatchResults)) {
        const { state, results } = await getMdMatchStateFromStorage();
        mdMatchState = state;
        mdMatchResults = results || [];
      }

      // Ensure array length matches items length
      if (!Array.isArray(mdMatchResults)) mdMatchResults = [];
      if (mdMatchResults.length < items.length) {
        mdMatchResults.length = items.length;
      }

      const st = mdMatchState || { status: "idle", index: 0, total: items.length, matched: 0, openIndex: 0 };
      const startIndex = st.status === "paused" || st.status === "running" ? Math.max(0, st.index) : 0;
      let matched = typeof st.matched === "number" ? st.matched : 0;

      await persistMdMatchStateAndResults(
        { ...st, status: "running", total: items.length, index: startIndex, matched, openIndex: st.openIndex || 0, error: "" },
        null
      );

      for (let i = startIndex; i < items.length; i += 1) {
        if (await isMdCancelRequested()) {
          await persistMdMatchStateAndResults({ ...mdMatchState, status: "paused", index: i }, mdMatchResults);
          setMdMatchProgressText(t("migMdAutoMatchPaused") || "Paused");
          return;
        }

        const it = items[i] || {};
        const mpTitle = String(it.title || "").trim();
        if (!mpTitle) {
          mdMatchResults[i] = { mpTitle: "", md: null, score: 0, candidates: [] };
          continue;
        }

        // Skip already processed entries
        if (mdMatchResults[i] && typeof mdMatchResults[i] === "object" && mdMatchResults[i].processed) {
          continue;
        }

        const data = await mdSearchMangaByTitle(mpTitle);
        const candidates = [];
        let best = null;
        let bestScore = 0;

        for (const row of data || []) {
          const id = row && typeof row.id === "string" ? row.id : "";
          const attr = row && row.attributes ? row.attributes : null;
          if (!id || !attr) continue;
          const mdTitle = pickBestMdTitle(attr);
          const alt = extractAltTitles(attr);
          const score = scoreMdCandidate(mpTitle, mdTitle, alt);
          const cand = { id, title: mdTitle, score: Math.round(score * 1000) / 1000 };
          candidates.push(cand);
          if (score > bestScore) {
            bestScore = score;
            best = cand;
          }
        }

        if (best && bestScore >= MD_MATCH_MIN_SCORE) matched += 1;

        mdMatchResults[i] = {
          processed: true,
          mpTitle,
          mpUrl: String(it.mangapark_url || ""),
          md: best ? { id: best.id, title: best.title } : null,
          score: Math.round(bestScore * 1000) / 1000,
          candidates: candidates.slice(0, 5),
        };

        // Persist periodically
        if (i % 10 === 0 || i === items.length - 1) {
          await persistMdMatchStateAndResults({ ...mdMatchState, status: "running", index: i, matched }, mdMatchResults);
        } else {
          // cheap state update (no write)
          mdMatchState = { ...(mdMatchState || {}), status: "running", index: i, matched };
        }

        const pct = Math.round(((i + 1) / items.length) * 100);
        setMdMatchProgressText(
          t("migMdAutoMatchProgressFmt", [String(i + 1), String(items.length), String(pct), String(matched)]) ||
            `${i + 1}/${items.length} — ${pct}% — matched: ${matched}`
        );
        setMdButtonsState();

        await new Promise((x) => setTimeout(x, MD_THROTTLE_MS));
      }

      await persistMdMatchStateAndResults({ ...(mdMatchState || {}), status: "done", index: items.length, matched }, mdMatchResults);
      setMdMatchProgressText(t("migMdAutoMatchDone") || "Done");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      await persistMdMatchStateAndResults({ ...(mdMatchState || {}), status: "paused", error: msg }, mdMatchResults);
      setMdMatchProgressText((t("migMdAutoMatchErrorFmt", [msg]) || `Error: ${msg}`).slice(0, 200));
    } finally {
      mdMatchRunning = false;
      setMdButtonsState();
    }
  }

  async function mdPauseAutoMatch() {
    await setMdCancelFlag(true);
  }

  function mdTitlePageUrl(id) {
    return id ? `${MD_SITE_BASE}/title/${id}` : "";
  }

  async function mdOpenNextMatch() {
    setError("");
    if (!Array.isArray(mdMatchResults) || !mdMatchResults.length) return;

    // Load state if needed
    if (!mdMatchState) {
      const { state, results } = await getMdMatchStateFromStorage();
      mdMatchState = state;
      mdMatchResults = results || mdMatchResults;
    }

    let idx = typeof mdMatchState.openIndex === "number" ? mdMatchState.openIndex : 0;
    idx = Math.max(0, Math.min(mdMatchResults.length, idx));

    // Find next processed entry with a decent match; fallback to search if none.
    let target = null;
    for (let i = idx; i < mdMatchResults.length; i += 1) {
      const r = mdMatchResults[i];
      if (!r || !r.processed) continue;
      const md = r.md && typeof r.md === "object" ? r.md : null;
      const score = typeof r.score === "number" ? r.score : 0;
      if (md && md.id && score >= MD_MATCH_MIN_SCORE) {
        target = { type: "title", url: mdTitlePageUrl(md.id), at: i };
        break;
      }
    }

    if (!target) {
      // fallback: open search for current migrate item
      const current = items[migrateState.index] || {};
      const url = buildSearchUrl("mangadex", current.title);
      openUrl(url);
      return;
    }

    openUrl(target.url);
    const nextOpen = target.at + 1;
    await persistMdMatchStateAndResults({ ...(mdMatchState || {}), openIndex: nextOpen }, null);
    setMdButtonsState();
  }

  function mdExportMapping() {
    if (!Array.isArray(mdMatchResults) || !mdMatchResults.length) return;
    const captured = exportPayload?.meta?.captured_at || new Date().toISOString();
    const file = `mangadex_mapping_${captured.replace(/[:.]/g, "-")}.json`;
    const payload = {
      meta: {
        created_at: new Date().toISOString(),
        source: "mangapark-image-fix-extension",
        total: items.length,
        matched_threshold: MD_MATCH_MIN_SCORE,
      },
      results: mdMatchResults,
    };
    downloadBlob(file, "application/json;charset=utf-8", JSON.stringify(payload, null, 2));
  }

  function csvEscape(value) {
    return U?.csvEscape ? U.csvEscape(value) : String(value ?? "");
  }

  function exportAsJson() {
    if (!exportPayload) return;
    const captured = exportPayload?.meta?.captured_at || new Date().toISOString();
    const file = `migration_items_${captured.replace(/[:.]/g, "-")}.json`;
    const json = U?.makeJson ? U.makeJson(exportPayload) : JSON.stringify(exportPayload, null, 2);
    downloadBlob(file, "application/json;charset=utf-8", json);
  }

  function exportAsCsv() {
    const arr = Array.isArray(exportPayload?.items) ? exportPayload.items : [];
    if (!arr.length) return;
    const captured = exportPayload?.meta?.captured_at || new Date().toISOString();
    const file = `migration_items_${captured.replace(/[:.]/g, "-")}.csv`;
    const csv = U?.makeCsv ? U.makeCsv(arr) : "";
    downloadBlob(file, "text/csv;charset=utf-8", csv);
  }

  async function persistMigrateState() {
    await setToStorage({ [MIGRATE_STATE_KEY]: migrateState });
  }

  async function persistItems() {
    if (!exportPayload) return;
    exportPayload.items = items;
    exportPayload.meta = exportPayload.meta || {};
    exportPayload.meta.updated_at = new Date().toISOString();
    exportPayload.meta.total_items = items.length;
    await setToStorage({ [EXPORT_DATA_KEY]: exportPayload });
  }

  function render() {
    const empty = $("empty");
    const panel = $("panel");

    const storedCount = $("storedCount");
    if (storedCount) storedCount.textContent = String(items.length);

    if (!items.length) {
      if (empty) empty.style.display = "block";
      if (panel) panel.style.display = "none";
      setMdUiVisible(false);
      const idx = $("indexLabel");
      if (idx) idx.textContent = "0/0";
      return;
    }

    if (empty) empty.style.display = "none";
    if (panel) panel.style.display = "block";

    migrateState.index = clampIndex(migrateState.index);

    const current = items[migrateState.index] || {};
    const titleEl = $("title");
    if (titleEl) titleEl.textContent = current.title || "-";

    const sourceLink = $("sourceLink");
    if (sourceLink) {
      const url = String(current.mangapark_url || "");
      sourceLink.textContent = url || "-";
      if (url) {
        sourceLink.setAttribute("href", url);
        sourceLink.removeAttribute("aria-disabled");
        sourceLink.tabIndex = 0;
      } else {
        sourceLink.removeAttribute("href");
        sourceLink.setAttribute("aria-disabled", "true");
        sourceLink.tabIndex = -1;
      }
    }

    const lastRead = $("lastRead");
    if (lastRead) lastRead.textContent = current.last_read_serial || "-";

    const captured = $("capturedAt");
    if (captured) captured.textContent = current.captured_at || "-";

    const idx = $("indexLabel");
    if (idx) idx.textContent = `${migrateState.index + 1}/${items.length}`;

    // Make-style counter + stats (best-effort)
    try {
      const cur = document.getElementById("currentIndexNum");
      const total = document.getElementById("totalIndexNum");
      const remaining = document.getElementById("remainingStat");
      const progress = document.getElementById("progressStat");
      const totalStat = document.getElementById("totalStat");

      const currentNum = items.length ? migrateState.index + 1 : 0;
      const totalNum = items.length ? items.length : 0;
      const remainingNum = totalNum ? Math.max(0, totalNum - currentNum) : 0;
      const progressPct = totalNum ? Math.round((currentNum / totalNum) * 100) : 0;

      if (cur) cur.textContent = String(currentNum);
      if (total) total.textContent = String(totalNum);
      if (remaining) remaining.textContent = String(remainingNum);
      if (progress) progress.textContent = `${progressPct}%`;
      if (totalStat) totalStat.textContent = String(totalNum);
    } catch {
      // no-op
    }

    // Make-style search CTA label (localized)
    try {
      const btn = $("searchBtn");
      const siteName = document.getElementById("searchSiteName");
      const map = {
        mangadex: "MangaDex",
        anilist: "AniList",
        mal: "MyAnimeList",
        mangaupdates: "MangaUpdates",
      };
      const label = map[migrateState.targetSite] || "MangaDex";
      if (btn) {
        btn.textContent =
          t("migSearchBtnFmt", [label]) || `Search on ${label} \u2192`;
      }
      if (siteName) siteName.textContent = label;
    } catch {
      // no-op
    }

    // buttons
    const prev = $("prevBtn");
    const next = $("nextBtn");
    const remove = $("removeBtn");
    const search = $("searchBtn");
    const copy = $("copyBtn");
    const clearAll = $("clearAllBtn");
    const expCsv = $("exportCsvBtn");
    const expJson = $("exportJsonBtn");

    if (prev) prev.disabled = migrateState.index <= 0;
    if (next) next.disabled = migrateState.index >= items.length - 1;
    if (remove) remove.disabled = !items.length;
    if (search) search.disabled = !items.length;
    if (copy) copy.disabled = !items.length;
    if (clearAll) clearAll.disabled = !items.length;
    if (expCsv) expCsv.disabled = !items.length;
    if (expJson) expJson.disabled = !items.length;

    renderQueue();

    // Auto-match panel: MangaDex only
    setMdUiVisible(migrateState.targetSite === "mangadex");
    setMdFollowUiVisible(migrateState.targetSite === "mangadex");
    setMdButtonsState();
  }

  function renderQueue() {
    const list = $("queueList");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) return;

    // Show up to 50 items around current when possible
    const total = items.length;
    const center = clampIndex(migrateState.index);
    const windowSize = 50;
    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, center - half);
    let end = Math.min(total, start + windowSize);
    start = Math.max(0, end - windowSize);

    for (let i = start; i < end; i += 1) {
      const it = items[i] || {};
      const div = document.createElement("div");
      div.className = "queueItem" + (i === center ? " active" : "");
      div.textContent = it.title || "-";
      div.addEventListener("click", async () => {
        migrateState.index = clampIndex(i);
        await persistMigrateState();
        render();
      });
      list.appendChild(div);
    }

    // Update Make-style queue range labels (best-effort)
    try {
      const range = document.getElementById("queueRange");
      const total = document.getElementById("queueTotal");
      if (range) range.textContent = `${start + 1}\u2013${end}`;
      if (total) total.textContent = String(items.length);
    } catch {
      // no-op
    }
  }

  async function load() {
    setError("");

    const keys = [EXPORT_DATA_KEY, EXPORT_PARTIAL_KEY, MIGRATE_STATE_KEY, "uiLanguage", "theme"];
    const { data, area } = await getFromStorage(keys);

    exportPayload = data[EXPORT_DATA_KEY] || data[EXPORT_PARTIAL_KEY] || null;
    // Robust fallback: if preferred storage is readable but empty, try the other area.
    if (!exportPayload) {
      try {
        const otherArea = area === "local" ? chrome.storage.sync : chrome.storage.local;
        const otherRes = await storageGet(otherArea, [EXPORT_DATA_KEY, EXPORT_PARTIAL_KEY]);
        if (otherRes && !otherRes.__error) {
          exportPayload = otherRes[EXPORT_DATA_KEY] || otherRes[EXPORT_PARTIAL_KEY] || null;
        }
      } catch {
        // no-op
      }
    }

    const uiLanguage = typeof data.uiLanguage === "string" ? data.uiLanguage : DEFAULT_CONFIG.uiLanguage;
    const theme = typeof data.theme === "string" ? data.theme : DEFAULT_CONFIG.theme;
    applyTheme(theme);
    i18nDict = await loadLocaleDict(uiLanguage);
    applyI18nToDom();

    items = Array.isArray(exportPayload?.items) ? exportPayload.items.slice() : [];

    const st = data[MIGRATE_STATE_KEY] && typeof data[MIGRATE_STATE_KEY] === "object" ? data[MIGRATE_STATE_KEY] : {};
    migrateState = {
      index: typeof st.index === "number" ? st.index : DEFAULT_MIGRATE_STATE.index,
      targetSite: typeof st.targetSite === "string" ? st.targetSite : DEFAULT_MIGRATE_STATE.targetSite,
      openNewTab: typeof st.openNewTab === "boolean" ? st.openNewTab : DEFAULT_MIGRATE_STATE.openNewTab,
    };
    migrateState.index = clampIndex(migrateState.index);

    // Load MangaDex match state (best-effort)
    try {
      const { state, results } = await getMdMatchStateFromStorage();
      mdMatchState = state;
      mdMatchResults = results;
      const st2 = mdMatchState || { status: "idle", index: 0, total: items.length, matched: 0, openIndex: 0 };
      if (migrateState.targetSite === "mangadex") {
        const done = st2.status === "done";
        const pct = st2.total ? Math.round(((Math.min(st2.index, st2.total)) / st2.total) * 100) : 0;
        setMdMatchProgressText(
          done
            ? (t("migMdAutoMatchDone") || "Done")
            : (t("migMdAutoMatchProgressFmt", [String(st2.index || 0), String(items.length), String(pct), String(st2.matched || 0)]) ||
                `${st2.index || 0}/${items.length} — ${pct}% — matched: ${st2.matched || 0}`)
        );
      }
    } catch {
      // no-op
    }

    // Pre-fill MangaDex auth settings (clientId/secret/username) from local storage (best-effort).
    try {
      const local = await storageGet(chrome.storage.local, [MD_AUTH_SETTINGS_KEY]);
      if (local && !local.__error) {
        const st = local[MD_AUTH_SETTINGS_KEY] && typeof local[MD_AUTH_SETTINGS_KEY] === "object" ? local[MD_AUTH_SETTINGS_KEY] : null;
        if (st) {
          const cid = typeof st.clientId === "string" ? st.clientId : "";
          const cs = typeof st.clientSecret === "string" ? st.clientSecret : "";
          const un = typeof st.username === "string" ? st.username : "";
          const elCid = document.getElementById("mdClientId");
          const elCs = document.getElementById("mdClientSecret");
          const elUn = document.getElementById("mdUsername");
          if (elCid && !elCid.value) elCid.value = cid;
          if (elCs && !elCs.value) elCs.value = cs;
          if (elUn && !elUn.value) elUn.value = un;
        }
      }
    } catch {
      // no-op
    }

    // Pre-fill follow settings (threshold + noOpenAfterFollow)
    try {
      const st = await mdLoadFollowSettingsLocal();
      const sel = document.getElementById("mdFollowThreshold");
      const chkNoOpen = document.getElementById("mdNoOpenAfterFollow");
      if (sel && !sel.value) sel.value = String(st.threshold);
      if (sel && sel.value !== String(st.threshold)) {
        // Ensure value is one of the options; fallback to recommended.
        const allowed = new Set(["0.65", "0.72", "0.8", "0.80"]);
        if (!allowed.has(sel.value)) sel.value = "0.72";
      }
      if (chkNoOpen) chkNoOpen.checked = !!st.noOpenAfterFollow;
    } catch {
      // no-op
    }

    // initialize controls
    const sel = $("targetSite");
    if (sel) sel.value = migrateState.targetSite;
    const chk = $("openNewTab");
    if (chk) chk.checked = !!migrateState.openNewTab;

    render();
    // Refresh auth status label (best-effort; doesn’t block UI)
    mdRefreshAuthUi().catch(() => {});
  }

  async function init() {
    await load();

    // Close window (Make close X)
    document.getElementById("closeBtn")?.addEventListener("click", () => {
      try {
        window.close();
      } catch {
        // no-op
      }
    });

    // Empty state button: "Go to Extension Popup" -> close tab
    document.getElementById("goToPopupBtn")?.addEventListener("click", () => {
      try {
        window.close();
      } catch {
        // no-op
      }
    });

    // Theme toggle (Figma Make parity)
    $("themeToggleBtn")?.addEventListener("click", async () => {
      const { data } = await getFromStorage(["theme"]);
      const current = typeof data.theme === "string" ? data.theme : DEFAULT_CONFIG.theme;
      const next = String(current || "dark").toLowerCase() === "dark" ? "light" : "dark";
      await setToStorage({ theme: next });
      applyTheme(next);
    });

    // Close queue button inside sidebar
    document.getElementById("closeQueueBtn")?.addEventListener("click", () => {
      const q = $("queuePanel");
      if (q) q.style.display = "none";
    });

    // Queue toggle
    $("toggleQueueBtn")?.addEventListener("click", () => {
      const q = $("queuePanel");
      if (!q) return;
      const isOpen = q.style.display !== "none";
      q.style.display = isOpen ? "none" : "block";
      if (!isOpen) renderQueue();
    });

    $("targetSite")?.addEventListener("change", async (e) => {
      migrateState.targetSite = String(e.target.value || "mangadex");
      await persistMigrateState();
      // Refresh auto-match panel visibility + labels
      render();
    });

    $("openNewTab")?.addEventListener("change", async (e) => {
      migrateState.openNewTab = !!e.target.checked;
      await persistMigrateState();
    });

    $("searchBtn")?.addEventListener("click", async () => {
      setError("");
      const current = items[migrateState.index] || {};
      const url = buildSearchUrl(migrateState.targetSite, current.title);
      openUrl(url);
    });

    $("copyBtn")?.addEventListener("click", async () => {
      setError("");
      const current = items[migrateState.index] || {};
      const text = normalizeTitle(current.title);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        } catch {
          // no-op
        }
      }
    });

    $("nextBtn")?.addEventListener("click", async () => {
      migrateState.index = clampIndex(migrateState.index + 1);
      await persistMigrateState();
      render();
    });

    $("prevBtn")?.addEventListener("click", async () => {
      migrateState.index = clampIndex(migrateState.index - 1);
      await persistMigrateState();
      render();
    });

    $("removeBtn")?.addEventListener("click", async () => {
      setError("");
      if (!items.length) return;
      items.splice(migrateState.index, 1);
      migrateState.index = clampIndex(migrateState.index);
      await persistMigrateState();
      await persistItems();
      render();
    });

    $("clearAllBtn")?.addEventListener("click", async () => {
      setError("");
      items = [];
      migrateState.index = 0;
      await persistMigrateState();
      await persistItems();
      render();
    });

    $("exportCsvBtn")?.addEventListener("click", async () => {
      exportAsCsv();
    });

    $("exportJsonBtn")?.addEventListener("click", async () => {
      exportAsJson();
    });

    // MangaDex auto-match controls (safe: no auth, no writes to MangaDex)
    document.getElementById("mdMatchStartBtn")?.addEventListener("click", async () => {
      await mdRunAutoMatch();
    });
    document.getElementById("mdMatchPauseBtn")?.addEventListener("click", async () => {
      await mdPauseAutoMatch();
    });
    document.getElementById("mdOpenNextBtn")?.addEventListener("click", async () => {
      await mdOpenNextMatch();
    });
    document.getElementById("mdExportMappingBtn")?.addEventListener("click", () => {
      mdExportMapping();
    });

    // Advanced: MangaDex auto-follow via API (opt-in)
    document.getElementById("mdAcknowledgeRisk")?.addEventListener("change", async () => {
      await mdRefreshAuthUi();
    });

    document.getElementById("mdFollowThreshold")?.addEventListener("change", async () => {
      const st = mdReadFollowSettingsFromUi();
      await mdPersistFollowSettingsLocal(st);
      setMdButtonsState();
    });
    document.getElementById("mdNoOpenAfterFollow")?.addEventListener("change", async () => {
      const st = mdReadFollowSettingsFromUi();
      await mdPersistFollowSettingsLocal(st);
      setMdButtonsState();
    });

    document.getElementById("mdLoginBtn")?.addEventListener("click", async () => {
      setError("");
      if (!mdCanUseAdvanced()) return;
      const f = mdReadAuthForm();
      try {
        await mdSaveAuthSettingsLocal({ clientId: f.clientId, clientSecret: f.clientSecret, username: f.username });
        await mdAuthLogin(f);
        await mdRefreshAuthUi();
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        setMdAuthStatusText((t("migMdFollowErrorFmt", [msg]) || msg).slice(0, 180));
      }
    });

    document.getElementById("mdLogoutBtn")?.addEventListener("click", async () => {
      setError("");
      if (!mdCanUseAdvanced()) return;
      await mdAuthLogout();
      await mdRefreshAuthUi();
    });

    document.getElementById("mdTestBtn")?.addEventListener("click", async () => {
      setError("");
      if (!mdCanUseAdvanced()) return;
      const st = await mdAuthStatus();
      setMdAuthStatusText(
        st.connected ? (t("migMdAuthStatusConnected") || "Status: connected") : (t("migMdAuthStatusDisconnected") || "Status: disconnected")
      );
    });

    document.getElementById("mdFollowNextBtn")?.addEventListener("click", async () => {
      await mdAutoFollowNext();
    });
    document.getElementById("mdFollowAllBtn")?.addEventListener("click", async () => {
      await mdAutoFollowAll();
    });
    document.getElementById("mdFollowStopBtn")?.addEventListener("click", async () => {
      await mdStopAutoFollow();
    });

    // Live updates if export list changes elsewhere
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync" && area !== "local") return;
        if (changes && changes[EXPORT_DATA_KEY]) {
          exportPayload = changes[EXPORT_DATA_KEY].newValue || null;
          items = Array.isArray(exportPayload?.items) ? exportPayload.items.slice() : [];
          migrateState.index = clampIndex(migrateState.index);
          render();
        }
      });
    } catch {
      // no-op
    }

    // Keyboard shortcuts
    document.addEventListener("keydown", async (e) => {
      // Ignore when user is selecting text in a control
      const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (e.key === "Enter") {
        e.preventDefault();
        $("searchBtn")?.click();
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        $("nextBtn")?.click();
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        $("prevBtn")?.click();
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        $("copyBtn")?.click();
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        $("removeBtn")?.click();
      } else if (e.key === "Escape") {
        const q = $("queuePanel");
        if (q && q.style.display !== "none") {
          e.preventDefault();
          q.style.display = "none";
        }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => setError(String(e)));
  });
})();

