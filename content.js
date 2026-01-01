/* global chrome */

/**
 * content.js (publishable)
 *
 * Auto-run UNIQUEMENT sur les domaines par défaut listés dans manifest.json.
 * La logique de patch réelle est dans injected_patch.js (window.__MP_IMAGE_FIX__).
 *
 * Règles :
 * - Lecture config async (storage.sync, fallback local)
 * - Ne rien faire si disabled ou si domaine non autorisé
 * - Appliquer les changements en temps réel via chrome.storage.onChanged
 * - Zéro exception non catchée
 */

(function () {
  const PATCHER_NS = "__MP_IMAGE_FIX__";
  // If sync storage is readable but not writable (quota / policy / transient), popup.js stores a marker locally.
  // Content script must respect it so debug/enabled stay consistent on this device.
  const CONFIG_STORAGE_MODE_KEY = "mp_config_storage_mode"; // "sync" | "local"

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

  function applyDefaults(partial) {
    const cfg = {
      enabled:
        typeof partial.enabled === "boolean"
          ? partial.enabled
          : DEFAULT_CONFIG.enabled,
      debug:
        typeof partial.debug === "boolean" ? partial.debug : DEFAULT_CONFIG.debug,
      whitelist: Array.isArray(partial.whitelist)
        ? partial.whitelist
        : DEFAULT_CONFIG.whitelist,
    };

    cfg.whitelist = Array.from(
      new Set(
        cfg.whitelist
          .map((s) => String(s || "").trim().toLowerCase())
          .filter(Boolean)
      )
    );
    return cfg;
  }

  async function getConfig() {
    const keys = ["enabled", "debug", "whitelist"];
    const modeRes = await storageGet(chrome.storage.local, [CONFIG_STORAGE_MODE_KEY]);
    const mode =
      modeRes && !modeRes.__error && typeof modeRes[CONFIG_STORAGE_MODE_KEY] === "string"
        ? String(modeRes[CONFIG_STORAGE_MODE_KEY] || "")
        : "";

    if (mode === "local") {
      const localRes = await storageGet(chrome.storage.local, keys);
      if (!localRes.__error) return applyDefaults(localRes);
      const syncRes = await storageGet(chrome.storage.sync, keys);
      if (!syncRes.__error) return applyDefaults(syncRes);
      return { ...DEFAULT_CONFIG };
    }

    const syncRes = await storageGet(chrome.storage.sync, keys);
    if (!syncRes.__error) return applyDefaults(syncRes);
    const localRes = await storageGet(chrome.storage.local, keys);
    if (!localRes.__error) return applyDefaults(localRes);
    return { ...DEFAULT_CONFIG };
  }

  function runWithConfig(cfg, reason) {
    try {
      const patcher = window[PATCHER_NS];
      if (!patcher || typeof patcher.run !== "function") return;
      patcher.run({
        enabled: cfg.enabled,
        debug: cfg.debug,
        whitelist: cfg.whitelist,
        force: false,
        observe: true,
        reason: reason || "auto",
      });
    } catch {
      // no-op
    }
  }

  async function init() {
    try {
      const cfg = await getConfig();
      runWithConfig(cfg, "auto:init");
    } catch {
      // no-op
    }

    try {
      chrome.storage.onChanged.addListener((_changes, _areaName) => {
        getConfig()
          .then((cfg) => runWithConfig(cfg, "auto:storageChanged"))
          .catch(() => {});
      });
    } catch {
      // no-op
    }

    // Support popup sans permission "tabs": donner un status minimal si content script présent
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        try {
          if (message?.type === "MP_FIX_GET_STATUS") {
            const cfgPromise = getConfig().catch(() => ({ ...DEFAULT_CONFIG }));
            cfgPromise.then((cfg) => {
              const allowed = isHostAllowed(window.location.hostname, cfg.whitelist);

              sendResponse({
                host: window.location.hostname,
                enabled: !!cfg.enabled,
                debug: !!cfg.debug,
                allowed: !!allowed,
                whitelistCount: (cfg.whitelist || []).length,
              });
            });
            return true; // async sendResponse
          }
        } catch {
          // no-op
        }
        return;
      });
    } catch {
      // no-op
    }
  }

  // run_at: document_start
  init();
})();

