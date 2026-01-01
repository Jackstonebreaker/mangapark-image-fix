/* global chrome */

/**
 * service_worker.js (publishable)
 * - Assure les defaults (enabled/debug/whitelist) au 1er install
 * - Met à jour le badge : OFF / ON / DBG
 * - Écoute storage.onChanged pour refléter les changements
 *
 * Note : implémentation callback-safe (évite dépendance aux promesses chrome.*).
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
};

// If sync storage is readable but not writable (quota / policy / transient), popup.js stores a marker locally.
// Service worker must respect it so badge/state reflect the user's last choice on this device.
const CONFIG_STORAGE_MODE_KEY = "mp_config_storage_mode"; // "sync" | "local"

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

function actionSetBadgeText(details) {
  return new Promise((resolve) => {
    try {
      chrome.action.setBadgeText(details, () => resolve());
    } catch {
      resolve();
    }
  });
}

function actionSetBadgeBackgroundColor(details) {
  return new Promise((resolve) => {
    try {
      chrome.action.setBadgeBackgroundColor(details, () => resolve());
    } catch {
      resolve();
    }
  });
}

function applyDefaults(partial) {
  return {
    enabled:
      typeof partial.enabled === "boolean" ? partial.enabled : DEFAULT_CONFIG.enabled,
    debug: typeof partial.debug === "boolean" ? partial.debug : DEFAULT_CONFIG.debug,
    whitelist: Array.isArray(partial.whitelist) ? partial.whitelist : DEFAULT_CONFIG.whitelist,
  };
}

async function getConfigPreferSync() {
  const keys = ["enabled", "debug", "whitelist"];
  const modeRes = await storageGet(chrome.storage.local, [CONFIG_STORAGE_MODE_KEY]);
  const mode =
    modeRes && !modeRes.__error && typeof modeRes[CONFIG_STORAGE_MODE_KEY] === "string"
      ? String(modeRes[CONFIG_STORAGE_MODE_KEY] || "")
      : "";

  if (mode === "local") {
    const localRes = await storageGet(chrome.storage.local, keys);
    if (!localRes.__error) return { raw: localRes, cfg: applyDefaults(localRes), area: "local" };
    const syncRes = await storageGet(chrome.storage.sync, keys);
    if (!syncRes.__error) return { raw: syncRes, cfg: applyDefaults(syncRes), area: "sync" };
    return { raw: {}, cfg: { ...DEFAULT_CONFIG }, area: "local" };
  }

  const syncRes = await storageGet(chrome.storage.sync, keys);
  if (!syncRes.__error) return { raw: syncRes, cfg: applyDefaults(syncRes), area: "sync" };

  const localRes = await storageGet(chrome.storage.local, keys);
  if (!localRes.__error) return { raw: localRes, cfg: applyDefaults(localRes), area: "local" };

  return { raw: {}, cfg: { ...DEFAULT_CONFIG }, area: "none" };
}

async function ensureDefaults() {
  const { raw, cfg, area } = await getConfigPreferSync();

  const patch = {};
  if (typeof raw.enabled !== "boolean") patch.enabled = DEFAULT_CONFIG.enabled;
  if (typeof raw.debug !== "boolean") patch.debug = DEFAULT_CONFIG.debug;
  if (!Array.isArray(raw.whitelist)) patch.whitelist = DEFAULT_CONFIG.whitelist;

  if (Object.keys(patch).length === 0) return cfg;

  const target = area === "sync" ? chrome.storage.sync : chrome.storage.local;
  await storageSet(target, patch);
  return { ...cfg, ...patch };
}

async function updateBadgeFromConfig(cfg) {
  try {
    const enabled = !!cfg.enabled;
    const debug = !!cfg.debug;

    let text = "";
    let color = [0, 0, 0, 0];

    if (!enabled) {
      text = "OFF";
      color = [220, 53, 69, 255];
    } else if (debug) {
      text = "DBG";
      color = [13, 110, 253, 255];
    } else {
      text = "ON";
      color = [25, 135, 84, 255];
    }

    await actionSetBadgeText({ text });
    await actionSetBadgeBackgroundColor({ color });
  } catch {
    // no-op
  }
}

async function init() {
  const cfg = await ensureDefaults();
  await updateBadgeFromConfig(cfg);
}

chrome.runtime.onInstalled.addListener(() => {
  init();
});

chrome.runtime.onStartup?.addListener(() => {
  init();
});

chrome.storage.onChanged.addListener(() => {
  init();
});

