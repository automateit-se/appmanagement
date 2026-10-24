import { createHash } from 'node:crypto';
import { createMqtt } from './mqtt.mjs';
import { ttlCache } from './http.mjs';

// Is there already an edge client on the installation, and is it online? (What Lynx shows as "Edge status".)
//
// An IoT Open edge client is a mosquitto bridge to IoT Open, configured with
//   notification_topic <client_id>/box/event/status
// so the bridge itself publishes a retained 1 when it connects and 0 when it goes away (also as its last will).
// The backend subscribes to that topic as the signed-in user for a few seconds and reads the retained value.
// IoT Open's status API (last value per topic) is asked too, for brokers that do not keep retained messages.
//
// state: 'online' | 'offline' | 'unknown' (no edge client has reported, or the status could not be read)

export const STATUS_TOPIC = 'box/event/status';

/** 1 / "1" / true / "online" / {value: 1} -> 'online'; 0 / "0" / false / "offline" -> 'offline'; else null. */
export function parseStatus(v) {
  const x = v && typeof v === 'object' && !Array.isArray(v) ? v.value : v;
  const s = String(x ?? '').trim().toLowerCase();
  if (['1', 'true', 'online', 'connected', 'up'].includes(s)) return 'online';
  if (['0', 'false', 'offline', 'disconnected', 'down'].includes(s)) return 'offline';
  return null;
}

const toSeconds = (t) => {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
};

function viaMqtt(url, token, topic, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let client = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ state: null, reason: 'no-message' }), timeoutMs);
    try {
      client = createMqtt({
        url,
        token,
        reconnect: false,
        onState: (s) => {
          if (s === 'live') client.setSubscriptions([topic]);
          if (s === 'failed') finish({ state: null, reason: 'mqtt-refused' });
          if (s === 'error' || s === 'offline') finish({ state: null, reason: 'mqtt-unreachable' });
        },
        // retained messages arrive right after the subscription is confirmed; wait a moment, not the full timeout
        onSubscribed: () => setTimeout(() => finish({ state: null, reason: 'no-message' }), 800),
        onMessage: (t, payload) => {
          if (t !== topic) return;
          const state = parseStatus(payload);
          if (state) finish({ state, since: toSeconds(payload.timestamp), source: 'mqtt' });
        },
      });
    } catch {
      finish({ state: null, reason: 'mqtt-unreachable' });
    }
  });
}

async function viaStatusApi(lynx, token, iid, clientId) {
  try {
    const list = await lynx.call(token, `/api/v2/status/${Number(iid)}?topics=${encodeURIComponent(STATUS_TOPIC)}`);
    const want = [STATUS_TOPIC, `${clientId}/${STATUS_TOPIC}`];
    const hit = (Array.isArray(list) ? list : []).find((e) => want.includes(String(e.topic)));
    const state = hit ? parseStatus(hit) : null;
    return state ? { state, since: toSeconds(hit.timestamp), source: 'status' } : { state: null };
  } catch {
    return { state: null };
  }
}

/** Retained statuses of many topics over one MQTT connection: Map topic -> { state, since }. */
function manyViaMqtt(url, token, topics, timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map();
    let done = false;
    let client = null;
    let acks = 0;
    const expected = Math.ceil(topics.length / 50); // the client subscribes in chunks of 50
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      resolve(found);
    };
    const timer = setTimeout(finish, timeoutMs);
    const wanted = new Set(topics);
    try {
      client = createMqtt({
        url,
        token,
        reconnect: false,
        onState: (s) => {
          if (s === 'live') client.setSubscriptions(topics);
          if (s === 'failed' || s === 'error' || s === 'offline') finish();
        },
        onSubscribed: () => {
          if (++acks >= expected) setTimeout(finish, 1000);
        },
        onMessage: (t, payload) => {
          if (!wanted.has(t)) return;
          const state = parseStatus(payload);
          if (state) found.set(t, { state, since: toSeconds(payload.timestamp) });
        },
      });
    } catch {
      finish();
    }
  });
}

/** Runs fn over items with at most n at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export function presenceChecker(cfg, lynx, { timeoutMs = 3500 } = {}) {
  const mqttUrl = cfg.lynxUrl.replace(/^http/, 'ws') + '/mqtt';
  const cache = ttlCache(15_000, 200);
  const many = ttlCache(30_000, 200);
  const check = (token, inst) =>
    cache(`${inst.id}|${createHash('sha256').update(token).digest('hex')}`, async () => {
      const topic = `${inst.client_id}/${STATUS_TOPIC}`;
      const [m, s] = await Promise.all([viaMqtt(mqttUrl, token, topic, timeoutMs), viaStatusApi(lynx, token, inst.id, inst.client_id)]);
      // MQTT carries a bare 1/0; IoT Open's status API knows when it was published
      const r = m.state ? { ...m, since: m.since || (s.state === m.state ? s.since : null) } : s.state ? s : null;
      return r ? { state: r.state, since: r.since || null, source: r.source, topic } : { state: 'unknown', reason: m.reason || 'no-message', topic };
    });

  /**
   * Edge status of many installations at once (the list of installations): one MQTT connection for all of them, and
   * IoT Open's status API only for those that did not answer on MQTT. { [installation id]: { state, since } }
   */
  check.many = (token, insts) =>
    many(`${insts.map((i) => i.id).join(',')}|${createHash('sha256').update(token).digest('hex')}`, async () => {
      const topic = (i) => `${i.client_id}/${STATUS_TOPIC}`;
      const fromMqtt = await manyViaMqtt(mqttUrl, token, insts.map(topic), timeoutMs);
      const rest = insts.filter((i) => !fromMqtt.has(topic(i)));
      const fromApi = await pool(rest, 6, (i) => viaStatusApi(lynx, token, i.id, i.client_id));
      const out = {};
      for (const i of insts) {
        const m = fromMqtt.get(topic(i));
        const s = m ? null : fromApi[rest.indexOf(i)];
        const r = m || (s?.state ? s : null);
        out[i.id] = r ? { state: r.state, since: r.since || null } : { state: 'unknown' };
      }
      return out;
    });
  return check;
}
