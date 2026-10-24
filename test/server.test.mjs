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
  process.env.MOCK_TRAFFIC_MS = '200'; // apps publish on MQTT often, for the live test
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

test('health of the apps on a local edge client', async () => {
  const s = await start(envFor());
  const g = (p) => fetch(s.url + p, { headers: { 'X-API-Key': KEY } });
  assert.deepEqual((await (await g('/app-api/edge/1002/apps')).json()).exists, false);
  // two apps on "Kontoret", one of them crashes in the mock
  const add = async (name) => (await fetch(`${mockUrl}/api/v2/edge/app/configured/1002`, {
    method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: 1, version: '1.0.0', name, config: {} }),
  })).json();
  const ok = await add('Weather');
  const bad = await add('Door alarm');
  const c = await fetch(`${s.url}/app-api/edge/1002`, { method: 'POST', headers: { 'X-API-Key': KEY }, body: JSON.stringify({ confirm: true, replaceOnline: true }) });
  assert.equal(c.status, 202);
  await waitJob('/app-api/edge/1002', KEY, s.url);

  const h = await (await g('/app-api/edge/1002/apps')).json();
  assert.equal(h.exists, true);
  assert.equal(h.processesRead, true);
  assert.ok(h.memory.usage > 0 && h.memory.limit === 256 * 1048576);
  assert.equal(h.apps[ok.id].state, 'running');
  assert.ok(h.apps[ok.id].memoryKb > 0);
  assert.equal(h.apps[bad.id].state, 'crashing');
  assert.match(h.apps[bad.id].lastError.text, /attempt to index a nil value/);

  const logs = await (await g(`/app-api/edge/1002/apps/${bad.id}/logs?logic=1-1.0.0`)).json();
  assert.ok(logs.length >= 3 && logs.every((l) => !l.text.includes(`edge app ${ok.id}`)));
  assert.ok(logs.some((l) => l.error && /died with 1/.test(l.text)));
  assert.equal((await g(`/app-api/edge/1002/apps/${bad.id}/logs?logic=../../etc`)).status, 400);
  // read_only may look at the health too
  assert.equal((await fetch(s.url + '/app-api/edge/1002/apps', { headers: { 'X-API-Key': 'viewer-api-key' } })).status, 200);

  await fetch(`${s.url}/app-api/edge/1002/stop`, { method: 'POST', headers: { 'X-API-Key': KEY } });
  const off = await (await g('/app-api/edge/1002/apps')).json();
  assert.equal(off.running, false);
  assert.equal(off.memory, null);
  assert.equal(off.apps[ok.id].state, 'edge-stopped');

  await fetch(`${s.url}/app-api/edge/1002?config=true`, { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  for (const i of [ok, bad]) await fetch(`${mockUrl}/api/v2/edge/app/configured/1002/${i.id}`, { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  s.server.close();
});

test('MQTT: topics, history and live messages of the apps', async () => {
  const g = (p, key = KEY) => fetch(base + p, { headers: key ? { 'X-API-Key': key } : {} });
  const t = await (await g('/app-api/mqtt/1001/topics?hours=24')).json();
  const log = t.topics.find((x) => x.topic === 'obj/doorcounter/9001/log');
  assert.ok(log && log.kind === 'obj' && log.count > 0);
  assert.ok(t.topics.some((x) => x.topic === 'evt/doorcounter/9001/alarm' && x.kind === 'evt'));
  assert.ok(t.topics.every((x) => !x.topic.startsWith('5001/')), 'no client_id in topics');
  assert.ok(!t.topics.some((x) => x.topic.includes('weather')), 'only this installation');

  // wildcards are matched by the backend, exact topics by IoT Open
  const wild = await (await g('/app-api/mqtt/1001/history?topics=evt/doorcounter/%23&hours=24')).json();
  assert.ok(wild.messages.length > 0 && wild.messages.every((m) => m.kind === 'evt' && m.history));
  assert.match(wild.messages[0].msg, /held open/);
  const exact = await (await g('/app-api/mqtt/1001/history?topics=obj/doorcounter/9001/log&hours=1')).json();
  assert.ok(exact.messages.length > 0 && exact.messages.every((m) => m.topic === 'obj/doorcounter/9001/log'));
  assert.ok(exact.messages.every((m, i) => i === 0 || m.time >= exact.messages[i - 1].time), 'oldest first');

  assert.equal((await g('/app-api/mqtt/1001/history?topics=box/%23')).status, 400);
  assert.equal((await g('/app-api/mqtt/1001/history')).status, 400);
  assert.equal((await g('/app-api/mqtt/1001/topics', null)).status, 401);
  assert.equal((await g('/app-api/mqtt/4242/topics')).status, 404);

  // live: server-sent events until the client goes away
  const ac = new AbortController();
  const res = await fetch(base + '/app-api/mqtt/1001/live?topics=obj/doorcounter/%2B/log', { headers: { 'X-API-Key': KEY }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let text = '';
  const until = Date.now() + 5000;
  while (!/event: message/.test(text) && Date.now() < until) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  assert.match(text, /event: state\ndata: \{"state":"live"\}/);
  const msg = JSON.parse(/event: message\ndata: (.*)\n/.exec(text)[1]);
  assert.equal(msg.topic, 'obj/doorcounter/9001/log');
  assert.match(msg.msg, /Door opened/);
});

test('edge status of many installations at once', async () => {
  // a fresh backend, so nothing is cached from the other tests
  const s = await start(envFor());
  const g = (q, key = KEY) => fetch(`${s.url}/app-api/presence${q}`, { headers: key ? { 'X-API-Key': key } : {} });
  // "Kontoret" (1002) has had an edge client (online or, after the tests above, offline); "Demohuset" (1001) none
  const r = await (await g('?ids=1001,1002,4242')).json();
  assert.ok(['online', 'offline'].includes(r[1002].state), r[1002].state);
  assert.equal(r[1001].state, 'unknown');
  assert.equal(r[4242], undefined, 'installations the user cannot see are left out');
  assert.equal((await g('?ids=abc')).status, 400);
  assert.equal((await g('?ids=' + Array.from({ length: 201 }, (_, i) => i + 1).join(','))).status, 400);
  assert.equal((await g('?ids=1001', null)).status, 401);
  s.server.close();
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

test('IoT Open roles decide what a user may do', async () => {
  const acc = async (key, iid) => (await fetch(`${base}/app-api/access/${iid}`, { headers: { 'X-API-Key': key } })).json();

  const admin = await acc(KEY, 1002);
  assert.deepEqual([admin.role, admin.manageEdge, admin.viewEdge, admin.installApps, admin.publishApps], ['admin', true, true, true, true]);

  // owner: gateway rights on assigned installations only
  const own1 = await acc('owner-api-key', 1001);
  assert.deepEqual([own1.role, own1.assigned, own1.manageEdge, own1.viewEdge, own1.installApps], ['owner', true, true, true, true]);
  const own2 = await acc('owner-api-key', 1002);
  assert.deepEqual([own2.assigned, own2.manageEdge, own2.viewEdge, own2.installApps], [false, false, false, false]);

  // read_only: may look, not change
  const view = await acc('viewer-api-key', 1001);
  assert.deepEqual([view.role, view.manageEdge, view.viewEdge, view.installApps, view.updateApps], ['read_only', false, true, false, false]);
  assert.equal((await fetch(`${base}/app-api/edge/1001`, { headers: { 'X-API-Key': 'viewer-api-key' } })).status, 200);
  const denied = await fetch(`${base}/app-api/edge/1001`, { method: 'POST', headers: { 'X-API-Key': 'viewer-api-key' }, body: JSON.stringify({ confirm: true }) });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).message, /read_only/);
  assert.equal((await fetch(`${base}/app-api/edge/1002`, { headers: { 'X-API-Key': 'owner-api-key' } })).status, 403);
});

test('EDGE_ADMINS restricts setting up new edge clients', async () => {
  const post = (s, sub, body) => fetch(`${s.url}/app-api/edge/1001${sub}`, { method: 'POST', headers: { 'X-API-Key': KEY }, body: JSON.stringify(body) });
  const s = await start(envFor({ EDGE_ADMINS: 'admin@example.com' }));
  // looking, starting and stopping follow the IoT Open role; only a new edge client is refused
  assert.equal((await fetch(s.url + '/app-api/edge/1001', { headers: { 'X-API-Key': KEY } })).status, 200);
  assert.notEqual((await post(s, '/start', {})).status, 403);
  const r = await post(s, '', { confirm: true });
  assert.equal(r.status, 403);
  assert.match((await r.json()).message, /utvalda användare/);
  s.server.close();
  const s2 = await start(envFor({ EDGE_ADMINS: 'Demo@Example.com' }));
  const a = await (await fetch(s2.url + '/app-api/access/1001', { headers: { 'X-API-Key': KEY } })).json();
  assert.deepEqual([a.manageEdge, a.createEdge, a.restrictedBy], [true, true, null]);
  s2.server.close();
});

test('EDGE_PERMISSION requires an extra IoT Open role permission to set up edge clients', async () => {
  const acc = async (s, key, iid = 1001) => (await fetch(`${s.url}/app-api/access/${iid}`, { headers: { 'X-API-Key': key } })).json();
  const post = (s, sub, body) => fetch(`${s.url}/app-api/edge/1001${sub}`, { method: 'POST', headers: { 'X-API-Key': KEY }, body: JSON.stringify(body) });
  // admin has external/example/*, owner has external/example/edge/manager, read_only has neither
  const s = await start(envFor({ EDGE_PERMISSION: 'external/example/edge/manager' }));
  assert.equal((await acc(s, KEY)).createEdge, true);
  assert.equal((await acc(s, 'owner-api-key')).createEdge, true);
  const view = await acc(s, 'viewer-api-key');
  assert.deepEqual([view.manageEdge, view.createEdge, view.viewEdge], [false, false, true]);
  assert.ok(!JSON.stringify(view).includes('external/'), 'the permission name is not sent to the browser');
  s.server.close();

  const s2 = await start(envFor({ EDGE_PERMISSION: 'external/other/manager' }));
  const a = await acc(s2, KEY);
  assert.deepEqual([a.manageEdge, a.createEdge, a.viewEdge, a.restrictedBy], [true, false, true, 'EDGE_PERMISSION']);
  assert.ok(!JSON.stringify(a).includes('external/'), 'the permission name is not sent to the browser');
  const r = await post(s2, '', { confirm: true });
  assert.equal(r.status, 403);
  assert.match((await r.json()).message, /särskild rättighet/);
  assert.equal((await fetch(s2.url + '/app-api/edge/1001', { headers: { 'X-API-Key': KEY } })).status, 200);
  for (const sub of ['/start', '/stop', '/restart']) assert.notEqual((await post(s2, sub, {})).status, 403, sub);
  s2.server.close();
});

test('role permissions: plain, /all, /assigned and wildcards', async () => {
  const { hasPermission } = await import('../server/access.mjs');
  const perms = { 'a/b': true, 'c/all': true, 'd/assigned': true, 'external/x/*': true, 'external/y/*': false, 'e': false };
  assert.equal(hasPermission(perms, 'a/b', false), true);
  assert.equal(hasPermission(perms, 'c', false), true);
  assert.equal(hasPermission(perms, 'd', false), false);
  assert.equal(hasPermission(perms, 'd', true), true);
  assert.equal(hasPermission(perms, 'external/x/estate/manager', false), true);
  assert.equal(hasPermission(perms, 'external/xy/manager', false), false);
  assert.equal(hasPermission(perms, 'external/y/manager', false), false);
  assert.equal(hasPermission(perms, 'e', true), false);
  assert.equal(hasPermission(perms, '', true), false);
});

test('EDGE_ADMINS accepts an e-mail domain', async () => {
  const acc = async (s) => (await fetch(s.url + '/app-api/access/1001', { headers: { 'X-API-Key': KEY } })).json();
  for (const [admins, allowed] of [['@example.com', true], ['*@Example.com', true], ['@other.example', false], ['@ample.com', false], ['example.com', false]]) {
    const s = await start(envFor({ EDGE_ADMINS: admins }));
    const a = await acc(s);
    assert.equal(a.createEdge, allowed, admins);
    assert.equal(a.manageEdge, true, admins);
    assert.equal(a.restrictedBy, allowed ? null : 'EDGE_ADMINS', admins);
    assert.equal(a.viewEdge, true, admins);
    s.server.close();
  }
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
