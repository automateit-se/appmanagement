import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError, SECURITY_HEADERS, ttlCache } from './http.mjs';

// Everything that talks to IoT Open (Lynx) from the backend: the relay for the browser (API_MODE=proxy) and
// the calls the backend makes itself, always as the signed-in user with that user's own token.

const FORWARD_REQUEST = ['x-api-key', 'authorization', 'content-type', 'accept', 'accept-language'];
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'upgrade']);

/** Relays one request to LYNX_URL. The target is fixed; only the path and query come from the request. */
export async function relay(cfg, req, res, path) {
  const headers = {};
  for (const h of FORWARD_REQUEST) if (req.headers[h]) headers[h] = req.headers[h];
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream;
  try {
    upstream = await fetch(cfg.lynxUrl + path, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.warn(`relay ${req.method} ${path.split('?')[0]}: ${e.message}`);
    res.writeHead(502, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Kunde inte nå IoT Open' }));
    return;
  }
  const out = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k)) out[k] = v;
  });
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

const tokenKey = (token) => createHash('sha256').update(token).digest('hex');

export function lynxClient(cfg) {
  const call = async (token, path, { method = 'GET', body } = {}) => {
    const headers = { 'X-API-Key': token, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(cfg.lynxUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new HttpError(502, `Kunde inte nå IoT Open: ${e.message}`);
    }
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      const msg = (data && data.message) || (typeof data === 'string' && data) || `HTTP ${r.status}`;
      throw new HttpError(r.status === 401 ? 401 : r.status === 403 ? 403 : 502, `IoT Open: ${msg}`, { upstreamStatus: r.status });
    }
    return data;
  };

  const meCache = ttlCache(60_000);
  const instCache = ttlCache(60_000);

  return {
    call,
    /** The signed-in user, or 401. Cached for a minute per token. */
    me: (token) => meCache(tokenKey(token), () => call(token, '/api/v2/user/me')),
    /** Installation the user can see (from /installationinfo), or 404. */
    /** The installations the user can see (cached for a minute). */
    installations: async (token) => (await instCache(tokenKey(token), () => call(token, '/api/v2/installationinfo?assigned=false'))) || [],
    async installation(token, iid) {
      const list = await instCache(tokenKey(token), () => call(token, '/api/v2/installationinfo?assigned=false'));
      const inst = (list || []).find((i) => Number(i.id) === Number(iid));
      if (!inst) throw new HttpError(404, 'Installationen finns inte eller så saknar ditt konto åtkomst till den');
      return inst;
    },
    /** Creates new gateway credentials for an installation. Replaces any earlier ones. */
    createGatewayCredentials: (token, iid) => call(token, `/api/v2/gateway/credentials/${Number(iid)}`, { method: 'POST' }),
  };
}

/** Token from the request (the same X-API-Key the browser sends to IoT Open). */
export function requestToken(req) {
  const t = req.headers['x-api-key'];
  if (typeof t !== 'string' || !t.trim() || t.length > 4096) throw new HttpError(401, 'Inte inloggad');
  return t.trim();
}
