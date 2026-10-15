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

export function presenceChecker(cfg, lynx, { timeoutMs = 3500 } = {}) {
  const mqttUrl = cfg.lynxUrl.replace(/^http/, 'ws') + '/mqtt';
  const cache = ttlCache(15_000, 200);
  return (token, inst) =>
    cache(`${inst.id}|${createHash('sha256').update(token).digest('hex')}`, async () => {
      const topic = `${inst.client_id}/${STATUS_TOPIC}`;
      const [m, s] = await Promise.all([viaMqtt(mqttUrl, token, topic, timeoutMs), viaStatusApi(lynx, token, inst.id, inst.client_id)]);
      const r = m.state ? m : s.state ? s : null;
      return r ? { state: r.state, since: r.since || null, source: r.source, topic } : { state: 'unknown', reason: m.reason || 'no-message', topic };
    });
}
