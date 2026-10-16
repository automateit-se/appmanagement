import http from 'node:http';
import { HttpError } from './http.mjs';

// Minimal Docker Engine API client over a unix socket or TCP (normally a docker-socket-proxy).
// Only the calls the edge client management needs are used, see edgeClient.mjs.

// Unversioned paths: the daemon answers with its own API version, so this works across Docker releases
// (newer daemons refuse old pinned versions).
const API = '';

export function dockerClient(target) {
  function request(method, path, { query, body, contentType, timeout = 60_000 } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString() : '';
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      path: (target.prefix || '') + API + path + qs,
      headers: { Host: 'docker', ...(payload ? { 'Content-Type': contentType || 'application/json', 'Content-Length': payload.length } : {}) },
      ...(target.socketPath ? { socketPath: target.socketPath } : { host: target.host, port: target.port }),
      timeout,
    };
    return new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => reject(new HttpError(502, `Kunde inte nå Docker: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function json(method, path, opts = {}) {
    const r = await request(method, path, opts);
    const text = r.body.toString('utf8');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (r.status === 304) return null; // already started / stopped
    if (r.status >= 400) {
      const msg = (data && data.message) || text || `HTTP ${r.status}`;
      throw new HttpError(r.status === 404 ? 404 : r.status === 409 ? 409 : 502, `Docker: ${msg}`, { dockerStatus: r.status });
    }
    return data;
  }

  return {
    request,
    json,
    ping: async () => (await request('GET', '/_ping', { timeout: 5000 })).status === 200,
    /** Pulls an image and waits until done. Docker streams progress as JSON lines; an error is one of them. */
    async pull(image) {
      const { repo, tag } = splitImage(image);
      const r = await request('POST', '/images/create', { query: { fromImage: repo, tag }, timeout: 15 * 60_000 });
      const lines = r.body.toString('utf8').split('\n').filter(Boolean);
      const err = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((l) => l.error);
      if (r.status >= 400 || err) throw new HttpError(502, `Docker kunde inte hämta ${image}: ${err?.error || r.status}`);
    },
    /** The container's processes, with ps's own columns (Docker runs ps on the host, nothing runs inside). */
    top: (id, psArgs) => json('GET', `/containers/${encodeURIComponent(id)}/top`, { query: { ps_args: psArgs }, timeout: 15_000 }),
    /** One sample of the container's resource use. */
    stats: (id) => json('GET', `/containers/${encodeURIComponent(id)}/stats`, { query: { stream: 'false', 'one-shot': 'true' }, timeout: 15_000 }),
    async logs(id, tail = 200) {
      const r = await request('GET', `/containers/${encodeURIComponent(id)}/logs`, { query: { stdout: 1, stderr: 1, timestamps: 1, tail } });
      if (r.status >= 400) throw new HttpError(502, `Docker: kunde inte läsa loggen (HTTP ${r.status})`);
      return demuxLogs(r.body);
    },
  };
}

/** "ghcr.io/iotopen/edge-client:latest" -> { repo: "ghcr.io/iotopen/edge-client", tag: "latest" } */
export function splitImage(image) {
  const at = image.indexOf('@');
  if (at > 0) return { repo: image.slice(0, at), tag: image.slice(at + 1) };
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? { repo: image.slice(0, colon), tag: image.slice(colon + 1) } : { repo: image, tag: 'latest' };
}

/**
 * Docker's log stream without a TTY is multiplexed: frames of [stream(1) 0 0 0 size(4, big endian)] + payload.
 * Returns [{ stream: 'stdout'|'stderr', time, text }] with one entry per line.
 */
export function demuxLogs(buf) {
  const parts = [];
  let i = 0;
  const framed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!framed) parts.push({ stream: 'stdout', data: buf });
  else {
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      parts.push({ stream: buf[i] === 2 ? 'stderr' : 'stdout', data: buf.subarray(i + 8, i + 8 + size) });
      i += 8 + size;
    }
  }
  const out = [];
  for (const p of parts) {
    for (const line of p.data.toString('utf8').split('\n')) {
      if (!line) continue;
      const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
      out.push({ stream: p.stream, time: m ? m[1] : null, text: (m ? m[2] : line).replace(/\r$/, '') });
    }
  }
  return out;
}
