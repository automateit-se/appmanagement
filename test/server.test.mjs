import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMock } from '../mock/server.mjs';
import { createApp } from '../server/index.mjs';
import { loadConfig } from '../server/config.mjs';

// The backend against the mock of IoT Open, GitHub and Docker, over real HTTP.

let mock;
let app;
let base;
const KEY = 'demo-api-key';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function start(env) {
  const cfg = loadConfig(env);
  const server = http.createServer(createApp(cfg));
  return listen(server).then((port) => ({ server, url: `http://127.0.0.1:${port}` }));
}

let mockUrl;
const envFor = (extra = {}) => ({
  LYNX_URL: mockUrl,
  ALLOWED_LYNX_HOSTS: '127.0.0.1',
  ALLOW_INSECURE_LYNX_URL: 'true',
  GITHUB_API_URL: `${mockUrl}/github-api`,
  GITHUB_RAW_URL: `${mockUrl}/github-raw`,
  GITHUB_INCLUDE: 'example-vendor/edge-app-*',
  DOCKER_HOST: `tcp://127.0.0.1:${new URL(mockUrl).port}/docker`,
  STATIC_DIR: staticDir,
  ...extra,
});

let staticDir;
before(async () => {
  staticDir = mkdtempSync(path.join(tmpdir(), 'am-static-'));
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>App</title>');
  mkdirSync(path.join(staticDir, 'assets'));
  writeFileSync(path.join(staticDir, 'assets', 'a.js'), 'console.log(1)');
  mock = createMock();
  mockUrl = `http://127.0.0.1:${await listen(mock)}`;
  app = await start(envFor());
  base = app.url;
});

after(() => {
  app.server.close();
  mock.close();
});

/** Polls an edge client's status until its job (set-up, update) has finished. */
async function waitJob(path, key = KEY, root = base) {
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(root + path, { headers: { 'X-API-Key': key } })).json();
    if (!st.job?.running) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}
const get = (p, key = KEY) => fetch(base + p, { headers: key ? { 'X-API-Key': key } : {} });
const post = (p, body = {}, key = KEY) => fetch(base + p, { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('static files, SPA fallback and security headers', async () => {
  let r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  r = await fetch(base + '/assets/a.js');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
  assert.equal((await fetch(base + '/some/route')).status, 200);
  // the URL parser resolves %2e%2e itself: the answer is the app, never a file outside the static directory
  assert.match(await (await fetch(base + '/%2e%2e/%2e%2e/etc/passwd')).text(), /<title>App<\/title>/);
  const raw = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: new URL(base).port, path: '/assets/../../../etc/passwd' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
  });
  assert.doesNotMatch(raw, /root:/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const cfg = await (await fetch(base + '/config.json')).json();
  assert.equal(cfg.edgeClients, 'true');
  assert.equal(cfg.githubTopic, 'iotopen-edge-app');
});

test('relays /api/v2 to IoT Open and nothing else', async () => {
  const me = await (await get('/api/v2/user/me')).json();
  assert.equal(me.email, 'demo@example.com');
  assert.equal((await get('/api/v3beta/log/1')).status, 404);
  assert.equal((await get('/api/other')).status, 404);
});

test('rate limits sign-in attempts', async () => {
  const s = await start(envFor());
  let last;
  for (let i = 0; i < 11; i++) last = await fetch(s.url + '/api/v2/auth', { method: 'POST', headers: { Authorization: 'Basic eDp5' } });
  assert.equal(last.status, 429);
  s.server.close();
});

test('catalog from GitHub', async () => {
  const list = await (await get('/app-api/catalog', null)).json();
  assert.deepEqual(list.map((r) => r.id).sort(), ['example-org/broken-app', 'example-org/energy-report', 'example-org/light-control', 'example-org/temperature-alarm', 'example-org/value-logger', 'example-vendor/edge-app-door-counter']);
  assert.ok(!list[0].topics.includes('iotopen-edge-app'));

  const d = await (await get('/app-api/catalog/example-org/temperature-alarm')).json();
  assert.deepEqual(d.versions.map((v) => v.name), ['1.1.0', '1.0.0']);
  assert.match(d.readme, /Temperature alarm/);

  const tagsOnly = await (await get('/app-api/catalog/example-org/energy-report')).json();
  assert.deepEqual(tagsOnly.versions.map((v) => v.tag), ['v0.2.0']);

  const pkg = await (await get('/app-api/catalog/example-org/temperature-alarm/package?tag=v1.1.0')).json();
  assert.equal(pkg.version, '1.1.0');
  assert.match(pkg.appLua, /1\.1\.0/);
  assert.equal(JSON.parse(pkg.appJson).input.hysteresis.type, 'number');
  assert.equal(pkg.meta.source_url, 'https://github.com/example-org/temperature-alarm');
  assert.deepEqual(pkg.meta.tags, ['alarm', 'temperature']);

  assert.equal((await get('/app-api/catalog/example-org/temperature-alarm/package?tag=v9.9.9')).status, 404);
  assert.equal((await get('/app-api/catalog/example-org/temperature-alarm/package?tag=../x')).status, 400);
  assert.equal((await get('/app-api/catalog/example-org/broken-app/package?tag=v0.1.0')).status, 422);
  assert.equal((await get('/app-api/catalog/bad%20owner/x')).status, 400);
});

test('IoT Open style repository: no topic, no releases, edge-app.json', async () => {
  const list = await (await get('/app-api/catalog')).json();
  const item = list.find((r) => r.id === 'example-vendor/edge-app-door-counter');
  assert.equal(item.name, 'Door counter');
  assert.equal(item.description, 'Counts door openings');
  assert.deepEqual(item.topics, ['counter', 'door']);

  const d = await (await get('/app-api/catalog/example-vendor/edge-app-door-counter')).json();
  assert.equal(d.versions.length, 1);
  assert.equal(d.versions[0].name, 'commit-20260827-a1b2c3d');
  assert.equal(d.versions[0].unreleased, true);

  const pkg = await (await get(`/app-api/catalog/example-vendor/edge-app-door-counter/package?tag=${d.versions[0].tag}`)).json();
  assert.equal(pkg.version, 'commit-20260827-a1b2c3d');
  assert.match(pkg.appLua, /door counter/);
  assert.deepEqual(pkg.meta, {
    name: 'Door counter',
    short_description: 'Counts door openings',
    description: '# Door counter\n\nCounts door openings per day and in total. The count can be reset.',
    tags: ['counter', 'door'],
    category: 'counter',
    source_url: 'https://github.com/example-vendor/edge-app-door-counter',
  });
  assert.equal((await get('/app-api/catalog/example-vendor/not-an-app')).status, 404);
});

test('GITHUB_OWNERS limits the catalog, GITHUB_INCLUDE is always listed', async () => {
  const s = await start(envFor({ GITHUB_OWNERS: 'someone-else' }));
  const list = await (await fetch(s.url + '/app-api/catalog')).json();
  assert.deepEqual(list.map((r) => r.id), ['example-vendor/edge-app-door-counter']);
  assert.equal((await fetch(s.url + '/app-api/catalog/example-org/temperature-alarm')).status, 404);
  s.server.close();
  const s2 = await start(envFor({ GITHUB_INCLUDE: '' }));
  assert.ok(!(await (await fetch(s2.url + '/app-api/catalog')).json()).some((r) => r.owner === 'example-vendor'));
  s2.server.close();
});

test('edge client lifecycle', async () => {
  assert.equal((await get('/app-api/edge/1002', null)).status, 401);
  assert.equal((await get('/app-api/edge/1002', 'wrong')).status, 401);
  assert.equal((await get('/app-api/edge/4242')).status, 404);

  let st = await (await get('/app-api/edge/1002')).json();
  assert.equal(st.exists, false);

  assert.equal((await post('/app-api/edge/1002', {})).status, 400); // not confirmed
  // "Kontoret" already has an edge client that is online in IoT Open: not replaced without saying so
  let r = await post('/app-api/edge/1002', { confirm: true });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'edge-online');
  assert.equal(body.presence.state, 'online');
  r = await post('/app-api/edge/1002', { confirm: true, replaceOnline: true });
  assert.equal(r.status, 202);
  st = await waitJob('/app-api/edge/1002');
  assert.equal(st.running, true);
  assert.equal(st.name, 'iotopen-edge-1002');
  assert.equal(JSON.stringify(st).includes('mqtt_password'), false);

  assert.equal((await post('/app-api/edge/1002', { confirm: true })).status, 409);

  const logs = await (await get('/app-api/edge/1002/logs?tail=50')).json();
  assert.ok(logs.some((l) => /registered gateway 5002/.test(l.text)));

  st = await (await post('/app-api/edge/1002/stop')).json();
  assert.equal(st.running, false);
  st = await (await post('/app-api/edge/1002/start')).json();
  assert.equal(st.running, true);
  await post('/app-api/edge/1002/restart');
  st = await (await post('/app-api/edge/1002/restart')).json();
  assert.equal(st.restartCount, 2);
  assert.equal(st.recentErrors, 1);
  assert.match(st.lastError.text, /connection lost/);

  r = await post('/app-api/edge/1002/update');
  assert.equal(r.status, 202);
  st = await waitJob('/app-api/edge/1002');
  assert.equal(st.running, true);
  assert.equal(st.restartCount, 0);
  const after = await (await get('/app-api/edge/1002/logs')).json();
  assert.ok(after.some((l) => /registered gateway/.test(l.text)), 'credentials survive an update');

  st = await (await post('/app-api/edge/1002/credentials', { confirm: true })).json();
  assert.equal(st.running, true);

  r = await fetch(base + '/app-api/edge/1002?config=true', { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  assert.deepEqual((await r.json()).exists, false);
  assert.equal((await post('/app-api/edge/1002/start')).status, 404);
});

test('EDGE_CLIENT_NETWORK is created on first use', async () => {
  const s = await start(envFor({ EDGE_CLIENT_NETWORK: 'iotopen-edge' }));
  const r = await fetch(s.url + '/app-api/edge/1002', { method: 'POST', headers: { 'X-API-Key': KEY }, body: JSON.stringify({ confirm: true, replaceOnline: true }) });
  assert.equal(r.status, 202);
  assert.equal((await waitJob('/app-api/edge/1002', KEY, s.url)).running, true);
  assert.equal((await fetch(`${mockUrl}/docker/networks/iotopen-edge`)).status, 200);
  await fetch(s.url + '/app-api/edge/1002?config=true', { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  s.server.close();
});

test('EDGE_ADMINS restricts edge client management', async () => {
  const s = await start(envFor({ EDGE_ADMINS: 'admin@example.com' }));
  const r = await fetch(s.url + '/app-api/edge/1001', { headers: { 'X-API-Key': KEY } });
  assert.equal(r.status, 403);
  s.server.close();
  const s2 = await start(envFor({ EDGE_ADMINS: 'Demo@Example.com' }));
  assert.equal((await fetch(s2.url + '/app-api/edge/1001', { headers: { 'X-API-Key': KEY } })).status, 200);
  s2.server.close();
});

test('without DOCKER_HOST edge clients are off', async () => {
  const s = await start(envFor({ DOCKER_HOST: '' }));
  assert.equal((await (await fetch(s.url + '/config.json')).json()).edgeClients, 'false');
  assert.equal((await fetch(s.url + '/app-api/edge/1001', { headers: { 'X-API-Key': KEY } })).status, 404);
  s.server.close();
});

test('BASE_PATH and API_MODE=direct', async () => {
  const s = await start(envFor({ BASE_PATH: '/am', API_MODE: 'direct', CUSTOM_SERVERS: 'false' }));
  let r = await fetch(s.url + '/am', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/am/');
  r = await fetch(s.url + '/am/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), new RegExp(`connect-src 'self' ${mockUrl}`));
  assert.equal((await fetch(s.url + '/am/api/v2/user/me', { headers: { 'X-API-Key': KEY } })).status, 404);
  assert.equal((await fetch(s.url + '/')).status, 404);
  assert.equal((await fetch(s.url + '/healthz')).status, 200);
  s.server.close();
});

test('edge status in IoT Open', async () => {
  // a fresh backend, so nothing is cached from the other tests
  const s = await start(envFor());
  const pr = async (iid) => (await fetch(`${s.url}/app-api/presence/${iid}`, { headers: { 'X-API-Key': KEY } })).json();
  assert.deepEqual(await pr(1001), { state: 'unknown', reason: 'no-message', topic: '5001/box/event/status' });
  assert.equal((await fetch(`${s.url}/app-api/presence/1001`)).status, 401);
  assert.equal((await fetch(`${s.url}/app-api/presence/4242`, { headers: { 'X-API-Key': KEY } })).status, 404);
  // creating an edge client here brings 5001 online
  const c = await fetch(`${s.url}/app-api/edge/1001`, { method: 'POST', headers: { 'X-API-Key': KEY }, body: JSON.stringify({ confirm: true }) });
  assert.equal(c.status, 202);
  await waitJob('/app-api/edge/1001', KEY, s.url);
  const s2 = await start(envFor());
  const pr2 = async (iid) => (await fetch(`${s2.url}/app-api/presence/${iid}`, { headers: { 'X-API-Key': KEY } })).json();
  assert.equal((await pr2(1001)).state, 'online');
  await fetch(`${s2.url}/app-api/edge/1001/stop`, { method: 'POST', headers: { 'X-API-Key': KEY } });
  const s3 = await start(envFor());
  assert.equal((await (await fetch(`${s3.url}/app-api/presence/1001`, { headers: { 'X-API-Key': KEY } })).json()).state, 'offline');
  await fetch(`${s3.url}/app-api/edge/1001?config=true`, { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  for (const x of [s, s2, s3]) x.server.close();
});
