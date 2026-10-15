import { appUrl, config } from './config.js';

// Which IoT Open server App Management talks to.
//   - Default: the server the container is configured for (LYNX_URL).
//       API_MODE=proxy (default): requests go to this origin (/api) and the backend relays them, so the
//       browser never talks cross-origin.
//       API_MODE=direct: the browser talks to LYNX_URL itself, so TLS runs end to end between the browser
//       and IoT Open and tokens never pass through this container or a TLS-terminating proxy in front of it.
//   - Custom: a server the user typed on the sign-in page. It is saved in this browser only
//     (localStorage) and the browser talks to it directly; IoT Open allows CORS for all origins.
//     Can be turned off with CUSTOM_SERVERS=false in the container.

const SERVER_KEY = 'am.server';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export class ServerError extends Error {}

export const customServersAllowed = () => !(config.customServers === false || config.customServers === 'false');

/** API_MODE=direct: the default server is called directly from the browser instead of through this container. */
export const directMode = () => config.apiMode === 'direct';

/**
 * "lynx.example.com", "https://lynx.example.com/" -> "https://lynx.example.com".
 * Only https (plain http only for localhost), no credentials, path, query or fragment.
 */
export function normalizeServer(input) {
  const text = String(input || '').trim();
  if (!text) throw new ServerError('Ange en serveradress.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new ServerError('Ogiltig serveradress.');
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new ServerError('Servern måste använda https://.');
  if (url.username || url.password) throw new ServerError('Serveradressen får inte innehålla användarnamn eller lösenord.');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new ServerError('Ange bara serverns adress, utan sökväg, till exempel lynx.iotopen.se.');
  return url.origin;
}

/** Origin of the container's own IoT Open server (LYNX_URL), or null when unknown. */
export function defaultServer() {
  try {
    return config.lynxServer ? new URL(config.lynxServer).origin : null;
  } catch {
    return null;
  }
}

function load() {
  if (!customServersAllowed()) return null;
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    if (!saved) return null;
    const origin = normalizeServer(saved);
    return origin === defaultServer() ? null : origin;
  } catch {
    return null;
  }
}

let current; // undefined = not loaded yet, null = default server, string = custom origin
const cur = () => (current === undefined ? (current = load()) : current);

/** Custom server origin, or null when the default server (via this container) is used. */
export const getServer = () => cur();

/** Host name to show, e.g. "lynx.iotopen.se". */
export function serverLabel(origin = cur()) {
  const o = origin || defaultServer();
  return o ? new URL(o).host : window.location.host;
}

/** Use another server (for this page load). null or the default server = back to the default. */
export function setServer(origin) {
  current = !origin || origin === defaultServer() || !customServersAllowed() ? null : origin;
}

/** Remember the current server in this browser - called after a successful sign-in. */
export function saveServer() {
  try {
    if (current) localStorage.setItem(SERVER_KEY, current);
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* storage unavailable - keep the choice for this page load only */
  }
}

/** Origin the browser sends API traffic to, or null for this container's own origin (proxy). */
const target = () => cur() || (directMode() ? defaultServer() : null);

/** URL of an IoT Open API path, e.g. apiUrl('/api/v2/user/me'). */
export const apiUrl = (path) => (target() ? `${target()}/${String(path).replace(/^\//, '')}` : appUrl(path));


/** Edge clients are managed by this container's backend, which only talks to its own server (LYNX_URL). */
export const onDefaultServer = () => cur() === null;
