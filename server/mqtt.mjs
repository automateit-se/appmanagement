// Minimal MQTT 3.1.1 client over WebSocket (no dependency), the same as in the IoT Open Dashboard.
// Runs in Node 22+ with its built-in WebSocket.
// CONNECT (username = password = IoT Open token), SUBSCRIBE/UNSUBSCRIBE (QoS 0), PUBLISH in both
// directions, keep-alive and automatic reconnect with back-off.

const enc = new TextEncoder();
const dec = new TextDecoder();
const str = (s) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
const remLen = (n) => {
  const o = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    o.push(d);
  } while (n > 0);
  return o;
};

/**
 * createMqtt({ url, token, onMessage(topic, payload), onState(state) })
 *   state: 'connecting' | 'live' | 'offline' | 'failed'
 * returns { setSubscriptions(topics[]), publish(topic, payload) -> boolean, close() }
 */
export function createMqtt({ url, token, onMessage, onState, onSubscribed, keepAlive = 60, reconnect = true }) {
  let ws = null;
  let closed = false;
  let subs = [];
  let subscribed = new Set();
  let packetId = 1;
  let retry = 0;
  let pingTimer = null;
  let buffer = new Uint8Array(0);
  let failures = 0;
  let connected = false;

  const send = (bytes) => ws && ws.readyState === 1 && (ws.send(new Uint8Array(bytes)), true);

  const subscribe = (topics) => {
    const fresh = topics.filter((t) => !subscribed.has(t));
    if (!fresh.length || !connected) return;
    for (let i = 0; i < fresh.length; i += 50) {
      const chunk = fresh.slice(i, i + 50);
      const id = packetId++ & 0xffff || 1;
      const payload = chunk.flatMap((t) => [...str(t), 0]);
      send([0x82, ...remLen(2 + payload.length), id >> 8, id & 255, ...payload]);
      chunk.forEach((t) => subscribed.add(t));
    }
  };

  const unsubscribe = (topics) => {
    const gone = topics.filter((t) => subscribed.has(t));
    if (!gone.length || !connected) return;
    const id = packetId++ & 0xffff || 1;
    const payload = gone.flatMap((t) => str(t));
    send([0xa2, ...remLen(2 + payload.length), id >> 8, id & 255, ...payload]);
    gone.forEach((t) => subscribed.delete(t));
  };

  const handlePacket = (type, flags, body) => {
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) {
        onState?.('failed');
        closed = true;
        ws.close();
        return;
      }
      connected = true;
      retry = 0;
      failures = 0;
      subscribed = new Set();
      subscribe(subs);
      onState?.('live');
    } else if (type === 9) {
      // SUBACK: a broker sends retained messages right away, so a caller waiting for one knows when to stop
      onSubscribed?.();
    } else if (type === 3) {
      // PUBLISH
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      let off = 2 + tl;
      if ((flags >> 1) & 3) off += 2;
      const text = dec.decode(body.subarray(off));
      // IoT Open's own messages are JSON objects ({ value, msg, timestamp }). A bare value - a lone number
      // such as "1", or plain text - is treated by IoT Open as { value: <it> }, so it is here too.
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text.trim();
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = { value: payload, msg: '' };
      onMessage?.(topic, payload, { retained: !!(flags & 1), text });
    }
  };

  const onData = (chunk) => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    for (;;) {
      if (buffer.length < 2) return;
      let mul = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= buffer.length) return;
        byte = buffer[i++];
        len += (byte & 127) * mul;
        mul *= 128;
      } while (byte & 128);
      if (buffer.length < i + len) return;
      handlePacket(buffer[0] >> 4, buffer[0] & 15, buffer.subarray(i, i + len));
      buffer = buffer.slice(i + len);
    }
  };

  const connect = () => {
    if (closed) return;
    onState?.('connecting');
    buffer = new Uint8Array(0);
    connected = false;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch {
      return scheduleReconnect();
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const vh = [...str('MQTT'), 4, 0xc2, keepAlive >> 8, keepAlive & 255];
      const pl = [...str('appmgmt-' + Math.random().toString(36).slice(2, 10)), ...str(token), ...str(token)];
      send([0x10, ...remLen(vh.length + pl.length), ...vh, ...pl]);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send([0xc0, 0]), (keepAlive * 1000) / 2);
    };
    ws.onmessage = (ev) => onData(new Uint8Array(ev.data));
    ws.onclose = () => {
      clearInterval(pingTimer);
      connected = false;
      subscribed = new Set();
      if (!closed) {
        failures++;
        onState?.(failures >= 3 ? 'offline' : 'connecting');
        scheduleReconnect();
      }
    };
    ws.onerror = () => onState?.('error');
  };

  const scheduleReconnect = () => {
    if (closed || !reconnect) return;
    setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };

  connect();

  return {
    setSubscriptions(topics) {
      const next = [...new Set(topics)];
      unsubscribe([...subscribed].filter((t) => !next.includes(t)));
      subs = next;
      subscribe(subs);
    },
    /** QoS 0 publish. Returns false when not connected. */
    publish(topic, payload) {
      if (!connected) return false;
      const body = [...str(topic), ...enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload))];
      return !!send([0x30, ...remLen(body.length), ...body]);
    },
    close() {
      closed = true;
      clearInterval(pingTimer);
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
