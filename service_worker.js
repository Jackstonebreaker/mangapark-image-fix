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

// MangaDex (advanced/opt-in): token stored in session only (not sync) for safety.
const MD_AUTH_SETTINGS_KEY = "md_auth_settings"; // local: { clientId, clientSecret, username }
const MD_AUTH_SESSION_KEY = "md_auth_session"; // session: { accessToken, refreshToken, expiresAtIso }

const MD_AUTH_TOKEN_URL =
  "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token";
const MD_API_BASE = "https://api.mangadex.org";

// MangaDex background auto-follow batch
const MD_FOLLOW_BATCH_STATE_KEY = "md_follow_batch_state"; // local
const MD_FOLLOW_BATCH_QUEUE_KEY = "md_follow_batch_queue"; // local: string[]
const MD_FOLLOW_BATCH_CANCEL_KEY = "md_follow_batch_cancel"; // local: boolean
const MD_FOLLOW_BATCH_ALARM = "md_follow_batch_alarm";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function runtimeSendResponseSafe(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    // no-op
  }
}

async function mdGetSettingsLocal() {
  const res = await storageGet(chrome.storage.local, [MD_AUTH_SETTINGS_KEY]);
  if (res.__error) return null;
  const st = res[MD_AUTH_SETTINGS_KEY];
  if (!st || typeof st !== "object") return null;
  return {
    clientId: typeof st.clientId === "string" ? st.clientId : "",
    clientSecret: typeof st.clientSecret === "string" ? st.clientSecret : "",
    username: typeof st.username === "string" ? st.username : "",
  };
}

async function mdSetSettingsLocal(settings) {
  const safe = {
    clientId: String(settings?.clientId || ""),
    clientSecret: String(settings?.clientSecret || ""),
    username: String(settings?.username || ""),
  };
  await storageSet(chrome.storage.local, { [MD_AUTH_SETTINGS_KEY]: safe });
  return safe;
}

async function mdGetSession() {
  const area = chrome.storage.session || chrome.storage.local;
  const res = await storageGet(area, [MD_AUTH_SESSION_KEY]);
  if (res.__error) return null;
  const st = res[MD_AUTH_SESSION_KEY];
  if (!st || typeof st !== "object") return null;
  return {
    accessToken: typeof st.accessToken === "string" ? st.accessToken : "",
    refreshToken: typeof st.refreshToken === "string" ? st.refreshToken : "",
    expiresAtIso: typeof st.expiresAtIso === "string" ? st.expiresAtIso : "",
  };
}

async function mdSetSession(session) {
  const area = chrome.storage.session || chrome.storage.local;
  const safe = {
    accessToken: String(session?.accessToken || ""),
    refreshToken: String(session?.refreshToken || ""),
    expiresAtIso: String(session?.expiresAtIso || ""),
  };
  await storageSet(area, { [MD_AUTH_SESSION_KEY]: safe });
  return safe;
}

async function mdClearSession() {
  const area = chrome.storage.session || chrome.storage.local;
  await storageSet(area, { [MD_AUTH_SESSION_KEY]: null });
}

function mdIsTokenValid(session) {
  try {
    const t = Date.parse(String(session?.expiresAtIso || ""));
    if (!Number.isFinite(t)) return false;
    // Consider invalid if expiring in <60s
    return Date.now() + 60000 < t;
  } catch {
    return false;
  }
}

async function mdTokenRequest(form) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form || {})) {
    if (v == null) continue;
    body.set(k, String(v));
  }
  const res = await fetch(MD_AUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

async function mdLoginPasswordFlow({ clientId, clientSecret, username, password }) {
  const r = await mdTokenRequest({
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
  });
  if (!r.ok) {
    const err = r?.json?.error_description || r?.json?.error || `HTTP_${r.status}`;
    throw new Error(String(err));
  }
  const accessToken = r?.json?.access_token ? String(r.json.access_token) : "";
  const refreshToken = r?.json?.refresh_token ? String(r.json.refresh_token) : "";
  const expiresIn = r?.json?.expires_in != null ? Number(r.json.expires_in) : 0;
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("bad_token_response");
  }
  const expiresAtIso = new Date(Date.now() + expiresIn * 1000).toISOString();
  return { accessToken, refreshToken, expiresAtIso };
}

async function mdRefreshTokenFlow({ clientId, clientSecret, refreshToken }) {
  const r = await mdTokenRequest({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  if (!r.ok) {
    const err = r?.json?.error_description || r?.json?.error || `HTTP_${r.status}`;
    throw new Error(String(err));
  }
  const accessToken = r?.json?.access_token ? String(r.json.access_token) : "";
  const newRefreshToken = r?.json?.refresh_token ? String(r.json.refresh_token) : refreshToken;
  const expiresIn = r?.json?.expires_in != null ? Number(r.json.expires_in) : 0;
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("bad_token_response");
  }
  const expiresAtIso = new Date(Date.now() + expiresIn * 1000).toISOString();
  return { accessToken, refreshToken: newRefreshToken, expiresAtIso };
}

async function mdEnsureAccessToken() {
  const sess = await mdGetSession();
  if (sess && mdIsTokenValid(sess) && sess.accessToken) return sess.accessToken;

  // try refresh
  const settings = await mdGetSettingsLocal();
  if (!settings?.clientId || !settings?.clientSecret) throw new Error("not_configured");
  if (sess && sess.refreshToken) {
    const next = await mdRefreshTokenFlow({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: sess.refreshToken,
    });
    await mdSetSession(next);
    return next.accessToken;
  }
  throw new Error("not_logged_in");
}

async function mdFollowManga(mangaId) {
  const id = String(mangaId || "").trim();
  if (!id) throw new Error("missing_manga_id");
  const token = await mdEnsureAccessToken();
  const res = await fetch(`${MD_API_BASE}/manga/${encodeURIComponent(id)}/follow`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const msg =
      (j && j.errors && Array.isArray(j.errors) && j.errors[0] && j.errors[0].detail) ||
      `HTTP_${res.status}`;
    throw new Error(String(msg));
  }
  return true;
}

async function mdGetBatchState() {
  const res = await storageGet(chrome.storage.local, [MD_FOLLOW_BATCH_STATE_KEY]);
  if (res.__error) return null;
  const st = res[MD_FOLLOW_BATCH_STATE_KEY];
  if (!st || typeof st !== "object") return null;
  return st;
}

async function mdSetBatchState(patch) {
  const prev = (await mdGetBatchState()) || {};
  const next = {
    ...prev,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await storageSet(chrome.storage.local, { [MD_FOLLOW_BATCH_STATE_KEY]: next });
  return next;
}

async function mdGetBatchQueue() {
  const res = await storageGet(chrome.storage.local, [MD_FOLLOW_BATCH_QUEUE_KEY]);
  if (res.__error) return [];
  const q = res[MD_FOLLOW_BATCH_QUEUE_KEY];
  return Array.isArray(q) ? q.map((x) => String(x || "")).filter(Boolean) : [];
}

async function mdSetBatchQueue(queue) {
  const q = Array.isArray(queue) ? queue.map((x) => String(x || "")).filter(Boolean) : [];
  await storageSet(chrome.storage.local, { [MD_FOLLOW_BATCH_QUEUE_KEY]: q });
  return q;
}

async function mdIsBatchCancelled() {
  const res = await storageGet(chrome.storage.local, [MD_FOLLOW_BATCH_CANCEL_KEY]);
  if (res.__error) return false;
  return !!res[MD_FOLLOW_BATCH_CANCEL_KEY];
}

async function mdSetBatchCancel(v) {
  await storageSet(chrome.storage.local, { [MD_FOLLOW_BATCH_CANCEL_KEY]: !!v });
}

function alarmsCreateSafe(name, info) {
  try {
    chrome.alarms.create(name, info);
  } catch {
    // no-op
  }
}

function alarmsClearSafe(name) {
  try {
    chrome.alarms.clear(name);
  } catch {
    // no-op
  }
}

async function mdBatchTick() {
  // Process a chunk from the queue, then reschedule if needed.
  const cancelled = await mdIsBatchCancelled();
  if (cancelled) {
    await mdSetBatchState({ status: "stopped" });
    alarmsClearSafe(MD_FOLLOW_BATCH_ALARM);
    return;
  }

  const st = (await mdGetBatchState()) || {};
  const status = String(st.status || "idle");
  if (status !== "running") return;

  let queue = await mdGetBatchQueue();
  const total = typeof st.total === "number" ? st.total : queue.length;
  let done = typeof st.done === "number" ? st.done : 0;

  // Process up to N per tick to avoid long-running handler.
  const chunkSize = 15;
  const throttleMs = typeof st.throttleMs === "number" ? st.throttleMs : 800;

  const toProcess = queue.slice(0, chunkSize);
  queue = queue.slice(chunkSize);

  for (const id of toProcess) {
    if (await mdIsBatchCancelled()) {
      await mdSetBatchQueue(queue);
      await mdSetBatchState({ status: "stopped", total, done });
      alarmsClearSafe(MD_FOLLOW_BATCH_ALARM);
      return;
    }

    try {
      await mdFollowManga(id);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      await mdSetBatchState({ lastError: msg });
      // continue
    }

    done += 1;
    await mdSetBatchState({ total, done });
    await sleep(Math.max(200, throttleMs));
  }

  await mdSetBatchQueue(queue);

  if (!queue.length) {
    await mdSetBatchState({ status: "done", total, done });
    alarmsClearSafe(MD_FOLLOW_BATCH_ALARM);
    return;
  }

  // Reschedule next tick soon (Chrome may clamp to >= 1 minute, but will still progress).
  alarmsCreateSafe(MD_FOLLOW_BATCH_ALARM, { delayInMinutes: 0.2 });
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== MD_FOLLOW_BATCH_ALARM) return;
    mdBatchTick().catch(() => {});
  });
} catch {
  // no-op
}

// Background message API for the migration page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message && typeof message === "object" ? message : {};
  const type = String(msg.type || "");

  if (type === "MD_AUTH_SAVE_SETTINGS") {
    (async () => {
      const saved = await mdSetSettingsLocal({
        clientId: msg.clientId,
        clientSecret: msg.clientSecret,
        username: msg.username,
      });
      return { ok: true, settings: { clientId: saved.clientId, username: saved.username } };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_AUTH_LOGIN_PASSWORD") {
    (async () => {
      const clientId = String(msg.clientId || "");
      const clientSecret = String(msg.clientSecret || "");
      const username = String(msg.username || "");
      const password = String(msg.password || "");
      if (!clientId || !clientSecret || !username || !password) throw new Error("missing_fields");
      const session = await mdLoginPasswordFlow({ clientId, clientSecret, username, password });
      await mdSetSettingsLocal({ clientId, clientSecret, username });
      await mdSetSession(session);
      return { ok: true, expiresAtIso: session.expiresAtIso };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_AUTH_LOGOUT") {
    (async () => {
      await mdClearSession();
      return { ok: true };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_AUTH_STATUS") {
    (async () => {
      const sess = await mdGetSession();
      const connected = !!(sess && mdIsTokenValid(sess) && sess.accessToken);
      return { ok: true, connected, expiresAtIso: sess?.expiresAtIso || "" };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_FOLLOW") {
    (async () => {
      await mdFollowManga(msg.mangaId);
      return { ok: true };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_FOLLOW_BATCH_START") {
    (async () => {
      const ids = Array.isArray(msg.mangaIds) ? msg.mangaIds : [];
      const queue = await mdSetBatchQueue(ids);
      await mdSetBatchCancel(false);
      const total = queue.length;
      const throttleMs = msg.throttleMs != null ? Number(msg.throttleMs) : 800;
      await mdSetBatchState({
        status: "running",
        total,
        done: 0,
        throttleMs: Number.isFinite(throttleMs) ? Math.max(200, Math.floor(throttleMs)) : 800,
        lastError: "",
      });
      alarmsCreateSafe(MD_FOLLOW_BATCH_ALARM, { delayInMinutes: 0.01 });
      return { ok: true, total };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_FOLLOW_BATCH_STOP") {
    (async () => {
      await mdSetBatchCancel(true);
      await mdSetBatchState({ status: "stopped" });
      return { ok: true };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (type === "MD_FOLLOW_BATCH_STATUS") {
    (async () => {
      const st = await mdGetBatchState();
      return { ok: true, state: st || null };
    })()
      .then((r) => runtimeSendResponseSafe(sendResponse, r))
      .catch((e) => runtimeSendResponseSafe(sendResponse, { ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});

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

