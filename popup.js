/* global chrome */

/**
 * popup.js (publishable)
 * - Toggle auto-fix enabled/debug (persisté storage.sync, fallback local)
 * - Allowed sites add/remove/reset
 * - Bouton "Fix this page now" : injecte injected_patch.js via chrome.scripting.executeScript
 *   (action utilisateur => activeTab) et lance le patch en mode force (ignore whitelist).
 *
 * Permissions:
 * - storage (settings)
 * - activeTab + scripting ("Fix this page now")
 *
 * Pas de permission "tabs". On évite tab.url.
 */

const DEFAULT_WHITELIST = [
  "mangapark.*",
  "comicpark.*",
  "readpark.*",
  "parkmanga.*",
  "mpark.*",
];

const DEFAULT_CONFIG = {
  enabled: true,
  debug: false,
  whitelist: DEFAULT_WHITELIST,
  // UI language: "auto" uses chrome.i18n. Otherwise: "en" or "fr" (extensible).
  uiLanguage: "auto",
  // Theme for popup + internal pages: "dark" | "light"
  theme: "dark",
};

const PATCHER_NS = "__MP_IMAGE_FIX__";
const LOCALES_BASE_PATH = "_locales";
// If sync storage is readable but not writable (quota / policy / transient), we persist a mode marker locally.
// This ensures toggles (like debug) keep working and the UI reflects the last user choice on THIS device.
const CONFIG_STORAGE_MODE_KEY = "mp_config_storage_mode"; // "sync" | "local"
const EXPORT_STATE_KEY = "mp_export_state";
const EXPORT_DATA_KEY = "mp_export_follows";
const EXPORT_PARTIAL_KEY = "mp_export_partial";
const EXPORT_CANCEL_KEY = "mp_export_cancel";
const EXPORT_ORIGIN_KEY = "mp_export_origin";
const EXPORT_DIAGNOSTIC_KEY = "mp_export_diagnostic";
const MIGRATE_STATE_KEY = "mp_migrate_state";

const DEFAULT_MIGRATE_STATE = {
  index: 0,
  targetSite: "mangadex",
  openNewTab: true,
};

// Footer/support links: real links only (no dead/placeholder links allowed for CWS submission).

const MIGRATION_SITES = [
  { id: "mangadex", labelKey: "migSite_mangadex" },
  { id: "anilist", labelKey: "migSite_anilist" },
  { id: "mal", labelKey: "migSite_mal" },
  { id: "mangaupdates", labelKey: "migSite_mangaupdates" },
];

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

function getFromStorage(keys) {
  // Prefer sync by default, but if sync is readable and not writable in this environment,
  // we may have switched to local mode (stored in chrome.storage.local).
  return (async () => {
    const modeRes = await storageGet(chrome.storage.local, [CONFIG_STORAGE_MODE_KEY]);
    const mode =
      modeRes && !modeRes.__error && typeof modeRes[CONFIG_STORAGE_MODE_KEY] === "string"
        ? String(modeRes[CONFIG_STORAGE_MODE_KEY] || "")
        : "";

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
  })();
}

async function setToStorage(items) {
  const modeRes = await storageGet(chrome.storage.local, [CONFIG_STORAGE_MODE_KEY]);
  const mode =
    modeRes && !modeRes.__error && typeof modeRes[CONFIG_STORAGE_MODE_KEY] === "string"
      ? String(modeRes[CONFIG_STORAGE_MODE_KEY] || "")
      : "";

  // If we are in local mode, write local first (and best-effort sync second).
  if (mode === "local") {
    const rLocal = await storageSet(chrome.storage.local, items);
    if (rLocal.ok) {
      await storageSet(chrome.storage.local, { [CONFIG_STORAGE_MODE_KEY]: "local" });
      // Best-effort: keep sync updated when possible
      await storageSet(chrome.storage.sync, items);
      return true;
    }
    const rSync = await storageSet(chrome.storage.sync, items);
    if (rSync.ok) {
      await storageSet(chrome.storage.local, { [CONFIG_STORAGE_MODE_KEY]: "sync" });
      return true;
    }
    return false;
  }

  // Default: sync first, fallback local. If sync fails but local succeeds, switch to local mode.
  const rSync = await storageSet(chrome.storage.sync, items);
  if (rSync.ok) {
    await storageSet(chrome.storage.local, { [CONFIG_STORAGE_MODE_KEY]: "sync" });
    return true;
  }
  const rLocal = await storageSet(chrome.storage.local, items);
  if (rLocal.ok) {
    await storageSet(chrome.storage.local, { [CONFIG_STORAGE_MODE_KEY]: "local" });
    return true;
  }
  return false;
}

async function getConfig() {
  const keys = ["enabled", "debug", "whitelist", "uiLanguage", "theme"];
  // Mode marker is stored locally only.
  const modeRes = await storageGet(chrome.storage.local, [CONFIG_STORAGE_MODE_KEY]);
  const mode =
    modeRes && !modeRes.__error && typeof modeRes[CONFIG_STORAGE_MODE_KEY] === "string"
      ? String(modeRes[CONFIG_STORAGE_MODE_KEY] || "")
      : "";

  // If we previously failed to write to sync, prefer local for consistency.
  if (mode === "local") {
    const localRes = await storageGet(chrome.storage.local, keys);
    if (!localRes.__error) return applyDefaults(localRes);

    const syncRes = await storageGet(chrome.storage.sync, keys);
    if (!syncRes.__error) return applyDefaults(syncRes);
    return applyDefaults({});
  }

  // Default: prefer sync, fallback local.
  const syncRes = await storageGet(chrome.storage.sync, keys);
  if (!syncRes.__error) return applyDefaults(syncRes);

  const localRes = await storageGet(chrome.storage.local, keys);
  return applyDefaults(localRes.__error ? {} : localRes);
}

function applyDefaults(partial) {
  const cfg = {
    enabled:
      typeof partial.enabled === "boolean" ? partial.enabled : DEFAULT_CONFIG.enabled,
    debug: typeof partial.debug === "boolean" ? partial.debug : DEFAULT_CONFIG.debug,
    whitelist: Array.isArray(partial.whitelist) ? partial.whitelist : DEFAULT_CONFIG.whitelist,
    uiLanguage:
      typeof partial.uiLanguage === "string" ? partial.uiLanguage : DEFAULT_CONFIG.uiLanguage,
    theme: typeof partial.theme === "string" ? partial.theme : DEFAULT_CONFIG.theme,
  };
  cfg.whitelist = uniq(
    cfg.whitelist
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean)
  );
  cfg.uiLanguage = String(cfg.uiLanguage || "auto").toLowerCase();
  if (!["auto", "en", "fr"].includes(cfg.uiLanguage)) cfg.uiLanguage = "auto";

  cfg.theme = String(cfg.theme || "dark").toLowerCase();
  if (!["dark", "light"].includes(cfg.theme)) cfg.theme = "dark";

  return cfg;
}

async function setConfig(patch) {
  const res = await storageSet(chrome.storage.sync, patch);
  if (res.ok) {
    // Best-effort: mark sync as active mode.
    await storageSet(chrome.storage.local, { [CONFIG_STORAGE_MODE_KEY]: "sync" });
    return true;
  }

  const res2 = await storageSet(chrome.storage.local, patch);
  if (res2.ok) {
    // Sync is readable but not writable in some environments; prefer local from now on.
    await storageSet(chrome.storage.local, { [CONFIG_STORAGE_MODE_KEY]: "local" });
    return true;
  }
  return false;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

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

function updateThemeToggleUi(cfg) {
  const isDark = (cfg.theme || "dark") === "dark";
  const ids = ["themeToggleBtn", "themeToggleBtn_running", "themeToggleBtn_done", "themeToggleBtn_error"];
  for (const id of ids) {
    const btn = $(id);
    if (!btn) continue;
    btn.setAttribute("aria-pressed", isDark ? "true" : "false");
    // Keep the button inner HTML (SVG icons). i18n is handled via data-i18n-* attributes.
  }
}

function updateStepsUi(exportStatus) {
  const s = String(exportStatus || "idle");
  const d1 = $("stepDot1");
  const d2 = $("stepDot2");
  const d3 = $("stepDot3");
  if (!d1 || !d2 || !d3) return;

  for (const el of [d1, d2, d3]) el.classList.remove("active", "done");

  // 1 = Fix, 2 = Export, 3 = Migration (Migration panel is a separate page)
  if (s === "running" || s === "done" || s === "error" || s === "paused") {
    d1.classList.add("done");
    d2.classList.add("active");
  } else {
    d1.classList.add("active");
  }
}

function setActiveScreen(screenId) {
  const ids = ["screenHome", "screenExportRunning", "screenExportDone", "screenExportError"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (id === screenId) el.classList.add("active");
    else el.classList.remove("active");
  }
}

function mapExportStateToScreen(status) {
  const s = String(status || "idle");
  if (s === "running") return "screenExportRunning";
  if (s === "done") return "screenExportDone";
  if (s === "paused") return "screenExportError";
  if (s === "error") return "screenExportError";
  return "screenHome";
}

function isValidWhitelistEntry(raw) {
  if (!raw) return false;
  const s = raw.trim().toLowerCase();
  if (!s) return false;

  // Validation basique : pas de schéma/espaces/slash/ports/query/fragment
  if (s.includes("://")) return false;
  if (/\s/.test(s)) return false;
  if (/[\/\\?#@:%]/.test(s)) return false;
  if (!/^[a-z0-9.*-]+$/.test(s)) return false;
  if (s.startsWith(".") || s.endsWith(".")) return false;
  if (s.includes("..")) return false;

  const starCount = (s.match(/\*/g) || []).length;
  if (starCount === 0) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s);
  }
  // Wildcard simple : uniquement en suffixe ".*"
  if (starCount === 1 && s.endsWith(".*") && !s.slice(0, -2).includes("*")) {
    const base = s.slice(0, -2);
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(base);
  }
  return false;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHostAllowed(hostname, whitelist) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;

  for (const entry of whitelist || []) {
    const e = String(entry || "").trim().toLowerCase();
    if (!e) continue;

    if (e.endsWith(".*")) {
      const base = e.slice(0, -2);
      const re = new RegExp(`(^|\\.)${escapeRegExp(base)}\\.[^.]+$`, "i");
      if (re.test(host)) return true;
      continue;
    }
    const re = new RegExp(`(^|\\.)${escapeRegExp(e)}$`, "i");
    if (re.test(host)) return true;
  }
  return false;
}

function tabsQueryActive() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs || []);
      });
    } catch {
      resolve([]);
    }
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = getChromeLastErrorMessage();
        if (err) return resolve({ __error: err });
        resolve(response || null);
      });
    } catch (e) {
      resolve({ __error: String(e) });
    }
  });
}

function scriptingExecuteScript(details) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(details, (results) => {
        const err = getChromeLastErrorMessage();
        if (err) return resolve({ __error: err });
        resolve(results || []);
      });
    } catch (e) {
      resolve({ __error: String(e) });
    }
  });
}

function downloadsDownload(options) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.downloads?.download) return resolve({ ok: false, error: "downloads_api_unavailable" });
      chrome.downloads.download(options, (downloadId) => {
        const err = getChromeLastErrorMessage();
        if (err) return resolve({ ok: false, error: err });
        resolve({ ok: true, downloadId: downloadId || null });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function $(id) {
  return document.getElementById(id);
}

async function getExportDiagnosticFromLocal() {
  // Diagnostic snapshot is strictly local-only by design.
  const res = await storageGet(chrome.storage.local, [EXPORT_DIAGNOSTIC_KEY]);
  if (res && !res.__error) return res[EXPORT_DIAGNOSTIC_KEY] || null;
  return null;
}

async function clearExportDiagnosticLocalOnly() {
  try {
    await storageSet(chrome.storage.local, { [EXPORT_DIAGNOSTIC_KEY]: null });
  } catch {
    // no-op
  }
}

function safeParseHttpStatusFromCode(code) {
  try {
    const c = String(code || "");
    if (!c.startsWith("HTTP_")) return null;
    const n = Number(c.slice("HTTP_".length));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function mapErrorCodeToDiagnosticType(code) {
  const c = String(code || "");
  if (c === "NETWORK_ERROR" || c === "NO_RESPONSE") return "network_error";
  if (c === "TIMEOUT" || c === "HTTP_408") return "timeout";
  if (c === "BAD_RESPONSE") return "invalid_json";
  const s = safeParseHttpStatusFromCode(c);
  if (s === 429) return "http_429";
  if (s != null && s >= 500 && s <= 599) return "http_5xx";
  if (c.startsWith("HTTP_")) return "network_error";
  return "network_error";
}

function buildDiagnosticFromExportState(st) {
  try {
    const s = st && typeof st === "object" ? st : {};
    const status = String(s.status || "error");
    const lastSuccessPage = typeof s.page === "number" ? s.page : 0;
    const totalPages = typeof s.pages === "number" ? s.pages : null;
    const collectedItemsCount = typeof s.collected === "number" ? s.collected : 0;
    const exportId = String(s.started_at || s.updated_at || "");
    const le = s.last_error && typeof s.last_error === "object" ? s.last_error : null;
    const code = String((le && le.code) || s.error || "");
    if (!code) return null;

    const httpStatus = safeParseHttpStatusFromCode(code);
    const retryAfterMs = le && typeof le.retry_after_ms === "number" ? le.retry_after_ms : null;
    const retrySuggestedAfterSeconds =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(1, Math.round(retryAfterMs / 1000))
        : null;

    return {
      exportId,
      status,
      lastSuccessPage,
      totalPages,
      collectedItemsCount,
      lastError: {
        type: mapErrorCodeToDiagnosticType(code),
        endpoint: "/apo/",
        httpStatus: httpStatus != null ? httpStatus : null,
        timestamp: String((le && le.at) || s.updated_at || new Date().toISOString()),
      },
      retrySuggestedAfterSeconds,
      // Not available in export state (only in Network Observer runtime); keep 0 as "unknown/none".
      retryCount: 0,
    };
  } catch {
    return null;
  }
}

function formatDiagnosticReportForCopy(report) {
  try {
    const r = report && typeof report === "object" ? report : null;
    if (!r) return "";

    const status = String(r.status || "error");
    const exportId = String(r.exportId || "");
    const lastSuccessPage = typeof r.lastSuccessPage === "number" ? r.lastSuccessPage : 0;
    const totalPages = typeof r.totalPages === "number" ? r.totalPages : null;
    const collected = typeof r.collectedItemsCount === "number" ? r.collectedItemsCount : 0;
    const lastError = r.lastError && typeof r.lastError === "object" ? r.lastError : {};
    const endpoint = String(lastError.endpoint || "/apo/");
    const errType = String(lastError.type || "network_error");
    const httpStatus = typeof lastError.httpStatus === "number" ? lastError.httpStatus : null;
    const retryAfter = typeof r.retrySuggestedAfterSeconds === "number" ? r.retrySuggestedAfterSeconds : null;

    let headline = "Export issue detected";
    if (status === "paused") headline = "Export paused due to connection issue";
    else if (status === "error") headline = "Export stopped due to a network error";

    let errorLine = "Error: Network error";
    if (errType === "http_429") errorLine = "Error: HTTP 429 (rate limited)";
    else if (errType === "http_5xx") errorLine = `Error: HTTP ${httpStatus || "5xx"} (server error)`;
    else if (errType === "timeout") errorLine = "Error: Timeout";
    else if (errType === "invalid_json") errorLine = "Error: Invalid JSON/response";
    else if (httpStatus != null) errorLine = `Error: HTTP ${httpStatus}`;

    const pageLine =
      totalPages != null
        ? `Page: ${lastSuccessPage} / ${totalPages}`
        : `Page: ${lastSuccessPage}`;

    const lines = [
      headline,
      exportId ? `Export ID: ${exportId}` : "Export ID: (unknown)",
      pageLine,
      `Collected items: ${collected}`,
      `Endpoint: ${endpoint}`,
      errorLine,
    ];
    if (retryAfter != null) lines.push(`Suggested retry: wait ~${retryAfter} seconds`);
    if (typeof r.retryCount === "number") lines.push(`Retry count: ${r.retryCount}`);

    // Debug-only enrichment (if available in stored diagnostic)
    try {
      const req = r.request && typeof r.request === "object" ? r.request : null;
      const res = r.response && typeof r.response === "object" ? r.response : null;
      const op = req && typeof req.operationName === "string" ? req.operationName : "";
      const vars = req && req.variables && typeof req.variables === "object" ? req.variables : null;
      const ct = res && typeof res.contentType === "string" ? res.contentType : "";
      const snippet = res && typeof res.bodySnippet === "string" ? res.bodySnippet : "";

      if (op || vars) {
        lines.push("");
        lines.push("Request (debug):");
        if (op) lines.push(`- operationName: ${op}`);
        if (vars) lines.push(`- variables: ${JSON.stringify(vars, null, 2)}`);
      }

      if (ct || snippet) {
        lines.push("");
        lines.push("Response (debug):");
        if (ct) lines.push(`- content-type: ${ct}`);
        if (snippet) lines.push(`- body snippet: ${snippet}`);
      }

      // Keep a raw JSON at the end for exact troubleshooting (still local-only; user chooses to share).
      if (req || res) {
        lines.push("");
        lines.push("Raw diagnostic (debug):");
        lines.push(JSON.stringify(r, null, 2));
      }
    } catch {
      // no-op
    }

    lines.push("");
    lines.push("Diagnostic information for troubleshooting. No data is sent anywhere.");
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function copyTextToClipboard(text) {
  const s = String(text || "");
  if (!s) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

async function updateExportDiagnosticUi(cfg, st) {
  const panel = document.getElementById("exportDiagnosticPanel");
  const statusEl = document.getElementById("exportCopyDiagnosticStatus");
  if (statusEl) statusEl.style.display = "none";
  if (!panel) return;

  const debug = !!cfg?.debug;
  const status = String(st?.status || "idle");
  const isIssueScreen = status === "paused" || status === "error";
  if (!debug || !isIssueScreen) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";
}

// UI-only state: whether we have partial export data to resume.
let exportHasPartial = false;
// UI-only state: a partial export payload exists but is not valid for a safe resume.
let exportResumeUnavailable = false;

function updateResumeUi(st) {
  const resumeBtn = $("exportResumeBtn");
  const hint = $("exportResumeHint");
  const status = st?.status || "idle";
  const isRunning = status === "running";
  const isPaused = status === "paused";

  // Resume must be available only for a paused export (network issue), and only when we have a safe PARTIAL snapshot.
  if (resumeBtn) resumeBtn.disabled = isRunning || !isPaused || !exportHasPartial;

  if (!hint) return;
  if (isRunning) {
    hint.style.display = "none";
    return;
  }
  if (!exportHasPartial) {
    hint.style.display = "block";
    if (exportResumeUnavailable) {
      hint.textContent = t("exportResumeHint_unavailable") || "Resume unavailable for this export";
    } else {
      hint.textContent = t("exportResumeHint_none") || "Nothing to resume";
    }
  } else {
    // If we have partial data but export is not paused, we don't allow resume to avoid weird states.
    hint.style.display = isPaused ? "none" : "block";
    if (!isPaused) hint.textContent = t("exportResumeHint_unavailable") || "Resume unavailable for this export";
  }
}

/**
 * i18n layer
 *
 * Chrome i18n works automatically based on the browser language, but it can't be overridden at runtime.
 * For a manual UI language selector, we load `_locales/<lang>/messages.json` locally and use it as a dictionary.
 */
let i18nDict = null; // { [key]: message }

function msgKeyForLangOption(code, prefix) {
  // e.g. "zh-CN" -> "lang_zh_CN"
  const safe = String(code).replace("-", "_");
  return `${prefix}${safe}`;
}

async function loadLocaleDict(lang) {
  const locale = String(lang || "").toLowerCase();
  if (!locale || locale === "auto") return null;

  // Try requested locale, then fallback to en.
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
      // try next candidate
    }
  }
  return null;
}

function t(key, substitutions) {
  const k = String(key || "");
  const subs = Array.isArray(substitutions) ? substitutions : [];

  // Manual dict has priority when user chose a specific UI language.
  if (i18nDict && typeof i18nDict[k] === "string") {
    let s = i18nDict[k];
    // Support Chrome-style substitutions $1..$9
    for (let i = 0; i < subs.length && i < 9; i += 1) {
      const idx = i + 1;
      s = s.replaceAll(`$${idx}`, String(subs[i]));
      s = s.replaceAll(`$${idx}$`, String(subs[i]));
    }
    return s;
  }

  // Default Chrome i18n path (auto)
  try {
    const msg = chrome.i18n.getMessage(k, subs);
    return msg || "";
  } catch {
    return "";
  }
}

function applyI18nToDom() {
  // Text nodes
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const value = t(key);
    if (value) el.textContent = value;
  });

  // Placeholders
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    const value = t(key);
    if (value) el.setAttribute("placeholder", value);
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

function populateUiLangSelect(cfg) {
  const sel = $("uiLang");
  if (!sel) return;
  sel.innerHTML = "";

  const options = [
    { value: "auto", labelKey: "uiLang_auto" },
    { value: "en", labelKey: "uiLang_en" },
    { value: "fr", labelKey: "uiLang_fr" },
  ];

  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = t(opt.labelKey) || opt.value;
    sel.appendChild(o);
  }

  sel.value = cfg.uiLanguage || "auto";
}

async function getMigrateState() {
  const { data } = await getFromStorage([MIGRATE_STATE_KEY]);
  const st = data[MIGRATE_STATE_KEY] && typeof data[MIGRATE_STATE_KEY] === "object" ? data[MIGRATE_STATE_KEY] : {};
  return {
    index: typeof st.index === "number" ? st.index : DEFAULT_MIGRATE_STATE.index,
    targetSite: typeof st.targetSite === "string" ? st.targetSite : DEFAULT_MIGRATE_STATE.targetSite,
    openNewTab: typeof st.openNewTab === "boolean" ? st.openNewTab : DEFAULT_MIGRATE_STATE.openNewTab,
  };
}

async function setMigrateState(patch) {
  const prev = await getMigrateState();
  const next = { ...prev, ...patch };
  await setToStorage({ [MIGRATE_STATE_KEY]: next });
  return next;
}

function populateMigrationSiteSelect(currentSiteId) {
  const sel = $("migrationTargetSite");
  if (!sel) return;
  sel.innerHTML = "";
  for (const s of MIGRATION_SITES) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = t(s.labelKey) || s.id;
    sel.appendChild(o);
  }
  sel.value = currentSiteId || DEFAULT_MIGRATE_STATE.targetSite;
}

async function updateStoredItemsCount() {
  const el = $("migrationStoredItems");
  if (!el) return;
  const { data } = await getFromStorage([EXPORT_DATA_KEY, EXPORT_PARTIAL_KEY]);
  const payload = data[EXPORT_DATA_KEY] || data[EXPORT_PARTIAL_KEY];
  const n = Array.isArray(payload?.items) ? payload.items.length : 0;
  el.textContent = String(n);

  // UI-only: resume is available only if a partial payload exists with at least one item.
  exportHasPartial = false;
  exportResumeUnavailable = false;
  const partial = data[EXPORT_PARTIAL_KEY];
  if (partial) {
    const hasItems = Array.isArray(partial?.items) && partial.items.length > 0;
    const pageOk =
      typeof partial?.meta?.page === "number" &&
      Number.isFinite(partial.meta.page) &&
      partial.meta.page >= 1;
    if (hasItems && pageOk) exportHasPartial = true;
    else exportResumeUnavailable = true;
  }
}

function openMigrationPanel() {
  // Publishable constraint: avoid chrome.tabs.* here. Popup is an extension page; window.open is fine.
  try {
    const url = chrome.runtime.getURL("migrate.html");
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // no-op
  }
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

function renderWhitelist(cfg, currentHost, allowedOverride) {
  const list = $("list");
  const count = $("count");
  if (!list || !count) return;

  list.innerHTML = "";

  const entries = cfg.whitelist || [];
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "item";

    const code = document.createElement("code");
    code.textContent = entry;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "danger";
    btn.textContent = t("deleteBtn") || "Remove";
    btn.addEventListener("click", async () => {
      const next = entries.filter((e) => e !== entry);
      await setConfig({ whitelist: next });
      await refresh();
    });

    li.appendChild(code);
    li.appendChild(btn);
    list.appendChild(li);
  }

  if (entries.length === 1) count.textContent = t("whitelistCount_one") || "1 entry";
  else count.textContent = t("whitelistCount_many", [String(entries.length)]) || `${entries.length} entries`;

  const hostAllowed = $("hostAllowed");
  if (hostAllowed) {
    const ok =
      typeof allowedOverride === "boolean"
        ? allowedOverride
        : isHostAllowed(currentHost, entries);
    hostAllowed.textContent = ok ? t("hostAllowed") : t("hostNotAllowed");
    hostAllowed.style.color = ok ? "var(--accent)" : "var(--danger)";
  }
}

function updateFixNowUi(allowedOverride) {
  const btn = $("fixNowBtn");
  const helper = $("fixNowHelper");
  if (!btn || !helper) return;
  const allowed = allowedOverride === true;
  btn.disabled = !allowed;
  helper.style.display = allowed ? "none" : "block";
  helper.textContent =
    allowed
      ? ""
      : (t("fixNowUnsupportedHelper") || "This action is available only on supported MangaPark domains.");
}

async function refresh() {
  setError("");
  const cfg = await getConfig();

  applyTheme(cfg.theme);

  // Load i18n dict if user selected a manual UI language.
  i18nDict = await loadLocaleDict(cfg.uiLanguage);
  applyI18nToDom();
  updateThemeToggleUi(cfg);

  // Populate language selects (labels must be localized)
  populateUiLangSelect(cfg);
  // (translation removed)

  $("enabledToggle").checked = !!cfg.enabled;
  $("debugToggle").checked = !!cfg.debug;
  // (translation removed)

  // Migration UI
  const migState = await getMigrateState();
  populateMigrationSiteSelect(migState.targetSite);
  const migOpenNewTab = $("migrationOpenNewTab");
  if (migOpenNewTab) migOpenNewTab.checked = !!migState.openNewTab;
  await updateStoredItemsCount();

  let currentHost = "";
  let allowed = null;

  try {
    const [tab] = await tabsQueryActive();
    if (tab?.id != null) {
      const resp = await tabsSendMessage(tab.id, { type: "MP_FIX_GET_STATUS" });
      if (resp && !resp.__error) {
        currentHost = resp.host || "";
        allowed = typeof resp.allowed === "boolean" ? resp.allowed : null;
      }
    }
  } catch {
    // no-op
  }

  const currentHostEl = $("currentHost");
  if (currentHostEl) currentHostEl.textContent = currentHost || t("unknownHost") || "(unknown)";

  renderWhitelist(cfg, currentHost, allowed);
  updateFixNowUi(allowed);

  // Steps indicator (best-effort)
  try {
    const st = await getExportState();
    updateStepsUi(st?.status);
    setActiveScreen(mapExportStateToScreen(st?.status));
    renderExportState(st);
    updateResumeUi(st);
    await updateExportDiagnosticUi(cfg, st);
    updateExportStallUi(cfg, st);
  } catch {
    // no-op
  }
}

function updateExportStallUi(cfg, st) {
  try {
    const panel = document.getElementById("exportStallPanel");
    if (!panel) return;
    const debug = !!cfg?.debug;
    const status = String(st?.status || "idle");
    if (!debug || status !== "running") {
      panel.style.display = "none";
      return;
    }

    const ts = String(st?.last_progress_at || st?.updated_at || "");
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) {
      panel.style.display = "none";
      return;
    }

    const ageMs = Date.now() - t;
    // Consider stalled if no progress marker for 60s+.
    panel.style.display = ageMs >= 60000 ? "block" : "none";
  } catch {
    // no-op
  }
}

async function fixThisPageNow() {
  setError("");
  const cfg = await getConfig();

  const [tab] = await tabsQueryActive();
  if (!tab?.id) {
    setError(t("errorNoActiveTab"));
    return;
  }

  // 1) Injecter la lib patch (fichier statique local)
  const inj1 = await scriptingExecuteScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["injected_patch.js"],
  });
  if (inj1.__error) {
    setError((t("errorInjectFailed", [inj1.__error]) || "").replace("$DETAILS$", inj1.__error));
    return;
  }

  // 2) Lancer le patch en mode "force" (ignore whitelist) + respecte debug du user
  const inj2 = await scriptingExecuteScript({
    target: { tabId: tab.id, allFrames: true },
    func: (debug) => {
      try {
        const ns = "__MP_IMAGE_FIX__";
        const patcher = window[ns];
        if (patcher && typeof patcher.run === "function") {
          patcher.run({
            enabled: true,
            debug: !!debug,
            whitelist: [],
            force: true,
            observe: true,
            reason: "manual:popup",
          });
        }
      } catch {
        // no-op
      }
    },
    args: [!!cfg.debug],
  });

  if (inj2.__error) {
    setError((t("errorExecFailed", [inj2.__error]) || "").replace("$DETAILS$", inj2.__error));
    return;
  }
}

function tabsCreate(createProperties) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.create(createProperties, (tab) => resolve(tab || null));
    } catch {
      resolve(null);
    }
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.update(tabId, updateProperties, (tab) => resolve(tab || null));
    } catch {
      resolve(null);
    }
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();

    function done(ok) {
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch {
        // no-op
      }
      resolve(ok);
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo && changeInfo.status === "complete") done(true);
    }

    try {
      chrome.tabs.onUpdated.addListener(onUpdated);
    } catch {
      resolve(false);
      return;
    }

    const t = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        done(false);
      }
    }, 250);
  });
}

async function getActiveTabUrlViaScripting(tabId) {
  const res = await scriptingExecuteScript({
    target: { tabId, allFrames: false },
    func: () => {
      try {
        return window.location.href;
      } catch {
        return "";
      }
    },
  });
  if (res && res.__error) return { __error: res.__error };
  // executeScript returns [{result: ...}]
  const url = Array.isArray(res) && res[0] && typeof res[0].result === "string" ? res[0].result : "";
  return url ? { url } : { __error: "empty_url" };
}

function setExportError(msg) {
  const el = $("exportError");
  if (!el) return;
  if (!msg) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
}

function setExportActionErrorUi(msg) {
  // Make errors visible on the Export error screen (exportError div is sr-only).
  try {
    const s = String(msg || "").trim();
    if (!s) return;
    const tTitle = document.getElementById("exportErrorTitle");
    const tDesc = document.getElementById("exportErrorDesc");
    const tSol = document.getElementById("exportErrorSolution");
    if (tTitle) tTitle.textContent = t("exportErr_unknown_title") || "Something Didn't Work";
    if (tDesc) tDesc.textContent = s;
    if (tSol) tSol.textContent = t("exportErr_unknown_solution") || "Try refreshing this page and starting over.";
  } catch {
    // no-op
  }
}

function renderExportState(st) {
  const statusEl = $("exportStatus");
  const progressEl = $("exportProgress");
  if (!statusEl || !progressEl) return;

  const status = st?.status || "idle";
  // Localize status label
  const statusKey =
    status === "running"
      ? "exportStatus_running"
      : status === "done"
        ? "exportStatus_done"
        : status === "paused"
          ? "exportStatus_paused"
        : status === "error"
          ? "exportStatus_error"
          : "exportStatus_idle";
  statusEl.textContent = t(statusKey) || status;

  const page = typeof st?.page === "number" ? st.page : null;
  const pages = typeof st?.pages === "number" ? st.pages : null;
  const collected = typeof st?.collected === "number" ? st.collected : 0;

  // Visual status dot (optional in DOM)
  const dot = $("exportStatusDot");
  const percentEl = $("exportPercent");
  const fill = $("exportProgressFill");
  const bar = document.querySelector(".progressBar[role='progressbar']");

  let pct = 0;
  if (page && pages && pages > 0) pct = Math.round((page / pages) * 100);
  if (!Number.isFinite(pct) || pct < 0) pct = 0;
  if (pct > 100) pct = 100;

  if (percentEl) percentEl.textContent = `${pct}%`;
  if (fill) fill.style.width = `${pct}%`;
  if (bar) bar.setAttribute("aria-valuenow", String(pct));

  if (dot) {
    dot.classList.remove("running", "done", "error", "paused");
    if (status === "running") dot.classList.add("running");
    else if (status === "done") dot.classList.add("done");
    else if (status === "paused") dot.classList.add("paused");
    else if (status === "error") dot.classList.add("error");
  }

  if (page && pages) {
    progressEl.textContent =
      t("exportProgressFmt", [String(page), String(pages), String(collected)]) ||
      `Page ${page}/${pages} — Collected ${collected}`;
  } else if (collected) {
    progressEl.textContent =
      t("exportProgressCollectedFmt", [String(collected)]) ||
      `Collected ${collected}`;
  } else {
    progressEl.textContent = "-";
  }

  // Update Make-style running screen fields (best-effort)
  try {
    const runningPagesChecked = document.getElementById("runningPagesChecked");
    const runningPagesTotal = document.getElementById("runningPagesTotal");
    const runningMangaFound = document.getElementById("runningMangaFound");
    const runningPercent = document.getElementById("runningPercent");
    const runningFill = document.getElementById("runningProgressFill");

    if (runningPagesChecked) runningPagesChecked.textContent = page ? String(page) : "0";
    if (runningPagesTotal) runningPagesTotal.textContent = pages ? String(pages) : "0";
    if (runningMangaFound) runningMangaFound.textContent = String(collected || 0);
    if (runningPercent) runningPercent.textContent = `${pct}%`;
    if (runningFill) runningFill.style.width = `${pct}%`;
  } catch {
    // no-op
  }

  // Update Make-style done screen total
  try {
    const doneTotal = document.getElementById("doneTotalItems");
    if (doneTotal) doneTotal.textContent = String(collected || 0);
  } catch {
    // no-op
  }

  // Update Make-style error screen copy from error code
  try {
    const tTitle = document.getElementById("exportErrorTitle");
    const tDesc = document.getElementById("exportErrorDesc");
    const tSol = document.getElementById("exportErrorSolution");
    if (tTitle && tDesc && tSol) {
      const errCode = st?.error ? String(st.error) : "";
      if (errCode === "NOT_LOGGED_IN") {
        tTitle.textContent = t("exportErr_login_title") || "Not Logged In";
        tDesc.textContent =
          t("exportErr_login_desc") || "We need you to be logged into MangaPark to save your library.";
        tSol.textContent =
          t("exportErr_login_solution") ||
          "Open MangaPark in another tab, log in, then come back and try again.";
      } else if (status === "paused") {
        tTitle.textContent = t("exportPaused_title") || "Connection issue detected";
        tDesc.textContent =
          t("exportPaused_desc") ||
          "Connection issue detected. Export paused. You can retry safely.";
        tSol.textContent =
          t("exportPaused_solution") || "Click “Try Again” to resume from where we stopped.";
      } else if (errCode) {
        // Network-ish errors should present as resumable/pause-friendly.
        const isNetworkish =
          errCode.startsWith("HTTP_") || ["BAD_RESPONSE", "NO_RESPONSE", "NETWORK_ERROR", "TIMEOUT"].includes(errCode);
        if (isNetworkish) {
          tTitle.textContent = t("exportPaused_title") || "Connection issue detected";
          tDesc.textContent =
            t("exportPaused_desc") ||
            "Connection issue detected. Export paused. You can retry safely.";
          tSol.textContent =
            t("exportPaused_solution") || "Click “Try Again” to resume from where we stopped.";
        } else {
          tTitle.textContent = t("exportErr_unknown_title") || "Something Didn't Work";
          tDesc.textContent =
            t("exportErr_unknown_desc") || "The save stopped unexpectedly. This happens sometimes.";
          tSol.textContent = t("exportErr_unknown_solution") || "Try refreshing this page and starting over.";
        }
      } else {
        tTitle.textContent = t("exportErr_unknown_title") || "Something Didn't Work";
        tDesc.textContent =
          t("exportErr_unknown_desc") || "The save stopped unexpectedly. This happens sometimes.";
        tSol.textContent = t("exportErr_unknown_solution") || "Try refreshing this page and starting over.";
      }
    }
  } catch {
    // no-op
  }

  const err = st?.error ? String(st.error) : "";
  if (!err) {
    setExportError("");
  } else if (err === "NOT_LOGGED_IN") {
    setExportError(t("exportNotLoggedIn") || "Not logged in.");
  } else if (err === "CANCELLED") {
    setExportError(t("exportCancelled") || "Cancelled.");
  } else {
    setExportError(`${t("exportErrorLabel") || "Error:"} ${err}`);
  }

  // Buttons state
  const startBtn = $("exportStartBtn");
  const resumeBtn = $("exportResumeBtn");
  const cancelBtn = $("exportCancelBtn");
  const dlCsvBtn = $("exportDownloadCsvBtn");
  const dlJsonBtn = $("exportDownloadJsonBtn");
  const clearBtn = $("exportClearBtn");

  const isRunning = status === "running";
  const isPaused = status === "paused";
  const hasData = status === "done" || (collected && collected > 0);

  if (startBtn) startBtn.disabled = isRunning;
  if (resumeBtn) resumeBtn.disabled = isRunning || !isPaused || !exportHasPartial;
  if (cancelBtn) cancelBtn.disabled = !isRunning;
  if (dlCsvBtn) dlCsvBtn.disabled = !hasData;
  if (dlJsonBtn) dlJsonBtn.disabled = !hasData;
  if (clearBtn) clearBtn.disabled = isRunning;
}

async function getExportState() {
  const { data } = await getFromStorage([EXPORT_STATE_KEY]);
  return data[EXPORT_STATE_KEY] || { status: "idle" };
}

async function clearExportStorage() {
  await setToStorage({
    [EXPORT_STATE_KEY]: { status: "idle", page: 0, pages: null, collected: 0, total: null, error: null, updated_at: new Date().toISOString() },
    [EXPORT_DATA_KEY]: null,
    [EXPORT_PARTIAL_KEY]: null,
    [EXPORT_CANCEL_KEY]: false,
  });
}

async function downloadBlob(filename, mime, content) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    let used = "anchor";

    // Prefer downloads API in the popup: Chrome can block <a download> for extension popups.
    const dl = await downloadsDownload({ url, filename, saveAs: false });
    if (dl.ok) {
      used = "downloads";
    } else {
      // Fallback: anchor click
      try {
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try {
            a.remove();
          } catch {
            // no-op
          }
        }, 0);
      } catch {
        // ignore; handled by returning false below
      }
    }

    // Revoke after a short delay to avoid cancelling the download on some Chromium builds.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // no-op
      }
    }, used === "downloads" ? 5000 : 1000);
    return true;
  } catch {
    // no-op
    return false;
  }
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function downloadExportJson() {
  const { data } = await getFromStorage([EXPORT_DATA_KEY, EXPORT_PARTIAL_KEY]);
  const payload = data[EXPORT_DATA_KEY] || data[EXPORT_PARTIAL_KEY];
  if (!payload) return;
  const captured = payload?.meta?.captured_at || new Date().toISOString();
  const file = `mangapark_follows_${captured.replace(/[:.]/g, "-")}.json`;
  const ok = await downloadBlob(file, "application/json;charset=utf-8", JSON.stringify(payload, null, 2));
  if (!ok) {
    const m = t("exportDownloadFailed") || "Download failed. Try downloading from the migration page instead.";
    setExportError(m);
    setExportActionErrorUi(m);
  }
}

async function downloadExportCsv() {
  const { data } = await getFromStorage([EXPORT_DATA_KEY, EXPORT_PARTIAL_KEY]);
  const payload = data[EXPORT_DATA_KEY] || data[EXPORT_PARTIAL_KEY];
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) return;

  const captured = payload?.meta?.captured_at || new Date().toISOString();
  const file = `mangapark_follows_${captured.replace(/[:.]/g, "-")}.csv`;
  const header = ["title", "mangapark_url", "comic_id", "last_read_serial", "last_read_url", "captured_at"];
  const lines = [header.join(",")];
  for (const it of items) {
    lines.push(
      [
        csvEscape(it.title),
        csvEscape(it.mangapark_url),
        csvEscape(it.comic_id),
        csvEscape(it.last_read_serial),
        csvEscape(it.last_read_url),
        csvEscape(it.captured_at),
      ].join(",")
    );
  }
  const ok = await downloadBlob(file, "text/csv;charset=utf-8", lines.join("\n"));
  if (!ok) {
    const m = t("exportDownloadFailed") || "Download failed. Try downloading from the migration page instead.";
    setExportError(m);
    setExportActionErrorUi(m);
  }
}

function isMangaparkFollowsUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname === "/my/follows";
  } catch {
    return false;
  }
}

function parseOriginIfAllowed(url, allowedHosts) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    const host = String(u.hostname || "").toLowerCase();
    if (!host) return "";
    return isHostAllowed(host, allowedHosts) ? u.origin : "";
  } catch {
    return "";
  }
}

async function injectAndRunExport(tabId) {
  // Inject runner (file)
  const inj = await scriptingExecuteScript({
    target: { tabId, allFrames: false },
    files: ["mp_export_runner.js"],
  });
  if (inj && inj.__error) {
    const m = (t("exportInjectFailed", [inj.__error]) || "").replace("$DETAILS$", inj.__error) || String(inj.__error);
    setExportError(m);
    setExportActionErrorUi(m);
    return false;
  }
  return true;
}

async function openFollowsAndRun() {
  // Workflow A:
  // - If not already on /my/follows, open <user origin>/my/follows, wait complete, inject runner.
  // Export is an independent feature: it must work even if Auto-fix is OFF.

  const [tab] = await tabsQueryActive();
  if (!tab?.id) {
    const m = t("errorNoActiveTab") || "No active tab.";
    setExportError(m);
    setExportActionErrorUi(m);
    return;
  }

  const cfg = await getConfig();
  const allowedHosts = uniq([...(DEFAULT_WHITELIST || []), ...((cfg && cfg.whitelist) || [])]);

  // Get active tab URL without tabs permission
  const urlRes = await getActiveTabUrlViaScripting(tab.id);
  const currentUrl = urlRes.url || "";

  if (isMangaparkFollowsUrl(currentUrl)) {
    const origin = parseOriginIfAllowed(currentUrl, allowedHosts);
    if (origin) await setToStorage({ [EXPORT_ORIGIN_KEY]: origin });
    await setToStorage({ [EXPORT_CANCEL_KEY]: false });
    await injectAndRunExport(tab.id);
    return;
  }

  const originFromActiveTab = parseOriginIfAllowed(currentUrl, allowedHosts);
  if (originFromActiveTab) await setToStorage({ [EXPORT_ORIGIN_KEY]: originFromActiveTab });

  const { data: exportCtx } = await getFromStorage([EXPORT_ORIGIN_KEY]);
  const originFromStorage = parseOriginIfAllowed(exportCtx[EXPORT_ORIGIN_KEY] || "", allowedHosts);
  const origin = originFromActiveTab || originFromStorage || "https://mangapark.net";

  const followsUrl = `${origin}/my/follows`;
  const newTab = await tabsCreate({ url: followsUrl, active: true });
  if (!newTab?.id) {
    const m = t("exportOpenFollowsFailed") || "Could not open /my/follows.";
    setExportError(m);
    setExportActionErrorUi(m);
    return;
  }

  const ok = await waitForTabComplete(newTab.id, 30000);
  if (!ok) {
    const m = t("exportOpenFollowsTimeout") || "Timed out waiting for /my/follows.";
    setExportError(m);
    setExportActionErrorUi(m);
    return;
  }

  await setToStorage({ [EXPORT_CANCEL_KEY]: false });
  await injectAndRunExport(newTab.id);
}

async function resumeExport() {
  // Resume == same as start (runner reads existing state and resumes lastPage+1)
  await openFollowsAndRun();
}

async function cancelExport() {
  // Persist cancellation in storage (not only UI) so a stuck "running" state doesn't survive popup reopen.
  const st = await getExportState();
  const now = new Date().toISOString();
  const nextState = {
    ...(st && typeof st === "object" ? st : {}),
    status: "idle",
    error: "CANCELLED",
    updated_at: now,
  };
  await setToStorage({
    [EXPORT_CANCEL_KEY]: true,
    [EXPORT_STATE_KEY]: nextState,
  });
  renderExportState(nextState);
}

async function init() {
  // Theme toggle (Figma Make parity)
  $("themeToggleBtn")?.addEventListener("click", async () => {
    const cfg = await getConfig();
    const next = (cfg.theme || "dark") === "dark" ? "light" : "dark";
    await setConfig({ theme: next });
    await refresh();
  });

  // UI language selector
  $("uiLang")?.addEventListener("change", async (e) => {
    const v = String(e.target.value || "auto").toLowerCase();
    await setConfig({ uiLanguage: v });
    await refresh();
  });

  $("enabledToggle").addEventListener("change", async (e) => {
    await setConfig({ enabled: !!e.target.checked });
    await refresh();
  });

  $("debugToggle").addEventListener("change", async (e) => {
    await setConfig({ debug: !!e.target.checked });
    await refresh();
  });

  // (translation removed)

  // Footer/support actions (CWS: no dead/placeholder links)
  const SUPPORT_PROJECT_URL = "https://github.com/sponsors/Jackstonebreaker";
  const PROJECT_WEBSITE_URL = "https://github.com/Jackstonebreaker/mangapark-image-fix";
  $("supportProjectBtn")?.addEventListener("click", () => {
    window.open(SUPPORT_PROJECT_URL, "_blank", "noopener,noreferrer");
  });
  $("projectWebsiteBtn")?.addEventListener("click", () => {
    window.open(PROJECT_WEBSITE_URL, "_blank", "noopener,noreferrer");
  });

  $("fixNowBtn")?.addEventListener("click", async () => {
    await fixThisPageNow();
    await refresh();
  });

  $("addBtn").addEventListener("click", async () => {
    setError("");
    const input = $("entryInput");
    const value = String(input.value || "").trim().toLowerCase();
    if (!isValidWhitelistEntry(value)) {
      setError(t("errorInvalidEntry"));
      return;
    }
    const cfg = await getConfig();
    const next = uniq([...(cfg.whitelist || []), value]);
    await setConfig({ whitelist: next });
    input.value = "";
    await refresh();
  });

  $("entryInput").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("addBtn").click();
    }
  });

  $("resetBtn").addEventListener("click", async () => {
    await setConfig({ whitelist: DEFAULT_WHITELIST });
    await refresh();
  });

  // Export buttons
  $("exportStartBtn")?.addEventListener("click", async () => {
    setExportError("");
    await openFollowsAndRun();
  });
  $("exportResumeBtn")?.addEventListener("click", async () => {
    setExportError("");
    await resumeExport();
  });
  $("exportCancelBtn")?.addEventListener("click", async () => {
    await cancelExport();
  });
  $("exportDownloadCsvBtn")?.addEventListener("click", async () => {
    await downloadExportCsv();
  });
  $("exportDownloadJsonBtn")?.addEventListener("click", async () => {
    await downloadExportJson();
  });
  $("exportClearBtn")?.addEventListener("click", async () => {
    await clearExportStorage();
    await refresh();
  });

  document.getElementById("exportForceResetBtn")?.addEventListener("click", async () => {
    const cfg = await getConfig();
    if (!cfg?.debug) return;
    await clearExportStorage();
    await refresh();
  });

  document.getElementById("exportForceResetBtn_error")?.addEventListener("click", async () => {
    const cfg = await getConfig();
    if (!cfg?.debug) return;
    await clearExportStorage();
    await refresh();
    setActiveScreen("screenHome");
  });

  // Make-style buttons wiring (screen-specific duplicates)
  document.getElementById("openMigrationPanelBtn_done")?.addEventListener("click", async () => {
    openMigrationPanel();
  });
  document.getElementById("backToHomeBtn_running")?.addEventListener("click", async () => {
    setActiveScreen("screenHome");
  });
  document.getElementById("backToHomeBtn_done")?.addEventListener("click", async () => {
    setActiveScreen("screenHome");
  });
  document.getElementById("backToHomeBtn_error")?.addEventListener("click", async () => {
    setActiveScreen("screenHome");
  });
  document.getElementById("exportRetryBtn")?.addEventListener("click", async () => {
    // Reuse existing resume/start logic
    setExportError("");
    try {
      // Give immediate feedback in the UI while we (re)inject.
      setActiveScreen("screenExportRunning");
      await resumeExport();
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      setExportError(msg);
      setExportActionErrorUi(msg);
      setActiveScreen("screenExportError");
    }
  });
  document.getElementById("exportCancelErrorBtn")?.addEventListener("click", async () => {
    // Go back to Home without altering export state
    setActiveScreen("screenHome");
  });

  document.getElementById("exportCopyDiagnosticBtn")?.addEventListener("click", async () => {
    try {
      const cfg = await getConfig();
      if (!cfg?.debug) return;
      const diag = (await getExportDiagnosticFromLocal()) || (await getExportState().then(buildDiagnosticFromExportState).catch(() => null));
      if (!diag) return;

      const text = formatDiagnosticReportForCopy(diag);
      const ok = await copyTextToClipboard(text);
      const statusEl = document.getElementById("exportCopyDiagnosticStatus");
      if (statusEl) {
        statusEl.style.display = ok ? "block" : "none";
        if (ok) {
          setTimeout(() => {
            try {
              statusEl.style.display = "none";
            } catch {
              // no-op
            }
          }, 2000);
        }
      }
    } catch {
      // no-op
    }
  });

  document.getElementById("exportClearDiagnosticBtn")?.addEventListener("click", async () => {
    try {
      const cfg = await getConfig();
      if (!cfg?.debug) return;
      await clearExportDiagnosticLocalOnly();
      const panel = document.getElementById("exportDiagnosticPanel");
      if (panel) panel.style.display = "none";
    } catch {
      // no-op
    }
  });

  // Theme toggles duplicated on other screens
  for (const id of ["themeToggleBtn_running", "themeToggleBtn_done", "themeToggleBtn_error"]) {
    document.getElementById(id)?.addEventListener("click", async () => {
      const cfg = await getConfig();
      const next = (cfg.theme || "dark") === "dark" ? "light" : "dark";
      await setConfig({ theme: next });
      await refresh();
    });
  }

  // Live updates for export state
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" && area !== "local") return;
      if (changes && changes[EXPORT_STATE_KEY]) {
        const next = changes[EXPORT_STATE_KEY].newValue;
        renderExportState(next);
        updateResumeUi(next);
        updateStepsUi(next?.status);
        setActiveScreen(mapExportStateToScreen(next?.status));
        getConfig().then((cfg) => updateExportDiagnosticUi(cfg, next)).catch(() => {});
      }
    });
  } catch {
    // no-op
  }

  // Migration controls
  $("migrationTargetSite")?.addEventListener("change", async (e) => {
    await setMigrateState({ targetSite: String(e.target.value || "mangadex") });
  });
  $("migrationOpenNewTab")?.addEventListener("change", async (e) => {
    await setMigrateState({ openNewTab: !!e.target.checked });
  });
  $("openMigrationPanelBtn")?.addEventListener("click", async () => {
    // Persist latest state before opening panel
    const sel = $("migrationTargetSite");
    const chk = $("migrationOpenNewTab");
    await setMigrateState({
      targetSite: String(sel?.value || "mangadex"),
      openNewTab: !!chk?.checked,
    });
    openMigrationPanel();
  });

  // Keep stored items count live if export data changes
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" && area !== "local") return;
      if (changes && (changes[EXPORT_DATA_KEY] || changes[EXPORT_PARTIAL_KEY])) {
        updateStoredItemsCount();
        getExportState().then((st) => updateResumeUi(st)).catch(() => {});
      }
    });
  } catch {
    // no-op
  }

  await refresh();
  const st = await getExportState();
  renderExportState(st);
  updateResumeUi(st);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => setError(String(e)));
});

