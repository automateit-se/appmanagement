// Small helpers for the built-in http server: JSON answers, request bodies, rate limiting.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function sendError(res, e) {
  const status = e instanceof HttpError ? e.status : 500;
  if (status >= 500 && !(e instanceof HttpError)) console.error(e);
  sendJson(res, status, { message: status >= 500 && !(e instanceof HttpError) ? 'Internt fel i App Management' : e.message, ...(e.extra || {}) });
}

export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'För stor förfrågan');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ogiltig JSON');
  }
}

/** Client address: the socket, or a header set by a trusted reverse proxy (REAL_IP_HEADER). */
export function clientIp(req, realIpHeader) {
  const h = realIpHeader && req.headers[realIpHeader];
  return (typeof h === 'string' && h.split(',')[0].trim()) || req.socket.remoteAddress || '?';
}

/** Fixed window rate limiter: at most `max` hits per `windowMs` per key. */
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now - e.start >= windowMs) {
      e = { start: now, n: 0 };
      hits.set(key, e);
    }
    e.n += 1;
    if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    return e.n <= max;
  };
}

/** Tiny TTL cache with in-flight de-duplication. */
export function ttlCache(ttlMs, maxEntries = 500) {
  const m = new Map();
  return async (key, load) => {
    const now = Date.now();
    const hit = m.get(key);
    if (hit && hit.until > now) return hit.value;
    const value = load();
    m.set(key, { value, until: now + ttlMs });
    if (m.size > maxEntries) m.delete(m.keys().next().value);
    try {
      return await value;
    } catch (e) {
      m.delete(key);
      throw e;
    }
  };
}
