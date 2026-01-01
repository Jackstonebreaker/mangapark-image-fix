/* global chrome */

/**
 * mp_export_runner.js
 *
 * Injecté via chrome.scripting.executeScript (fichier local) sur /my/follows
 * pour exporter la liste "follow" via l'API interne (GraphQL) :
 * POST <origin>/apo/
 *
 * - Détecte userId de manière robuste (DOM -> scripts -> NOT_LOGGED_IN)
 * - Support 1..500+ pages, throttle 250ms, retry 3 (429/5xx) + backoff exponentiel
 * - Dedupe par comicNode.id (fallback urlPath)
 * - Écrit l'état d'export en temps réel dans chrome.storage :
 *   mp_export_state, mp_export_follows, mp_export_partial, mp_export_cancel
 *
 * Robustesse (sans changer la logique métier) :
 * - Sur erreur réseau transitoire (Cloudflare / rate-limit / 5xx / fetch rejeté / réponse invalide) :
 *   - status => "paused" (pas "error")
 *   - snapshot PARTIAL immédiat (page courante réussie + items déjà collectés)
 *   - reprise (Retry/Resume) sûre à la page suivante, sans doublons
 *
 * Publishable:
 * - Pas de libs externes
 * - Pas de remote code
 * - Pas de crash (try/catch)
 */

(function () {
  const STATE_KEY = "mp_export_state";
  const DATA_KEY = "mp_export_follows";
  const PARTIAL_KEY = "mp_export_partial";
  const CANCEL_KEY = "mp_export_cancel";
  // Debug-only diagnostic snapshot (local-only; never synced)
  const DIAGNOSTIC_KEY = "mp_export_diagnostic";
  // If sync storage is readable but not writable (quota / policy / transient), popup.js stores a marker locally.
  // Runner must respect it so it doesn't get stuck reading stale sync state.
  const CONFIG_STORAGE_MODE_KEY = "mp_config_storage_mode"; // "sync" | "local"

  const THROTTLE_MS = 250;
  const PAGE_SIZE = 36;
  const RETRY_MAX = 3;
  const REQUEST_TIMEOUT_MS = 20000;
  const PAUSE_BACKOFF_MIN_MS = 5000;
  const PAUSE_BACKOFF_MAX_MS = 15000;

  const QUERY_LITE = `
query get_user_libraryList($select: User_LibraryList_Select) {
  get_user_libraryList(select: $select) {
    paging { total pages page size }
    items {
      comicNode { id data { name urlPath } }
      # NOTE: MangaPark schema changed (2026-01): sser_lastReadChap no longer exists on User_LibraryList_Item.
      # Last-read info is optional for our export; we keep the export working even without it.
    }
  }
}
`.trim();

  /** @type {AbortController|null} */
  let currentAbort = null;
  let cancelRequested = false;
  // For diagnostics only: number of retries already attempted on the last /apo/ request.
  // 0 means "no retry happened for the last request".
  let lastRequestRetryCount = 0;

  function getOrigin() {
    try {
      return window.location.origin;
    } catch {
      return "https://mangapark.net";
    }
  }

  function getApoEndpoint() {
    return `${getOrigin()}/apo/`;
  }

  function nowIso() {
    try {
      return new Date().toISOString();
    } catch {
      return "";
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function clampInt(n, min, max) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return min;
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function computePauseBackoffMs() {
    // Aligné avec l’UX MangaPark: pause + retry après un court délai (anti-spam).
    // Random jitter pour éviter un retry de masse si plusieurs tabs/users.
    const min = PAUSE_BACKOFF_MIN_MS;
    const max = PAUSE_BACKOFF_MAX_MS;
    const span = Math.max(0, max - min);
    const jitter = Math.floor(Math.random() * (span + 1));
    return clampInt(min + jitter, min, max);
  }

  function isTransientHttpStatus(status) {
    const s = Number(status);
    if (!Number.isFinite(s)) return false;
    if (s === 429) return true; // rate-limit
    if (s >= 500 && s <= 599) return true; // backend
    if (s === 403) return true; // Cloudflare / bot checks can be transient
    if (s === 408) return true; // request timeout
    return false;
  }

  function isTransientErrorCode(code) {
    const c = String(code || "");
    if (!c) return false;
    if (c === "BAD_RESPONSE") return true;
    if (c === "NO_RESPONSE") return true;
    if (c === "NETWORK_ERROR") return true;
    if (c === "TIMEOUT") return true;
    if (c === "RETRY_COOLDOWN") return true;
    if (c.startsWith("HTTP_")) {
      const status = Number(c.slice("HTTP_".length));
      return isTransientHttpStatus(status);
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
      if (rLocal.ok) return true;
      const rSync = await storageSet(chrome.storage.sync, items);
      return rSync.ok;
    }
    const rSync = await storageSet(chrome.storage.sync, items);
    if (rSync.ok) return true;
    const rLocal = await storageSet(chrome.storage.local, items);
    return rLocal.ok;
  }

  async function updateState(patch) {
    const { data } = await getFromStorage([STATE_KEY]);
    const prev = data[STATE_KEY] && typeof data[STATE_KEY] === "object" ? data[STATE_KEY] : {};
    const next = {
      ...prev,
      ...patch,
      updated_at: nowIso(),
    };
    await setToStorage({ [STATE_KEY]: next });
    return next;
  }

  async function setCancelFlag(value) {
    await setToStorage({ [CANCEL_KEY]: !!value });
  }

  async function readCancelFlag() {
    const { data } = await getFromStorage([CANCEL_KEY]);
    return !!data[CANCEL_KEY];
  }

  function requestCancel() {
    cancelRequested = true;
    try {
      currentAbort?.abort();
    } catch {
      // no-op
    }
  }

  function installCancelListener() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync" && area !== "local") return;
        if (changes && changes[CANCEL_KEY]) {
          const v = changes[CANCEL_KEY].newValue;
          if (v === true) requestCancel();
        }
      });
    } catch {
      // no-op
    }
  }

  function extractUserIdFromDom() {
    try {
      const links = document.querySelectorAll('a[href*="/u/"]');
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/u\/(\d+)-/);
        if (m && m[1]) return m[1];
      }
    } catch {
      // no-op
    }
    return null;
  }

  function extractUserIdFromScripts() {
    // Best-effort: scan script tags for uid/userId patterns
    try {
      const scripts = document.querySelectorAll("script");
      const patterns = [
        /"uid"\s*:\s*"?(\d{1,18})"?/i,
        /"userId"\s*:\s*"?(\d{1,18})"?/i,
        /\buid\b\s*[:=]\s*"?(\d{1,18})"?/i,
        /\buserId\b\s*[:=]\s*"?(\d{1,18})"?/i,
      ];
      for (const s of scripts) {
        const txt = s.textContent || "";
        if (!txt) continue;
        for (const re of patterns) {
          const m = txt.match(re);
          if (m && m[1]) return m[1];
        }
      }
    } catch {
      // no-op
    }
    return null;
  }

  function getCurrentUserId() {
    const domId = extractUserIdFromDom();
    if (domId) return domId;
    const scriptId = extractUserIdFromScripts();
    if (scriptId) return scriptId;
    const err = new Error("NOT_LOGGED_IN");
    err.code = "NOT_LOGGED_IN";
    throw err;
  }

  async function apoFetchJson(body) {
    const signal = (() => {
      currentAbort = new AbortController();
      return currentAbort.signal;
    })();

    // Abort on timeout (treat as transient unless user cancelled)
    let timeoutId = null;
    try {
      timeoutId = setTimeout(() => {
        try {
          currentAbort?.abort();
        } catch {
          // no-op
        }
      }, REQUEST_TIMEOUT_MS);

      const res = await fetch(getApoEndpoint(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Some deployments/WAFs are stricter and expect typical AJAX/GraphQL headers.
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify(body),
        credentials: "include",
        signal,
      });

      return res;
    } finally {
      try {
        if (timeoutId) clearTimeout(timeoutId);
      } catch {
        // no-op
      }
    }
  }

  async function requestWithRetry(makeRequest, attempt = 1) {
    // Diagnostics: attempt starts at 1, so retries already performed = attempt - 1.
    lastRequestRetryCount = Math.max(0, attempt - 1);
    if (cancelRequested || (await readCancelFlag())) {
      requestCancel();
      const err = new Error("CANCELLED");
      err.code = "CANCELLED";
      throw err;
    }

    try {
      const res = await makeRequest();
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        if (attempt >= RETRY_MAX) return res;
        const backoff = Math.min(4000, 250 * Math.pow(2, attempt - 1));
        await sleep(backoff);
        return await requestWithRetry(makeRequest, attempt + 1);
      }
      return res;
    } catch (e) {
      // Abort/cancel should stop immediately
      if (e && e.code === "CANCELLED") throw e;
      if (e && e.name === "AbortError") {
        // If the user asked to cancel, stop; otherwise treat as transient timeout/network.
        if (cancelRequested || (await readCancelFlag())) throw e;
      }
      if (attempt >= RETRY_MAX) throw e;
      const backoff = Math.min(4000, 250 * Math.pow(2, attempt - 1));
      await sleep(backoff);
      return await requestWithRetry(makeRequest, attempt + 1);
    }
  }

  /**
   * Network Observer (local)
   * - Standardise la classification "RETRYABLE" vs "FATAL" sans contourner MangaPark.
   * - Ne modifie pas le flux métier : il transforme uniquement le résultat réseau en code d'erreur.
   */
  function classifyNetworkFailure({ res, jsonOk, err }) {
    // 1) Exceptions fetch / timeout / rejet
    if (err) {
      if (err.code === "CANCELLED") return { retryable: false, code: "CANCELLED" };
      if (err.name === "AbortError") return { retryable: true, code: "TIMEOUT" };
      return { retryable: true, code: "NETWORK_ERROR" };
    }

    // 2) HTTP response
    if (!res) return { retryable: true, code: "NO_RESPONSE" };
    if (!res.ok) {
      const code = `HTTP_${res.status}`;
      return { retryable: isTransientHttpStatus(res.status), code };
    }

    // 3) JSON/shape invalid (souvent HTML/CF/corruption transitoire)
    if (jsonOk === false) return { retryable: true, code: "BAD_RESPONSE" };

    return { retryable: false, code: "" };
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
    // Fallback: keep it in the network bucket (purely diagnostic)
    if (c.startsWith("HTTP_")) return "network_error";
    return "network_error";
  }

  function getApoEndpointPath() {
    try {
      const u = new URL(getApoEndpoint());
      return u.pathname || "/apo/";
    } catch {
      return "/apo/";
    }
  }

  function normalizeDiagnosticTextSnippet(text, maxLen) {
    try {
      const s = String(text ?? "");
      if (!s) return null;
      const cleaned = s.replace(/\s+/g, " ").trim();
      if (!cleaned) return null;
      const limit = typeof maxLen === "number" && Number.isFinite(maxLen) ? Math.max(64, Math.floor(maxLen)) : 2000;
      if (cleaned.length <= limit) return cleaned;
      return `${cleaned.slice(0, limit)}…`;
    } catch {
      return null;
    }
  }

  function buildRequestPayloadSummary({ operationName, variables }) {
    // Keep this safe: no cookies, no auth tokens, no userId in clear.
    try {
      const op = String(operationName || "");
      const select = variables && typeof variables === "object" ? variables.select : null;
      const safeSelect =
        select && typeof select === "object"
          ? {
              init: typeof select.init === "number" ? select.init : undefined,
              size: typeof select.size === "number" ? select.size : undefined,
              page: typeof select.page === "number" ? select.page : undefined,
              type: typeof select.type === "string" ? select.type : undefined,
              folder: select.folder === null ? null : undefined,
              userId: "(redacted)",
            }
          : null;

      return {
        operationName: op || null,
        variables: safeSelect ? { select: safeSelect } : null,
      };
    } catch {
      return { operationName: null, variables: null };
    }
  }

  function shouldWriteDiagnosticForCode(code) {
    const c = String(code || "");
    if (!c) return false;
    if (c === "CANCELLED") return false;
    // Network Observer classifications
    if (c.startsWith("HTTP_")) return true;
    if (["BAD_RESPONSE", "NO_RESPONSE", "NETWORK_ERROR", "TIMEOUT"].includes(c)) return true;
    return false;
  }

  async function writeDiagnosticReportToLocal(report) {
    // Strictly local + best-effort (never block export)
    try {
      if (!report || typeof report !== "object") return;
      await storageSet(chrome.storage.local, { [DIAGNOSTIC_KEY]: report });
    } catch {
      // no-op
    }
  }

  async function writeNetworkDiagnosticSnapshot({
    status,
    lastSuccessPage,
    totalPages,
    collectedItemsCount,
    errorCode,
    errorTimestampIso,
    retryAfterMs,
    exportId,
    retryCount,
    requestPayloadSummary,
    responseSnippet,
    responseContentType,
  }) {
    try {
      if (!shouldWriteDiagnosticForCode(errorCode) && status !== "paused") return;
      const httpStatus = safeParseHttpStatusFromCode(errorCode);
      const retrySuggestedAfterSeconds =
        typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? Math.max(1, Math.round(retryAfterMs / 1000))
          : null;

      await writeDiagnosticReportToLocal({
        exportId: String(exportId || ""),
        status: String(status || "error"),
        lastSuccessPage: typeof lastSuccessPage === "number" ? lastSuccessPage : 0,
        totalPages: typeof totalPages === "number" ? totalPages : null,
        collectedItemsCount: typeof collectedItemsCount === "number" ? collectedItemsCount : 0,
        lastError: {
          type: mapErrorCodeToDiagnosticType(errorCode),
          endpoint: getApoEndpointPath(),
          httpStatus: httpStatus != null ? httpStatus : null,
          timestamp: String(errorTimestampIso || nowIso()),
        },
        retrySuggestedAfterSeconds,
        retryCount: typeof retryCount === "number" ? retryCount : 0,
        // Debug-only enrichment (still local-only): helps diagnose HTTP 400/GraphQL changes without DevTools.
        request: requestPayloadSummary && typeof requestPayloadSummary === "object" ? requestPayloadSummary : null,
        response: {
          contentType: typeof responseContentType === "string" ? responseContentType : null,
          bodySnippet: normalizeDiagnosticTextSnippet(responseSnippet, 2000),
        },
      });
    } catch {
      // no-op
    }
  }

  function dedupePush(map, item) {
    const key = item.comic_id || item.mangapark_url;
    if (!key) return;
    if (map.has(key)) return;
    map.set(key, item);
  }

  function isValidPartialPayload(payload) {
    try {
      if (!payload || typeof payload !== "object") return false;
      if (!payload.meta || typeof payload.meta !== "object") return false;
      if (!Array.isArray(payload.items) || payload.items.length === 0) return false;
      const page = payload.meta.page;
      if (typeof page !== "number" || !Number.isFinite(page) || page < 1) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function readPartialPayload() {
    const { data } = await getFromStorage([PARTIAL_KEY]);
    const payload = data[PARTIAL_KEY];
    return isValidPartialPayload(payload) ? payload : null;
  }

  function hydrateDedupeFromPartial(dedupe, partialPayload) {
    try {
      const arr = Array.isArray(partialPayload?.items) ? partialPayload.items : [];
      for (const it of arr) {
        if (!it || typeof it !== "object") continue;
        const key = it.comic_id || it.mangapark_url;
        if (!key) continue;
        if (!dedupe.has(key)) dedupe.set(key, it);
      }
    } catch {
      // no-op
    }
  }

  function mapItemToDataset(row) {
    try {
      const comic = row?.comicNode;
      const comicId = comic?.id ? String(comic.id) : "";
      const title = comic?.data?.name ? String(comic.data.name) : "";
      const urlPath = comic?.data?.urlPath ? String(comic.data.urlPath) : "";
      const mangaparkUrl = urlPath ? `${getOrigin()}${urlPath}` : "";

      const last = row?.sser_lastReadChap;
      const chap = last?.chapterNode;
      const lastSerial = chap?.data?.serial != null ? String(chap.data.serial) : "";
      const lastUrlPath = chap?.data?.urlPath ? String(chap.data.urlPath) : "";
      const lastUrl = lastUrlPath ? `${getOrigin()}${lastUrlPath}` : "";

      return {
        title,
        mangapark_url: mangaparkUrl,
        comic_id: comicId,
        last_read_serial: lastSerial,
        last_read_url: lastUrl,
        captured_at: nowIso(),
      };
    } catch {
      return null;
    }
  }

  async function fetchPage(userId, page) {
    const variables = {
      select: {
        init: 0,
        size: PAGE_SIZE,
        page,
        type: "follow",
        folder: null,
        userId: String(userId),
      },
    };

    // Include operationName for stricter GraphQL gateways (helps avoid HTTP 400 on some setups).
    const body = { operationName: "get_user_libraryList", query: QUERY_LITE, variables };
    const res = await requestWithRetry(() => apoFetchJson(body));
    return res;
  }

  function buildPartialPayload({ status, page, pages, total, userId, items, lastError }) {
    return {
      meta: {
        status: String(status || "running"),
        page: typeof page === "number" ? page : 0,
        pages: typeof pages === "number" ? pages : null,
        total: typeof total === "number" ? total : null,
        userId: userId ? String(userId) : "",
        source_origin: getOrigin(),
        last_error: lastError && typeof lastError === "object" ? lastError : null,
        updated_at: nowIso(),
      },
      items: Array.isArray(items) ? items : [],
    };
  }

  async function persistPartialSnapshot({ status, page, pages, total, userId, dedupe, lastError }) {
    const items = Array.from(dedupe.values());
    await setToStorage({
      [PARTIAL_KEY]: buildPartialPayload({ status, page, pages, total, userId, items, lastError }),
    });
  }

  async function pauseExport({ reason, page, pages, total, userId, dedupe }) {
    const at = nowIso();
    const backoffMs = computePauseBackoffMs();
    const retryAtMs = Date.now() + backoffMs;
    const lastError = {
      code: String(reason || "NETWORK_ERROR"),
      retryable: true,
      at,
      retry_after_ms: backoffMs,
      retry_at: new Date(retryAtMs).toISOString(),
    };

    // Save snapshot first (never lose items already collected)
    await persistPartialSnapshot({ status: "paused", page, pages, total, userId, dedupe, lastError });

    const next = await updateState({
      status: "paused",
      page,
      pages,
      collected: dedupe.size,
      total,
      error: lastError.code,
      last_error: lastError,
    });

    // Save diagnostic snapshot (local-only; debug feature, no external traffic)
    await writeNetworkDiagnosticSnapshot({
      status: "paused",
      lastSuccessPage: typeof page === "number" ? page : 0,
      totalPages: typeof pages === "number" ? pages : null,
      collectedItemsCount: dedupe.size,
      errorCode: lastError.code,
      errorTimestampIso: lastError.at,
      retryAfterMs: lastError.retry_after_ms,
      exportId: next?.started_at || next?.updated_at || at,
      retryCount: lastRequestRetryCount,
      requestPayloadSummary: null,
      responseSnippet: null,
      responseContentType: null,
    });
  }

  async function waitForRetryWindowIfNeeded() {
    try {
      const { data } = await getFromStorage([STATE_KEY]);
      const st = data[STATE_KEY] && typeof data[STATE_KEY] === "object" ? data[STATE_KEY] : null;
      if (!st || st.status !== "paused") return;
      const le = st.last_error && typeof st.last_error === "object" ? st.last_error : null;
      const retryAt = le && typeof le.retry_at === "string" ? Date.parse(le.retry_at) : NaN;
      if (!Number.isFinite(retryAt)) return;
      const ms = retryAt - Date.now();
      if (ms <= 0) return;

      // Respect anti-spam window, but keep cancel responsive.
      const slice = 250;
      let remaining = ms;
      while (remaining > 0) {
        if (cancelRequested || (await readCancelFlag())) {
          requestCancel();
          const err = new Error("CANCELLED");
          err.code = "CANCELLED";
          throw err;
        }
        await sleep(Math.min(slice, remaining));
        remaining -= slice;
      }
    } catch (e) {
      // If anything goes wrong here, do not block export start.
      // (Never crash; best-effort only.)
      if (e && e.code === "CANCELLED") throw e;
    }
  }

  async function exportAllFollowsViaApo({ resumeFromPage }) {
    // Reset cancel flag on start
    await setCancelFlag(false);
    cancelRequested = false;
    installCancelListener();

    const startedAt = nowIso();
    // When resuming, we MUST preserve previously collected items.
    // We use PARTIAL_KEY as the source of truth for resuming safely (no loss).
    const partial = await readPartialPayload().catch(() => null);
    const isResume = !!(resumeFromPage && resumeFromPage > 1);
    if (isResume && !partial) {
      await updateState({
        status: "error",
        error: "RESUME_UNAVAILABLE",
        started_at: startedAt,
      });
      return { ok: false, error: "RESUME_UNAVAILABLE" };
    }

    const userId = getCurrentUserId();

    const dedupe = new Map();
    let pages = null;
    let total = null;

    // Hydrate already collected items for resume (no duplicates thanks to Map keying).
    let startPage = 1;
    if (isResume && partial) {
      hydrateDedupeFromPartial(dedupe, partial);
      startPage = (typeof partial.meta.page === "number" && partial.meta.page >= 1) ? partial.meta.page + 1 : 1;
    } else {
      startPage = resumeFromPage && resumeFromPage > 0 ? resumeFromPage : 1;
    }

    // Initialize state for UI using the true starting point and preserved collected count.
    await updateState({
      status: "running",
      page: Math.max(0, startPage - 1),
      pages: null,
      collected: dedupe.size,
      total: null,
      started_at: startedAt,
      last_progress_at: startedAt,
      error: null,
    });

    let lastGoodPage = Math.max(0, startPage - 1);

    for (let p = startPage; ; p += 1) {
      if (cancelRequested || (await readCancelFlag())) {
        requestCancel();
        await updateState({ status: "idle", error: "CANCELLED" });
        return { ok: false, cancelled: true };
      }

      // Fetch page (Network Observer -> pause on retryable failures)
      let res = null;
      let json = null;
      let jsonOk = null;
      let fetchErr = null;
      let responseContentType = null;
      let responseSnippet = null;
      const requestPayloadSummary = buildRequestPayloadSummary({
        operationName: "get_user_libraryList",
        variables: {
          select: {
            init: 0,
            size: PAGE_SIZE,
            page: p,
            type: "follow",
            folder: null,
            userId: "(redacted)",
          },
        },
      });

      try {
        res = await fetchPage(userId, p);
      } catch (e) {
        fetchErr = e;
      }

      try {
        if (!fetchErr && res) {
          responseContentType = res.headers && typeof res.headers.get === "function" ? (res.headers.get("content-type") || "") : "";
        }
      } catch {
        // no-op
      }

      if (!fetchErr && res && res.ok) {
        // Keep a body snapshot for diagnostics ONLY if JSON parsing fails (use clone so we don't consume the body).
        let clonedText = null;
        try {
          clonedText = await res.clone().text();
        } catch {
          clonedText = null;
        }
        json = await res.json().catch(() => null);
        const payload = json?.data?.get_user_libraryList;
        const paging = payload?.paging;
        jsonOk = !!(paging && typeof paging.pages === "number");
        if (jsonOk === false) {
          responseSnippet = clonedText;
        }
      } else if (!fetchErr && res && !res.ok) {
        jsonOk = null;
        // On HTTP errors, capture a short response snippet for diagnostics (best-effort).
        try {
          responseSnippet = await res.text();
        } catch {
          responseSnippet = null;
        }
      }

      const failure = classifyNetworkFailure({ res, jsonOk, err: fetchErr });
      if (failure.code) {
        if (failure.code === "CANCELLED") throw fetchErr || new Error("CANCELLED");
        if (failure.retryable) {
          await pauseExport({ reason: failure.code, page: lastGoodPage, pages, total, userId, dedupe });
          return { ok: false, paused: true };
        }
        const next = await updateState({ status: "error", error: failure.code });
        await writeNetworkDiagnosticSnapshot({
          status: "error",
          lastSuccessPage: typeof lastGoodPage === "number" ? lastGoodPage : 0,
          totalPages: typeof pages === "number" ? pages : null,
          collectedItemsCount: dedupe.size,
          errorCode: failure.code,
          errorTimestampIso: nowIso(),
          retryAfterMs: null,
          exportId: next?.started_at || next?.updated_at || nowIso(),
          retryCount: lastRequestRetryCount,
          requestPayloadSummary,
          responseSnippet,
          responseContentType,
        });
        return { ok: false, error: failure.code };
      }

      const payload = json?.data?.get_user_libraryList;
      const paging = payload?.paging;
      const items = Array.isArray(payload?.items) ? payload.items : [];

      pages = paging.pages;
      total = paging.total;

      // Map items
      for (const row of items) {
        const mapped = mapItemToDataset(row);
        if (!mapped) continue;
        // Dedup key preference: comic_id else url
        const key = mapped.comic_id || mapped.mangapark_url;
        if (!key) continue;
        if (!dedupe.has(key)) {
          dedupe.set(key, mapped);
        }
      }

      const collected = dedupe.size;
      await updateState({
        status: "running",
        page: p,
        pages,
        collected,
        total,
        last_progress_at: nowIso(),
        error: null,
      });

      lastGoodPage = p;

      // Save partial every 5 pages
      if (p % 5 === 0) {
        await persistPartialSnapshot({ status: "running", page: p, pages, total, userId, dedupe, lastError: null });
      }

      if (pages != null && p >= pages) break;
      await sleep(THROTTLE_MS);
    }

    const finalItems = Array.from(dedupe.values());
    const capturedAt = nowIso();

    await setToStorage({
      [DATA_KEY]: {
        meta: {
          captured_at: capturedAt,
          source_origin: getOrigin(),
          userId: String(userId),
          total_items: finalItems.length,
        },
        items: finalItems,
      },
      [PARTIAL_KEY]: null,
    });

    await updateState({
      status: "done",
      pages,
      collected: finalItems.length,
      total,
      error: null,
    });

    return { ok: true, items: finalItems.length };
  }

  async function runExport() {
    try {
      // Read existing state to support resume
      const { data } = await getFromStorage([STATE_KEY]);
      const st = data[STATE_KEY] && typeof data[STATE_KEY] === "object" ? data[STATE_KEY] : null;
      const lastPage = st && typeof st.page === "number" ? st.page : 0;
      const lastPages = st && typeof st.pages === "number" ? st.pages : null;
      const status = st && typeof st.status === "string" ? st.status : "idle";

      // If already running, do not start another loop
      if (status === "running") return;

      // If we paused due to a retryable error, respect the anti-spam window (5–15s) before retry.
      if (status === "paused") {
        await waitForRetryWindowIfNeeded();
      }

      // Resume logic (safe):
      // - If PARTIAL exists, we resume from partial.meta.page+1 and preserve partial.items
      // - Otherwise, start from page 1
      const partial = await readPartialPayload().catch(() => null);
      if (partial) {
        const p = typeof partial.meta.page === "number" ? partial.meta.page : 0;
        const resumeFrom = p >= 1 ? p + 1 : 1;
        await exportAllFollowsViaApo({ resumeFromPage: resumeFrom });
        return;
      }

      // Fallback to previous state only for deciding between start vs resume (resume will be rejected without PARTIAL)
      const resumeFrom = lastPage && lastPages && lastPage < lastPages ? lastPage + 1 : 1;
      await exportAllFollowsViaApo({ resumeFromPage: resumeFrom });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      const code = e && e.code ? String(e.code) : "";
      const error = code || msg || "UNKNOWN";
      // If we already have a partial payload, prefer "paused" on transient network errors.
      // (prevents losing resume after a throw outside the loop)
      try {
        const partial = await readPartialPayload().catch(() => null);
        if (partial && isTransientErrorCode(error)) {
          const at = nowIso();
          const backoffMs = computePauseBackoffMs();
          const retryAtMs = Date.now() + backoffMs;
          const lastError = {
            code: error,
            retryable: true,
            at,
            retry_after_ms: backoffMs,
            retry_at: new Date(retryAtMs).toISOString(),
          };
          const next = await updateState({ status: "paused", error, last_error: lastError });
          await writeNetworkDiagnosticSnapshot({
            status: "paused",
            lastSuccessPage: typeof partial?.meta?.page === "number" ? partial.meta.page : 0,
            totalPages: typeof partial?.meta?.pages === "number" ? partial.meta.pages : null,
            collectedItemsCount: Array.isArray(partial?.items) ? partial.items.length : 0,
            errorCode: error,
            errorTimestampIso: at,
            retryAfterMs: backoffMs,
            exportId: next?.started_at || next?.updated_at || at,
            retryCount: lastRequestRetryCount,
          });
          return;
        }
      } catch {
        // ignore
      }
      const next = await updateState({ status: "error", error });
      if (shouldWriteDiagnosticForCode(error)) {
        await writeNetworkDiagnosticSnapshot({
          status: "error",
          lastSuccessPage: typeof next?.page === "number" ? next.page : 0,
          totalPages: typeof next?.pages === "number" ? next.pages : null,
          collectedItemsCount: typeof next?.collected === "number" ? next.collected : 0,
          errorCode: error,
          errorTimestampIso: nowIso(),
          retryAfterMs: null,
          exportId: next?.started_at || next?.updated_at || nowIso(),
          retryCount: lastRequestRetryCount,
        });
      }
    }
  }

  // Expose a minimal API for popup-triggered control if needed
  try {
    if (typeof window !== "undefined") {
      window.__MP_EXPORT_RUNNER__ = {
        run: runExport,
        cancel: async () => {
          requestCancel();
          await setCancelFlag(true);
          await updateState({ status: "idle", error: "CANCELLED" });
        },
      };
      // Export helpers for Node tests (CommonJS require)
      if (typeof module === "object" && module && module.exports) {
        module.exports = {
          __test__: {
            isTransientHttpStatus,
            isTransientErrorCode,
            buildPartialPayload,
            computePauseBackoffMs,
            classifyNetworkFailure,
          },
        };
      }
    } else if (typeof module === "object" && module && module.exports) {
      module.exports = {
        __test__: {
          isTransientHttpStatus,
          isTransientErrorCode,
          buildPartialPayload,
          computePauseBackoffMs,
          classifyNetworkFailure,
        },
      };
    }
  } catch {
    // no-op
  }

  // Auto-run when injected (browser only). In Node tests, `chrome` doesn't exist.
  try {
    if (typeof window !== "undefined" && typeof chrome !== "undefined" && chrome?.storage) {
      runExport();
    }
  } catch {
    // no-op
  }
})();

