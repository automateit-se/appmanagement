import { HttpError } from './http.mjs';
import { createMqtt } from './mqtt.mjs';

// What edge apps publish on MQTT (obj/… and evt/…), read as the signed-in user, wherever the installation's edge
// client runs. Apps choose their own topics, so the user finds and picks them:
// - topics: which obj/evt topics have had messages lately (IoT Open's message history plus the latest values)
// - history: earlier messages from IoT Open's history (GET /api/v3beta/log/{installation}); it filters on exact
//   topics only, so wildcard patterns are matched here
// - live: an MQTT subscription over WebSocket with the user's token, sent on to the browser as server-sent events
// On MQTT and in the history the topics carry the installation's client_id as prefix; the browser never sees it.

export const MAX_PATTERNS = 10;
const KINDS = ['obj', 'evt'];
const HISTORY_LIMIT = 10_000; // IoT Open's maximum per request
const MAX_MESSAGES = 1000;
const LIVE_MAX_SECONDS = 15 * 60;
const LIVE_MAX_PER_SECOND = 50;
const LIVE_MAX_CONNECTIONS = 100;

/** Topic patterns from a query parameter: comma or newline separated, `obj/…` or `evt/…`, MQTT wildcards allowed. */
export function parsePatterns(raw) {
  const list = String(raw || '')
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^\/+/, ''))
    .filter(Boolean);
  if (!list.length) throw new HttpError(400, 'Ange minst en topic');
  if (list.length > MAX_PATTERNS) throw new HttpError(400, `Högst ${MAX_PATTERNS} topics åt gången`);
  for (const p of list) {
    const parts = p.split('/');
    const ok =
      p.length <= 200 &&
      KINDS.includes(parts[0]) &&
      parts.every((s, i) => (s === '#' ? i === parts.length - 1 : s === '+' || (s !== '' && !/[#+\s\0]/.test(s))));
    if (!ok) throw new HttpError(400, `Ogiltig topic: ${p.slice(0, 80)}. Den ska börja med obj/ eller evt/, och + och # får bara stå som en hel nivå.`);
  }
  return [...new Set(list)];
}

/** MQTT topic matching: + is one level, # (last) is the rest. */
export function topicMatches(pattern, topic) {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

const hasWildcard = (p) => /(^|\/)[+#](\/|$)/.test(p);

/** A message as the browser gets it: topic without client_id, time in ms. */
function entry(topic, payload, fallbackMs, history) {
  const ts = Number(payload?.timestamp);
  const value = payload?.value;
  return {
    time: ts > 0 ? Math.round(ts * 1000) : fallbackMs,
    topic,
    kind: topic.split('/')[0],
    value: value === undefined ? null : value,
    msg: typeof payload?.msg === 'string' ? payload.msg : payload?.message ? String(payload.message) : '',
    ...(history ? { history: true } : {}),
  };
}

const stripClient = (clientId, topic) => {
  const prefix = `${clientId}/`;
  return topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;
};

export function mqttLog(cfg, lynx) {
  const mqttUrl = cfg.lynxUrl.replace(/^http/, 'ws') + '/mqtt';
  let liveConnections = 0;

  async function log(token, inst, { from, to, topics }) {
    const q = new URLSearchParams({ from: String(from), to: String(to), limit: String(HISTORY_LIMIT), order: 'desc' });
    for (const t of topics || []) q.append('topics', `${inst.client_id}/${t}`);
    const r = await lynx.call(token, `/api/v3beta/log/${Number(inst.id)}?${q}`);
    return { data: Array.isArray(r?.data) ? r.data : [], total: Number(r?.total) || 0 };
  }

  return {
    /** Topics that have had obj/evt messages in the last `hours`, with counts and the latest message. */
    async topics(token, inst, { hours = 1 } = {}) {
      const to = Math.floor(Date.now() / 1000);
      const h = Math.max(1, Math.min(24, Number(hours) || 1));
      const [hist, status] = await Promise.all([
        log(token, inst, { from: to - h * 3600, to }),
        // latest value of every obj topic, also those that have been quiet for long
        lynx.call(token, `/api/v2/status/${Number(inst.id)}`).catch(() => []),
      ]);
      const map = new Map();
      const add = (rawTopic, payload, counted) => {
        const topic = stripClient(inst.client_id, String(rawTopic || ''));
        if (!KINDS.includes(topic.split('/')[0])) return;
        const e = entry(topic, payload, 0);
        const t = map.get(topic) || { topic, kind: e.kind, count: 0, last: null };
        if (counted) t.count++;
        if (!t.last || e.time > t.last.time) t.last = { time: e.time, value: e.value, msg: e.msg };
        map.set(topic, t);
      };
      for (const d of hist.data) add(d.topic, d, true);
      for (const s of Array.isArray(status) ? status : []) add(s.topic, s, false);
      const list = [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.topic.localeCompare(b.topic));
      return { hours: h, truncated: hist.total > hist.data.length, topics: list.slice(0, 2000) };
    },

    /** Earlier messages on the patterns, oldest first (at most MAX_MESSAGES, the newest ones). */
    async history(token, inst, patterns, { hours = 24 } = {}) {
      const to = Math.floor(Date.now() / 1000);
      const h = Math.max(1, Math.min(24 * 7, Number(hours) || 24));
      const exact = !patterns.some(hasWildcard);
      // exact topics are filtered by IoT Open; wildcards need the whole history of the period, filtered here
      const hist = await log(token, inst, { from: to - h * 3600, to, topics: exact ? patterns : null });
      const out = [];
      for (const d of hist.data) {
        const topic = stripClient(inst.client_id, String(d.topic || ''));
        if (patterns.some((p) => topicMatches(p, topic))) out.push(entry(topic, d, 0, true));
      }
      out.sort((a, b) => a.time - b.time);
      return {
        hours: h,
        // IoT Open returns at most 10 000 messages: with wildcards on a busy installation the oldest are missing
        truncated: hist.total > hist.data.length,
        messages: out.slice(-MAX_MESSAGES),
      };
    },

    /** Server-sent events with new messages on the patterns until the browser goes away (at most 15 minutes). */
    live(req, res, token, inst, patterns) {
      if (liveConnections >= LIVE_MAX_CONNECTIONS) throw new HttpError(503, 'För många som lyssnar just nu, försök igen om en stund');
      liveConnections++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let sent = 0;
      let dropped = 0;
      let second = 0;
      let done = false;
      const mqtt = createMqtt({
        url: mqttUrl,
        token,
        onState: (s) => {
          if (s === 'live') send('state', { state: 'live' });
          else if (s === 'failed') finish('IoT Open nekade MQTT-anslutningen');
          else if (s === 'offline') send('state', { state: 'reconnecting' });
        },
        onMessage: (rawTopic, payload, meta) => {
          const topic = stripClient(inst.client_id, rawTopic);
          if (!patterns.some((p) => topicMatches(p, topic))) return;
          const now = Date.now();
          if (Math.floor(now / 1000) !== second) {
            second = Math.floor(now / 1000);
            sent = 0;
            if (dropped) send('dropped', { count: dropped });
            dropped = 0;
          }
          if (++sent > LIVE_MAX_PER_SECOND) return void dropped++;
          send('message', { ...entry(topic, payload, now), ...(meta?.retained ? { retained: true } : {}) });
        },
      });
      mqtt.setSubscriptions(patterns.map((p) => `${inst.client_id}/${p}`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000); // keeps proxies from closing an idle stream
      const limit = setTimeout(() => finish('Lyssnat i 15 minuter, starta igen för att fortsätta', 'timeout'), LIVE_MAX_SECONDS * 1000);
      function finish(message, code = 'error') {
        if (done) return;
        done = true;
        liveConnections--;
        clearInterval(ping);
        clearTimeout(limit);
        mqtt.close();
        if (message && !res.writableEnded) send('end', { code, message });
        res.end();
      }
      req.on('close', () => finish());
      send('state', { state: 'connecting' });
    },
  };
}
