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
  /** Health of the apps on the local edge client: { exists, running, memory, apps: { [instance]: … }, byLogic } */
  edgeApps: (iid) => call(`edge/${iid}/apps`),
  edgeAppLogs: (iid, instance, logic) => call(`edge/${iid}/apps/${instance}/logs${logic ? `?logic=${seg(logic)}` : ''}`),
  /** obj/evt topics with messages lately: { hours, truncated, topics: [{ topic, kind, count, last }] } */
  mqttTopics: (iid, hours = 1) => call(`mqtt/${iid}/topics?hours=${hours}`),
  /** Earlier messages on topic patterns: { hours, truncated, messages: [{ time, topic, kind, value, msg }] } */
  mqttHistory: (iid, topics, hours = 24) => call(`mqtt/${iid}/history?topics=${seg(topics.join(','))}&hours=${hours}`),
  /**
   * New messages on topic patterns as they come, until `signal` aborts. Server-sent events read with fetch, so the
   * token can travel in a header (EventSource cannot send one). onEvent(type, data): state | message | dropped | end
   */
  async mqttLive(iid, topics, onEvent, signal) {
    const headers = { Accept: 'text/event-stream' };
    const t = getToken();
    if (t) headers['X-API-Key'] = t;
    const res = await fetch(appUrl(`app-api/mqtt/${iid}/live?topics=${seg(topics.join(','))}`), { headers, signal });
    if (!res.ok) throw await parseError(res);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (type && data) onEvent(type, JSON.parse(data));
      }
    }
  },
  edgeCreate: (iid, replaceOnline = false) => call(`edge/${iid}`, { method: 'POST', body: { confirm: true, replaceOnline } }),
  edgeRenew: (iid) => call(`edge/${iid}/credentials`, { method: 'POST', body: { confirm: true } }),
  edgeAction: (iid, action) => call(`edge/${iid}/${action}`, { method: 'POST', body: {} }),
  edgeRemove: (iid, removeConfig) => call(`edge/${iid}?config=${removeConfig ? 'true' : 'false'}`, { method: 'DELETE' }),
};
