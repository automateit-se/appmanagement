import { appUrl } from './config.js';
import { getToken, parseError } from './lynx.js';

// App Management's own backend: the GitHub catalogue and the edge client in the local Docker environment.
// Always this container's origin, also when the user signed in to another IoT Open server.

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  const t = getToken();
  if (t) headers['X-API-Key'] = t;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(appUrl(`app-api/${path}`), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw await parseError(res);
  return res.status === 204 ? null : res.json();
}

const seg = (s) => encodeURIComponent(s);

export const backend = {
  catalog: () => call('catalog'),
  repo: (owner, repo) => call(`catalog/${seg(owner)}/${seg(repo)}`),
  /** app.json, app.lua and description of one version, ready to be handed to IoT Open. */
  package: (owner, repo, tag) => call(`catalog/${seg(owner)}/${seg(repo)}/package?tag=${seg(tag)}`),

  /** What the user may do on the installation, from the user's role in IoT Open. */
  access: (iid) => call(`access/${iid}`),
  /** Edge status in IoT Open: { state: 'online' | 'offline' | 'unknown', since } */
  presence: (iid) => call(`presence/${iid}`),
  edgeStatus: (iid) => call(`edge/${iid}`),
  edgeLogs: (iid, tail = 200) => call(`edge/${iid}/logs?tail=${tail}`),
  edgeCreate: (iid, replaceOnline = false) => call(`edge/${iid}`, { method: 'POST', body: { confirm: true, replaceOnline } }),
  edgeRenew: (iid) => call(`edge/${iid}/credentials`, { method: 'POST', body: { confirm: true } }),
  edgeAction: (iid, action) => call(`edge/${iid}/${action}`, { method: 'POST', body: {} }),
  edgeRemove: (iid, removeConfig) => call(`edge/${iid}?config=${removeConfig ? 'true' : 'false'}`, { method: 'DELETE' }),
};
