import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig } from './config.mjs';
import { HttpError, SECURITY_HEADERS, clientIp, rateLimiter, readJson, sendError, sendJson } from './http.mjs';
import { lynxClient, relay, requestToken } from './lynx.mjs';
import { githubClient } from './github.mjs';
import { dockerClient } from './docker.mjs';
import { edgeClients } from './edgeClient.mjs';
import { presenceChecker } from './presence.mjs';

// App Management backend: serves the built app, relays /api/v2 to IoT Open (API_MODE=proxy), reads edge apps
// from GitHub and manages IoT Open Docker Edge Clients in the local Docker environment (DOCKER_HOST).
// It has no database and no accounts of its own: every IoT Open call is made with the signed-in user's token.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp(cfg, opts = {}) {
  const lynx = lynxClient(cfg);
  const github = githubClient(cfg);
  const edge = cfg.edge.docker ? edgeClients(cfg, dockerClient(cfg.edge.docker), lynx) : null;
  const presence = presenceChecker(cfg, lynx, opts.presence);

  const authLimit = rateLimiter(10, 60_000);
  const catalogLimit = rateLimiter(120, 60_000);
  const edgeLimit = rateLimiter(120, 60_000);
  const busy = new Set(); // installations with an edge client operation in progress

  const connectSrc = cfg.customServers ? "'self' https:" : cfg.apiMode === 'direct' ? `'self' ${cfg.lynxUrl}` : "'self'";
  const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ${connectSrc}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;

  const publicConfig = JSON.stringify({
    appTitle: cfg.appTitle,
    lynxServer: cfg.lynxUrl,
    customServers: String(cfg.customServers),
    apiMode: cfg.apiMode,
    edgeClients: String(!!edge),
    githubTopic: cfg.github.topic,
    githubOwners: cfg.github.owners,
    githubInclude: cfg.github.include,
  });

  /** Signed-in user allowed to manage edge clients for this installation. */
  async function edgeUser(req, iid) {
    const token = requestToken(req);
    const user = await lynx.me(token);
    if (cfg.edge.admins.length) {
      const ok = cfg.edge.admins.includes(String(user.id)) || cfg.edge.admins.includes(String(user.email || '').toLowerCase());
      if (!ok) throw new HttpError(403, 'Ditt konto får inte hantera edge clients i App Management (EDGE_ADMINS)');
    }
    const inst = await lynx.installation(token, iid);
    return { token, user, inst };
  }

  async function exclusive(iid, fn) {
    if (busy.has(iid)) throw new HttpError(409, 'En annan åtgärd pågår redan för den här edge clienten');
    busy.add(iid);
    try {
      return await fn();
    } finally {
      busy.delete(iid);
    }
  }

  async function appApi(req, res, p, url) {
    const ip = clientIp(req, cfg.realIpHeader);
    let m;

    if (p === '/app-api/catalog' || p.startsWith('/app-api/catalog/')) {
      if (!catalogLimit(ip)) throw new HttpError(429, 'För många anrop, vänta en stund');
      if (req.method !== 'GET') throw new HttpError(405, 'Metoden stöds inte');
      if (p === '/app-api/catalog') return sendJson(res, 200, await github.catalog());
      if ((m = /^\/app-api\/catalog\/([^/]+)\/([^/]+)$/.exec(p))) return sendJson(res, 200, await github.details(m[1], m[2]));
      if ((m = /^\/app-api\/catalog\/([^/]+)\/([^/]+)\/package$/.exec(p))) return sendJson(res, 200, await github.package(m[1], m[2], url.searchParams.get('tag')));
      throw new HttpError(404, 'Hittades inte');
    }

    // Edge status in IoT Open (is there an edge client, is it online?) - read only, any user with access
    if ((m = /^\/app-api\/presence\/(\d{1,12})$/.exec(p))) {
      if (req.method !== 'GET') throw new HttpError(405, 'Metoden stöds inte');
      if (!edgeLimit(ip)) throw new HttpError(429, 'För många anrop, vänta en stund');
      const token = requestToken(req);
      const inst = await lynx.installation(token, Number(m[1]));
      return sendJson(res, 200, await presence(token, inst));
    }

    if ((m = /^\/app-api\/edge\/(\d{1,12})(?:\/([a-z-]+))?$/.exec(p))) {
      if (!edge) throw new HttpError(404, 'Hantering av edge clients är inte aktiverad (DOCKER_HOST saknas)');
      if (!edgeLimit(ip)) throw new HttpError(429, 'För många anrop, vänta en stund');
      const iid = Number(m[1]);
      const sub = m[2] || '';
      const { token, user, inst } = await edgeUser(req, iid);
      if (req.method === 'GET' && sub === '') return sendJson(res, 200, await edge.status(iid));
      if (req.method === 'GET' && sub === 'logs') return sendJson(res, 200, await edge.logs(iid, url.searchParams.get('tail')));
      if (req.method === 'DELETE' && sub === '') {
        return sendJson(res, 200, await exclusive(iid, () => edge.remove(iid, url.searchParams.get('config') === 'true')));
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (sub === '' || sub === 'credentials') {
          // both replace the installation's gateway credentials in IoT Open - the user must have confirmed that
          if (body.confirm !== true) throw new HttpError(400, 'Bekräftelse saknas');
          // a new edge client must not silently knock out one that is online in IoT Open right now
          if (sub === '' && body.replaceOnline !== true) {
            const pr = await presence(token, inst);
            if (pr.state === 'online') {
              throw new HttpError(409, 'Installationen har redan en edge client som är online i IoT Open. Den kopplas bort om nya credentials skapas.', { code: 'edge-online', presence: pr });
            }
          }
          return sendJson(res, sub === '' ? 201 : 200, await exclusive(iid, () => (sub === '' ? edge.create(iid, token, user) : edge.renewCredentials(iid, token))));
        }
        if (['start', 'stop', 'restart'].includes(sub)) return sendJson(res, 200, await exclusive(iid, () => edge.action(iid, sub)));
        if (sub === 'update') return sendJson(res, 200, await exclusive(iid, () => edge.update(iid, user)));
      }
      throw new HttpError(404, 'Hittades inte');
    }
    throw new HttpError(404, 'Hittades inte');
  }

  async function serveStatic(req, res, p) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Metoden stöds inte');
    const root = path.resolve(cfg.staticDir);
    let decoded;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      throw new HttpError(400, 'Ogiltig sökväg');
    }
    let file = path.resolve(root, '.' + decoded);
    if (!file.startsWith(root + path.sep) && file !== root) throw new HttpError(404, 'Hittades inte');
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st) {
      if (p.startsWith('/assets/') || path.extname(p)) throw new HttpError(404, 'Hittades inte');
      file = path.join(root, 'index.html'); // the app routes with #, so any other path is the app
      st = await stat(file).catch(() => null);
      if (!st) throw new HttpError(404, 'Appen är inte byggd (npm run build)');
    }
    const immutable = p.startsWith('/assets/');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Security-Policy': CSP,
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = url.pathname;
      if (p === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (cfg.basePath) {
        if (p === cfg.basePath) {
          res.writeHead(301, { Location: `${cfg.basePath}/${url.search}` });
          return res.end();
        }
        if (!p.startsWith(cfg.basePath + '/')) throw new HttpError(404, 'Hittades inte');
        p = p.slice(cfg.basePath.length);
      }
      if (p.includes('\0') || p.includes('/../') || p.endsWith('/..')) throw new HttpError(400, 'Ogiltig sökväg');

      if (p === '/config.json') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(publicConfig);
      }
      if (p.startsWith('/api/')) {
        if (cfg.apiMode !== 'proxy' || !p.startsWith('/api/v2/')) throw new HttpError(404, 'Hittades inte');
        if (p === '/api/v2/auth' && !authLimit(clientIp(req, cfg.realIpHeader))) throw new HttpError(429, 'För många inloggningsförsök, vänta en minut');
        return await relay(cfg, req, res, p + url.search);
      }
      if (p.startsWith('/app-api/')) return await appApi(req, res, p, url);
      return await serveStatic(req, res, p);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      sendError(res, e);
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const server = http.createServer(createApp(cfg));
  server.requestTimeout = 20 * 60_000; // pulling the edge client image can take a while
  server.listen(cfg.port, () => {
    console.log(`App Management on :${cfg.port}${cfg.basePath || ''}  LYNX_URL=${cfg.lynxUrl}  API_MODE=${cfg.apiMode}`);
    console.log(`  GitHub topic: ${cfg.github.topic}${cfg.github.owners.length ? `  owners: ${cfg.github.owners.join(',')}` : '  (all owners)'}${cfg.github.include.length ? `  include: ${cfg.github.include.join(',')}` : ''}`);
    console.log(`  Edge clients: ${cfg.edge.docker ? `on, image ${cfg.edge.image}` : 'off (no DOCKER_HOST)'}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
