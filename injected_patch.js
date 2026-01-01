/* global chrome */

/**
 * injected_patch.js
 *
 * Bibliothèque de patch réutilisable :
 * - utilisée par le content script (auto-run sur domaines supportés)
 * - utilisée via chrome.scripting.executeScript (bouton "Fix this page now")
 *
 * Spécifications :
 * - Patch uniquement si host source commence par s00..s10 ET pathname commence par "/media/"
 * - Réécriture stricte: `${location.protocol}//${location.host}${url.pathname}`
 * - Patch src / srcset + attributs lazy (data-src, data-original, data-lazy-src, data-echo, data-url)
 * - Ignore data:, blob:, chrome-extension:, about: et URLs invalides
 * - MutationObserver (childList/subtree + attributes), sans polling
 * - Debug: logs structurés [MP FIX] avec résumé + exemples (max 10)
 * - Robuste: try/catch, jamais throw
 */

(function () {
  const NAMESPACE = "__MP_IMAGE_FIX__";
  const LOG_PREFIX = "[MP FIX]";

  // Hosts sources attendus : s00..s10 (case-insensitive)
  const TARGET_HOST_REGEX = /^s(?:0\d|10)\./i;

  // Attributs "lazy" courants à patcher en plus de src/srcset
  const LAZY_ATTRS = [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-echo",
    "data-url",
  ];

  // Protocoles/schémas à ignorer
  const FORBIDDEN_SCHEME_REGEX = /^(data:|blob:|about:|chrome-extension:)/i;

  function safeNow() {
    try {
      return Date.now();
    } catch {
      return 0;
    }
  }

  function createLogger(debugEnabled) {
    const state = {
      debug: !!debugEnabled,
      exampleLimit: 10,
      examples: [],
      exampleCount: 0,
      suppressed: 0,
      lastRunTs: safeNow(),
    };

    function log(event, payload) {
      if (!state.debug) return;
      try {
        console.log(LOG_PREFIX, event, payload);
      } catch {
        // no-op
      }
    }

    function recordExample(kind, from, to) {
      if (!state.debug) return;
      state.exampleCount += 1;
      if (state.examples.length < state.exampleLimit) {
        state.examples.push({ kind, from, to });
      } else {
        state.suppressed += 1;
      }
    }

    function flushSummary(summary) {
      if (!state.debug) return;
      log("summary", {
        ...summary,
        examples: state.examples,
        examplesShown: state.examples.length,
        examplesSuppressed: state.suppressed,
      });
      // reset examples for next run
      state.examples = [];
      state.exampleCount = 0;
      state.suppressed = 0;
      state.lastRunTs = safeNow();
    }

    return { log, recordExample, flushSummary, state };
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

  function normalizeUrlMaybe(urlString) {
    if (!urlString) return null;
    const s = String(urlString).trim();
    if (!s) return null;
    if (FORBIDDEN_SCHEME_REGEX.test(s)) return null;
    return s;
  }

  function getFixedUrl(urlString) {
    const raw = normalizeUrlMaybe(urlString);
    if (!raw) return null;

    try {
      // Support des URLs relatives
      const url = new URL(raw, window.location.href);

      // Uniquement hosts s00..s10 ET pathname /media/...
      if (!TARGET_HOST_REGEX.test(url.hostname)) return null;
      if (!url.pathname || !url.pathname.startsWith("/media/")) return null;

      const newUrl = `${window.location.protocol}//${window.location.host}${url.pathname}`;
      if (newUrl === raw) return null;
      return newUrl;
    } catch {
      return null;
    }
  }

  function parseAndFixSrcset(srcsetValue, logger) {
    const raw = String(srcsetValue || "").trim();
    if (!raw) return { changed: false, value: raw, patchOps: 0 };

    const parts = raw.split(",");
    let changed = false;
    let patchOps = 0;

    const newParts = parts.map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;

      const [urlToken, ...descriptors] = trimmed.split(/\s+/);
      const fixed = getFixedUrl(urlToken);
      if (!fixed) return trimmed;

      changed = true;
      patchOps += 1;
      if (logger) logger.recordExample("srcset", urlToken, fixed);
      return [fixed, ...descriptors].join(" ");
    });

    return { changed, value: newParts.join(", "), patchOps };
  }

  function patchAttribute(el, attrName, logger) {
    let patchOps = 0;
    try {
      const raw = el.getAttribute(attrName);
      const fixed = getFixedUrl(raw);
      if (fixed) {
        el.setAttribute(attrName, fixed);
        patchOps += 1;
        if (logger) logger.recordExample(attrName, raw, fixed);
      }
    } catch {
      // no-op
    }
    return patchOps;
  }

  function patchImage(img, logger) {
    let patchOps = 0;
    let patched = false;

    // 1) src (préférer l'attribut brut)
    try {
      const rawSrc = img.getAttribute("src");
      const fixed = getFixedUrl(rawSrc) || getFixedUrl(img.src);
      if (fixed) {
        // anti-boucle: ne pas réécrire si déjà sur host courant
        img.setAttribute("src", fixed);
        patchOps += 1;
        patched = true;
        if (logger) logger.recordExample("src", rawSrc || img.src, fixed);
      }
    } catch {
      // no-op
    }

    // 2) srcset
    try {
      const rawSrcset = img.getAttribute("srcset");
      if (rawSrcset) {
        const res = parseAndFixSrcset(rawSrcset, logger);
        if (res.changed) {
          img.setAttribute("srcset", res.value);
          patchOps += res.patchOps;
          patched = true;
        }
      }
    } catch {
      // no-op
    }

    // 3) lazy attrs
    for (const attr of LAZY_ATTRS) {
      const ops = patchAttribute(img, attr, logger);
      if (ops) {
        patchOps += ops;
        patched = true;
      }
    }

    return { patched, patchOps };
  }

  function scan(root, logger, reason) {
    let imgsSeen = 0;
    let imagesPatched = 0;
    let patchOps = 0;

    try {
      const imgs = root.querySelectorAll ? root.querySelectorAll("img") : [];
      imgsSeen = imgs.length;
      imgs.forEach((img) => {
        const r = patchImage(img, logger);
        patchOps += r.patchOps;
        if (r.patched) imagesPatched += 1;
      });
    } catch {
      // no-op
    }

    if (logger) {
      logger.flushSummary({ reason, imgsSeen, imagesPatched, patchOps });
    }
    return { imgsSeen, imagesPatched, patchOps };
  }

  function createRunner() {
    const state = {
      observer: null,
      running: false,
      lastConfig: null,
    };

    function stop() {
      try {
        state.observer?.disconnect();
      } catch {
        // no-op
      }
      state.observer = null;
      state.running = false;
    }

    function start({ debug, observe, reason }) {
      const logger = createLogger(debug);

      // Scan initial
      scan(document, logger, reason || "initial");

      if (!observe) return { startedObserver: false };
      if (state.running) return { startedObserver: false };

      const root = document.documentElement;
      if (!root) return { startedObserver: false };

      try {
        state.observer = new MutationObserver((mutations) => {
          // batch minimal : patch seulement éléments ajoutés / attributs modifiés
          const batchLogger = createLogger(debug);
          let imgsSeen = 0;
          let imagesPatched = 0;
          let patchOps = 0;

          try {
            for (const m of mutations) {
              if (m.type === "childList") {
                for (const node of m.addedNodes) {
                  if (node.nodeType !== Node.ELEMENT_NODE) continue;
                  if (node.tagName === "IMG") {
                    imgsSeen += 1;
                    const r = patchImage(node, batchLogger);
                    patchOps += r.patchOps;
                    if (r.patched) imagesPatched += 1;
                  } else if (node.querySelectorAll) {
                    const imgs = node.querySelectorAll("img");
                    imgsSeen += imgs.length;
                    imgs.forEach((img) => {
                      const r = patchImage(img, batchLogger);
                      patchOps += r.patchOps;
                      if (r.patched) imagesPatched += 1;
                    });
                  }
                }
              } else if (m.type === "attributes" && m.target?.tagName === "IMG") {
                const a = m.attributeName;
                if (a === "src" || a === "srcset" || LAZY_ATTRS.includes(a)) {
                  imgsSeen += 1;
                  const r = patchImage(m.target, batchLogger);
                  patchOps += r.patchOps;
                  if (r.patched) imagesPatched += 1;
                }
              }
            }
          } catch {
            // no-op
          }

          if (imgsSeen > 0) {
            batchLogger.flushSummary({
              reason: "mutation",
              imgsSeen,
              imagesPatched,
              patchOps,
            });
          }
        });

        state.observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "srcset", ...LAZY_ATTRS],
        });

        state.running = true;
        return { startedObserver: true };
      } catch {
        stop();
        return { startedObserver: false };
      }
    }

    /**
     * Run patcher.
     * @param {{
     *  enabled?: boolean,
     *  debug?: boolean,
     *  whitelist?: string[],
     *  force?: boolean,
     *  observe?: boolean,
     *  reason?: string
     * }} opts
     */
    function run(opts) {
      const options = opts || {};
      const enabled = options.enabled !== false; // default true
      const debug = !!options.debug;
      const whitelist = Array.isArray(options.whitelist) ? options.whitelist : [];
      const force = !!options.force;
      const observe = options.observe !== false; // default true

      const allowed = force ? true : isHostAllowed(window.location.hostname, whitelist);
      if (!enabled || !allowed) {
        stop();
        return { ran: false, enabled, allowed };
      }

      // (Re)start
      stop();
      start({ debug, observe, reason: options.reason || (force ? "manual" : "auto") });
      return { ran: true, enabled, allowed };
    }

    return { run, stop };
  }

  // Export global
  if (!window[NAMESPACE]) {
    window[NAMESPACE] = createRunner();
  }
})();

