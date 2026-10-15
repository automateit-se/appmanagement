import { apiUrl } from './server.js';

// Minimal IoT Open (Lynx) REST client.
// By default all requests go to the same origin under /api - the backend (or the Vite dev server) relays them
// to the IoT Open instance. With a custom server (see server.js) they go to that server directly.
// Users, roles and permissions are handled entirely by IoT Open; the app only keeps the session token.

const TOKEN_KEY = 'am.token';
const KIND_KEY = 'am.tokenKind';

export class HTTPError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function storageGet(key) {
  try {
    return sessionStorage.getItem(key) || localStorage.getItem(key);
  } catch {
    return null;
  }
}

let token = storageGet(TOKEN_KEY);
let tokenKind = storageGet(KIND_KEY) || 'session';
let onUnauthorized = () => {};

export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);
export const getToken = () => token;
/** 'session' (password login, may expire) or 'apikey' (created in IoT Open, does not expire). */
export const getTokenKind = () => tokenKind;

export function setToken(t, remember = false, kind = 'session') {
  token = t;
  tokenKind = kind;
  try {
    for (const s of [sessionStorage, localStorage]) {
      s.removeItem(TOKEN_KEY);
      s.removeItem(KIND_KEY);
    }
    if (t) {
      const s = remember ? localStorage : sessionStorage;
      s.setItem(TOKEN_KEY, t);
      s.setItem(KIND_KEY, kind);
    }
  } catch {
    /* storage unavailable - keep the token in memory only */
  }
}

// A 401 from one endpoint does not have to mean the session is gone (some endpoints answer 401 for a
// missing permission). Only sign out when /user/me also says 401 for the same token.
let checking = null;
export function checkSession(t = token) {
  if (checking || !t) return;
  checking = fetch(apiUrl('api/v2/user/me'), { headers: { 'X-API-Key': t } })
    .then((r) => {
      if (r.status === 401 && token === t) {
        console.warn('IoT Open session expired - signing out');
        onUnauthorized();
      }
    })
    .catch(() => {})
    .finally(() => (checking = null));
}

export async function parseError(res) {
  let err;
  try {
    err = await res.clone().json();
  } catch {
    err = await res.text().catch(() => undefined);
  }
  const msg = (err && err.message) || (typeof err === 'string' && err) || res.statusText || `HTTP ${res.status}`;
  return new HTTPError(msg, res.status, err);
}

async function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const h = new Headers(headers);
  if (auth && token && !h.has('Authorization')) h.set('X-API-Key', token);
  let payload = body;
  if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') {
    payload = JSON.stringify(body);
    h.set('Content-Type', 'application/json');
  }
  const res = await fetch(apiUrl(path), { method, headers: h, body: payload });
  if (res.status === 401 && auth && token) checkSession(token);
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const enc = encodeURIComponent;

export const lynx = {
  // ---- auth ----
  login: (username, password) =>
    request('/api/v2/auth', {
      method: 'POST',
      auth: false,
      headers: { Authorization: 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`))) },
    }),
  login2fa: (tmpToken, challenge) =>
    request('/api/v2/auth', { method: 'PUT', auth: false, headers: { 'X-API-Key': tmpToken }, body: { challenge } }),
  logout: () => request('/api/v2/auth', { method: 'DELETE' }),
  me: () => request('/api/v2/user/me'),

  // ---- installations, devices, functions (for the device and function pickers in app settings) ----
  installations: () => request('/api/v2/installationinfo?assigned=false'),
  devices: (iid) => request(`/api/v2/devicex/${iid}`),
  functions: (iid) => request(`/api/v2/functionx/${iid}`),

  // ---- edge apps: catalogue ----
  edgeApps: () => request('/api/v2/edge/app'),
  /** The organization's own apps; available=true adds public apps it may install. */
  edgeAppsOrganization: (orgId, available = false) => request(`/api/v2/edge/app/organization/${orgId}${available ? '?available=true' : ''}`),
  edgeApp: (id) => request(`/api/v2/edge/app/${id}`),
  edgePublisher: (orgId) => request(`/api/v2/edge/publisher/${orgId}`),
  createEdgeApp: (app) => request('/api/v2/edge/app', { method: 'POST', body: app }),
  updateEdgeApp: (app) => request(`/api/v2/edge/app/${app.id}`, { method: 'PUT', body: app }),

  // ---- edge apps: versions ----
  edgeAppVersions: (id, untagged = false) => request(`/api/v2/edge/app/${id}/version${untagged ? '?untagged=true' : ''}`),
  /** Uploads app.json + app.lua as a new (unnamed) version. IoT Open answers with its hash. */
  createEdgeAppVersion: (id, appJson, appLua) => {
    const fd = new FormData();
    fd.append('app_json', new Blob([appJson], { type: 'application/json' }), 'app.json');
    fd.append('app_lua', new Blob([appLua], { type: 'text/plain' }), 'app.lua');
    return request(`/api/v2/edge/app/${id}/version`, { method: 'POST', body: fd });
  },
  /** Gives an uploaded version its name (publishes it). */
  publishEdgeAppVersion: (id, name, hash) => request(`/api/v2/edge/app/${id}/publish`, { method: 'POST', body: { name, hash } }),
  /** The version's app.json: inputs and guide for the settings form. */
  edgeAppOptions: (id, version) => request(`/api/v2/edge/app/${id}/configure?version=${enc(version)}`),

  // ---- edge apps: instances on an installation ----
  instances: (iid) => request(`/api/v2/edge/app/configured/${iid}`),
  createInstance: (iid, inst) => request(`/api/v2/edge/app/configured/${iid}`, { method: 'POST', body: { ...inst, installation_id: iid } }),
  updateInstance: (iid, inst) => request(`/api/v2/edge/app/configured/${iid}/${inst.id}`, { method: 'PUT', body: { ...inst, installation_id: iid } }),
  deleteInstance: (iid, id) => request(`/api/v2/edge/app/configured/${iid}/${id}`, { method: 'DELETE' }),
};
