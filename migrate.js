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

    // initialize controls
    const sel = $("targetSite");
    if (sel) sel.value = migrateState.targetSite;
    const chk = $("openNewTab");
    if (chk) chk.checked = !!migrateState.openNewTab;

    render();
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

