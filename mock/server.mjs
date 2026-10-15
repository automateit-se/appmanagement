// Local mock of the three services App Management talks to, for development, the demo and the tests.
// No dependencies. Everything is in memory and made up.
//
//   /api/v2/...        IoT Open (Lynx): sign-in, installations, devices, functions, edge apps, gateway credentials
//   /github-api/...    GitHub REST API: topic search, repositories, releases, tags
//   /github-raw/...    raw.githubusercontent.com: app.json, app.lua, README.md per tag
//   /docker/v1.41/...  Docker Engine API: containers, volumes, images, logs, archive
//
// Logins: demo@example.com / demo, API key demo-api-key, twofa@example.com / demo + code 123456.

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------- IoT Open

const users = [
  { id: 1, email: 'demo@example.com', password: 'demo', first_name: 'Demo', last_name: 'Användare', organizations: [10] },
  { id: 2, email: 'twofa@example.com', password: 'demo', first_name: 'Två', last_name: 'Faktor', organizations: [10], twofa: '123456' },
];
const tokens = new Map([['demo-api-key', 1]]);
const pending2fa = new Map();

const installations = [
  { id: 1001, client_id: 5001, name: 'Demohuset', organization_id: 10, timezone: 'Europe/Stockholm', capabilities: [], assigned: true },
  { id: 1002, client_id: 5002, name: 'Kontoret', organization_id: 10, timezone: 'Europe/Stockholm', capabilities: [], assigned: true },
];

const devices = {
  1001: [
    { id: 201, installation_id: 1001, type: 'zwave', meta: { name: 'Vardagsrum', room: 'Vardagsrum' } },
    { id: 202, installation_id: 1001, type: 'zwave', meta: { name: 'Hall', room: 'Hall' } },
  ],
  1002: [{ id: 211, installation_id: 1002, type: 'modbus', meta: { name: 'Elmätare' } }],
};
const functions = {
  1001: [
    { id: 301, installation_id: 1001, type: 'temperature', meta: { name: 'Temperatur vardagsrum', device_id: '201', topic_read: 'obj/zwave/201/temp' } },
    { id: 302, installation_id: 1001, type: 'temperature', meta: { name: 'Temperatur hall', device_id: '202', topic_read: 'obj/zwave/202/temp' } },
    { id: 303, installation_id: 1001, type: 'switch', meta: { name: 'Lampa hall', device_id: '202', topic_read: 'obj/zwave/202/switch', topic_write: 'set/obj/zwave/202/switch' } },
  ],
  1002: [{ id: 311, installation_id: 1002, type: 'energy', meta: { name: 'Energi', device_id: '211', topic_read: 'obj/modbus/211/energy' } }],
};

const publishers = { 10: { id: 77, name: 'Exempelbolaget AB' } };
const now = () => Math.floor(Date.now() / 1000);
const hash = () => randomBytes(20).toString('hex');

const weatherJson = {
  author: 'IoT Open',
  license: 'MIT',
  input: {
    city: { type: 'text', name: 'Ort', description: 'Orten vädret hämtas för', required: true, default: 'Stockholm' },
    interval: { type: 'number', name: 'Intervall (minuter)', description: 'Hur ofta vädret hämtas', default: 30, min: 5, max: 1440 },
  },
  guide: [{ id: 'stage_1', title: 'Väderdata', description: 'Välj ort och hur ofta vädret ska hämtas.', input_fields: ['city', 'interval'] }],
};
const edgeApps = [
  {
    id: 1, name: 'Väderdata', category: 'weather', tags: ['weather'], short_description: 'Hämtar väderprognos till installationen',
    description: 'Exempelapp som finns i IoT Open sedan tidigare och inte kommer från GitHub.', publisher: { id: 1, name: 'IoT Open' },
    official: true, public: true, source_url: '', created: now() - 86400 * 300, updated: now() - 86400 * 20,
    versions: [
      { name: '1.0.0', hash: hash(), timestamp: now() - 86400 * 300, app_json: JSON.stringify(weatherJson), app_lua: '-- weather 1.0.0\n' },
      { name: '1.1.0', hash: hash(), timestamp: now() - 86400 * 20, app_json: JSON.stringify(weatherJson), app_lua: '-- weather 1.1.0\n' },
    ],
  },
];
let nextAppId = 2;
const instances = [{ id: 9001, app_id: 1, installation_id: 1001, version: '1.0.0', name: 'Väderdata', config: { city: 'Stockholm', interval: 30 }, created: now() - 86400 * 100, updated: now() - 86400 * 100 }];
let nextInstanceId = 9002;

const publicApp = ({ versions, ...a }) => a;

// ---------------------------------------------------------------- GitHub

const alarmJson = (extra = {}) => ({
  author: 'Exempelbolaget',
  license: 'MIT',
  input: {
    sensor: { type: 'single_function_selector', name: 'Temperaturgivare', description: 'Givaren som ska bevakas', required: true, filter: { type: 'temperature' } },
    limit: { type: 'number', name: 'Gräns (°C)', description: 'Larm när temperaturen går över gränsen', required: true, default: 25, min: -40, max: 100 },
    level: { type: 'option', name: 'Allvarlighet', description: '', values: { 1: 'Varning', 2: 'Kritisk' }, default: '1' },
    notify: { type: 'toggle', name: 'Skicka notis', description: 'Skicka en notis när larmet går', default: true },
    label: { type: 'text', name: 'Larmets namn', description: '', validator: '^.{1,40}$', on_error: 'Ange 1-40 tecken' },
    ...extra,
  },
  guide: [
    { id: 'stage_1', title: 'Givare', description: 'Välj vilken givare som ska bevakas och vid vilken temperatur.', input_fields: ['sensor', 'limit'] },
    { id: 'stage_2', title: 'Larm', description: 'Hur larmet ska visas.', input_fields: ['level', 'notify', 'label', ...Object.keys(extra)] },
  ],
});

const repos = {
  'example-org/temperature-alarm': {
    description: 'Larmar när en temperatur går över en gräns',
    topics: ['iotopen-edge-app', 'alarm', 'temperature'],
    readme: '# Temperature alarm\n\nLarmar när en vald temperaturgivare går över en gräns.\n\n## Inställningar\n\n- Givare\n- Gräns i °C\n',
    releases: {
      'v1.0.0': { json: alarmJson(), lua: '-- temperature alarm 1.0.0\n', at: '2026-08-01T10:00:00Z', notes: 'Första versionen.' },
      'v1.1.0': {
        json: alarmJson({ hysteresis: { type: 'number', name: 'Hysteres (°C)', description: 'Hur mycket temperaturen måste sjunka innan larmet återställs', default: 1, min: 0, max: 10 } }),
        lua: '-- temperature alarm 1.1.0\n', at: '2026-09-15T10:00:00Z', notes: 'Ny inställning: hysteres.',
      },
    },
  },
  'example-org/energy-report': {
    description: 'Summerar energiförbrukningen per dygn',
    topics: ['iotopen-edge-app', 'energy'],
    readme: '# Energy report\n\nSummerar energin per dygn och skriver resultatet till en ny funktion.\n',
    tagsOnly: true,
    releases: {
      'v0.2.0': {
        json: {
          author: 'Exempelbolaget', license: 'MIT',
          input: {
            meters: { type: 'multi_function_selector', name: 'Mätare', description: 'Mätare som ska summeras', required: true, filter: { type: 'energy' } },
            hour: { type: 'number', name: 'Timme för summering', description: '', default: 0, min: 0, max: 23 },
          },
          guide: [{ id: 'stage_1', title: 'Mätare', description: '', input_fields: ['meters', 'hour'] }],
        },
        lua: '-- energy report 0.2.0\n', at: '2026-07-01T10:00:00Z', notes: '',
      },
    },
  },
  'example-org/broken-app': {
    description: 'Saknar app.lua och kan därför inte installeras',
    topics: ['iotopen-edge-app'],
    readme: '',
    releases: { 'v0.1.0': { json: { input: {}, guide: [] }, lua: null, at: '2026-06-01T10:00:00Z', notes: '' } },
  },
};

const ghRepo = (full) => {
  const [owner, name] = full.split('/');
  const r = repos[full];
  return {
    full_name: full, name, owner: { login: owner }, description: r.description, topics: r.topics,
    html_url: `https://github.com/${full}`, stargazers_count: 3, pushed_at: '2026-09-15T10:00:00Z', archived: false, license: { spdx_id: 'MIT' },
  };
};

// ---------------------------------------------------------------- Docker

const containers = new Map(); // id -> container
const volumes = new Map();

function dockerLogs(c) {
  const t0 = Date.now() - 60_000;
  const lines = [];
  const ts = (i) => new Date(t0 + i * 1000).toISOString();
  lines.push([1, `${ts(0)} Starting supervisord`]);
  if (!c.config) {
    lines.push([2, `${ts(1)} edged: ERROR could not read /etc/iot-open/iotopen.json`]);
  } else {
    lines.push([1, `${ts(1)} iotopen-verify: registered gateway ${c.config.client_id}`]);
    lines.push([1, `${ts(2)} mosquitto: bridge lynx-${c.config.client_id} connected`]);
    lines.push([1, `${ts(3)} edged: syncing apps for installation ${c.config.installation_id}`]);
    if (c.restarts > 1) lines.push([2, `${ts(4)} edged: error: connection lost, reconnecting`]);
  }
  const bufs = [];
  for (const [stream, text] of lines) {
    const payload = Buffer.from(text + '\n');
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(payload.length, 4);
    bufs.push(h, payload);
  }
  return Buffer.concat(bufs);
}

function parseTar(buf) {
  const files = {};
  let i = 0;
  while (i + 512 <= buf.length) {
    const name = buf.subarray(i, i + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.subarray(i + 124, i + 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8) || 0;
    files[name] = buf.subarray(i + 512, i + 512 + size).toString('utf8');
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// ---------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain' : 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(data);
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
async function json(req) {
  const b = await body(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}
function multipart(req, buf) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] || '');
  if (!m) return {};
  const boundary = '--' + (m[1] || m[2]);
  const out = {};
  for (const part of buf.toString('utf8').split(boundary)) {
    const n = /name="([^"]+)"/.exec(part);
    if (!n) continue;
    const idx = part.indexOf('\r\n\r\n');
    out[n[1]] = part.slice(idx + 4).replace(/\r\n$/, '');
  }
  return out;
}
const userFor = (req) => {
  const id = tokens.get(req.headers['x-api-key']);
  return users.find((u) => u.id === id);
};
const canSee = (u, iid) => !!u && installations.some((i) => i.id === Number(iid) && u.organizations.includes(i.organization_id));

// ---------------------------------------------------------------- routes

async function lynxApi(req, res, p, url) {
  let m;
  if (p === '/api/v2/auth' && req.method === 'POST') {
    const [email, password] = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
    const u = users.find((x) => x.email === email && x.password === password);
    if (!u) return send(res, 401, { message: 'invalid credentials' });
    const t = randomBytes(16).toString('hex');
    if (u.twofa) {
      pending2fa.set(t, u.id);
      return send(res, 200, { token: t, next_step: 'totp' });
    }
    tokens.set(t, u.id);
    return send(res, 200, { token: t });
  }
  if (p === '/api/v2/auth' && req.method === 'PUT') {
    const { challenge } = await json(req);
    const id = pending2fa.get(req.headers['x-api-key']);
    const u = users.find((x) => x.id === id);
    if (!u || challenge !== u.twofa) return send(res, 401, { message: 'invalid code' });
    pending2fa.delete(req.headers['x-api-key']);
    const t = randomBytes(16).toString('hex');
    tokens.set(t, u.id);
    return send(res, 200, { token: t });
  }
  const u = userFor(req);
  if (!u) return send(res, 401, { message: 'unauthorized' });
  if (p === '/api/v2/auth' && req.method === 'DELETE') {
    tokens.delete(req.headers['x-api-key']);
    return send(res, 200, { message: 'ok' });
  }
  if (p === '/api/v2/user/me') return send(res, 200, { id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, organisations: u.organizations });
  if (p === '/api/v2/installationinfo') return send(res, 200, installations.filter((i) => u.organizations.includes(i.organization_id)));
  if ((m = /^\/api\/v2\/(devicex|functionx)\/(\d+)$/.exec(p))) {
    if (!canSee(u, m[2])) return send(res, 403, { message: 'forbidden' });
    return send(res, 200, (m[1] === 'devicex' ? devices : functions)[m[2]] || []);
  }
  if ((m = /^\/api\/v2\/gateway\/credentials\/(\d+)$/.exec(p)) && req.method === 'POST') {
    const inst = installations.find((i) => i.id === Number(m[1]));
    if (!inst || !canSee(u, inst.id)) return send(res, 403, { message: 'forbidden' });
    const host = req.headers.host || 'localhost';
    return send(res, 200, {
      client_id: inst.client_id, installation_id: inst.id, api: `http://${host}`, aam: `http://${host}`,
      mqtt_broker: `${host.split(':')[0]}:8883`, mqtt_username: `box:${inst.client_id}`, mqtt_password: randomBytes(12).toString('hex'),
      mqtt_client_id: `edge-${inst.client_id}`, timezone: inst.timezone,
    });
  }

  // ---- edge apps
  if ((m = /^\/api\/v2\/edge\/publisher\/(\d+)$/.exec(p))) {
    const pub = publishers[m[1]];
    return pub && u.organizations.includes(Number(m[1])) ? send(res, 200, pub) : send(res, 404, { message: 'publisher not found' });
  }
  if (p === '/api/v2/edge/app' && req.method === 'GET') {
    return send(res, 200, edgeApps.filter((a) => a.public || u.organizations.some((o) => publishers[o]?.id === a.publisher?.id)).map(publicApp));
  }
  if (p === '/api/v2/edge/app' && req.method === 'POST') {
    const b = await json(req);
    const pub = Object.entries(publishers).find(([o, x]) => x.id === b.publisher?.id && u.organizations.includes(Number(o)));
    if (!pub) return send(res, 403, { message: 'not a publisher' });
    for (const k of ['name', 'short_description']) if (!b[k]) return send(res, 400, { message: `${k}: failed on the 'required' tag` });
    const app = { ...b, id: nextAppId++, publisher: pub[1], official: false, created: now(), updated: now(), versions: [] };
    edgeApps.push(app);
    return send(res, 200, publicApp(app));
  }
  if ((m = /^\/api\/v2\/edge\/app\/organization\/(\d+)$/.exec(p))) {
    const pub = publishers[m[1]];
    const own = edgeApps.filter((a) => pub && a.publisher?.id === pub.id);
    const list = url.searchParams.get('available') === 'true' ? [...new Set([...own, ...edgeApps.filter((a) => a.public)])] : own;
    return send(res, 200, list.map(publicApp));
  }
  if ((m = /^\/api\/v2\/edge\/app\/configured\/(\d+)(?:\/(\d+))?$/.exec(p))) {
    const iid = Number(m[1]);
    if (!canSee(u, iid)) return send(res, 403, { message: 'forbidden' });
    if (!m[2] && req.method === 'GET') return send(res, 200, instances.filter((i) => i.installation_id === iid));
    if (!m[2] && req.method === 'POST') {
      const b = await json(req);
      const app = edgeApps.find((a) => a.id === Number(b.app_id));
      if (!app || !app.versions.some((v) => v.name === b.version)) return send(res, 400, { message: 'unknown app or version' });
      const inst = { id: nextInstanceId++, app_id: app.id, installation_id: iid, version: b.version, name: b.name || app.name, config: b.config || {}, created: now(), updated: now() };
      instances.push(inst);
      return send(res, 200, inst);
    }
    const inst = instances.find((i) => i.id === Number(m[2]) && i.installation_id === iid);
    if (!inst) return send(res, 404, { message: 'not found' });
    if (req.method === 'GET') return send(res, 200, inst);
    if (req.method === 'PUT') {
      const b = await json(req);
      const app = edgeApps.find((a) => a.id === inst.app_id);
      if (b.version && !app.versions.some((v) => v.name === b.version)) return send(res, 400, { message: 'unknown version' });
      Object.assign(inst, { version: b.version ?? inst.version, name: b.name ?? inst.name, config: b.config ?? inst.config, updated: now() });
      return send(res, 200, inst);
    }
    if (req.method === 'DELETE') {
      instances.splice(instances.indexOf(inst), 1);
      return send(res, 200, { message: 'ok' });
    }
  }
  if ((m = /^\/api\/v2\/edge\/app\/(\d+)(?:\/([a-z]+))?$/.exec(p))) {
    const app = edgeApps.find((a) => a.id === Number(m[1]));
    if (!app) return send(res, 404, { message: 'not found' });
    const own = u.organizations.some((o) => publishers[o]?.id === app.publisher?.id);
    const sub = m[2] || '';
    if (sub === '' && req.method === 'GET') return send(res, 200, publicApp(app));
    if (sub === '' && req.method === 'PUT') {
      if (!own) return send(res, 403, { message: 'forbidden' });
      const b = await json(req);
      for (const k of ['name', 'short_description', 'description', 'tags', 'category', 'source_url', 'public']) if (b[k] !== undefined) app[k] = b[k];
      app.updated = now();
      return send(res, 200, publicApp(app));
    }
    if (sub === 'version' && req.method === 'GET') {
      const all = url.searchParams.get('untagged') === 'true';
      return send(res, 200, app.versions.filter((v) => all || v.name).map(({ name, hash: h, timestamp }) => ({ name, hash: h, timestamp })));
    }
    if (sub === 'version' && req.method === 'POST') {
      if (!own) return send(res, 403, { message: 'forbidden' });
      const parts = multipart(req, await body(req));
      if (!parts.app_json || !parts.app_lua) return send(res, 400, { message: 'app_json and app_lua are required' });
      try {
        JSON.parse(parts.app_json);
      } catch {
        return send(res, 400, { message: 'app_json is not valid json' });
      }
      const v = { name: '', hash: hash(), timestamp: now(), app_json: parts.app_json, app_lua: parts.app_lua };
      app.versions.push(v);
      return send(res, 200, { hash: v.hash });
    }
    if (sub === 'publish' && req.method === 'POST') {
      if (!own) return send(res, 403, { message: 'forbidden' });
      const b = await json(req);
      if (app.versions.some((v) => v.name === b.name)) return send(res, 409, { message: 'version name already exists' });
      const v = app.versions.find((x) => x.hash === b.hash);
      if (!v) return send(res, 404, { message: 'unknown hash' });
      v.name = b.name;
      return send(res, 200, { name: v.name, hash: v.hash, timestamp: v.timestamp });
    }
    if (sub === 'configure') {
      const v = app.versions.find((x) => x.name === url.searchParams.get('version'));
      return v ? send(res, 200, JSON.parse(v.app_json)) : send(res, 404, { message: 'unknown version' });
    }
    if (sub === 'download') {
      const v = app.versions.find((x) => x.name === url.searchParams.get('version'));
      return v ? send(res, 200, v.app_lua) : send(res, 404, { message: 'unknown version' });
    }
  }
  return send(res, 404, { message: 'not found' });
}

function githubApi(req, res, p, url) {
  let m;
  if (p === '/github-api/search/repositories') {
    const q = url.searchParams.get('q') || '';
    const topic = /topic:(\S+)/.exec(q)?.[1];
    const owners = [...q.matchAll(/user:(\S+)/g)].map((x) => x[1].toLowerCase());
    const items = Object.keys(repos)
      .filter((k) => repos[k].topics.includes(topic) && (!owners.length || owners.includes(k.split('/')[0].toLowerCase())))
      .map(ghRepo);
    return send(res, 200, { total_count: items.length, items });
  }
  if ((m = /^\/github-api\/repos\/([^/]+)\/([^/]+)(?:\/(releases|tags))?$/.exec(p))) {
    const full = `${m[1]}/${m[2]}`;
    const r = repos[full];
    if (!r) return send(res, 404, { message: 'Not Found' });
    if (!m[3]) return send(res, 200, ghRepo(full));
    const tags = Object.entries(r.releases);
    if (m[3] === 'releases') {
      return send(res, 200, r.tagsOnly ? [] : tags.map(([tag, x]) => ({ tag_name: tag, name: tag, draft: false, prerelease: false, published_at: x.at, body: x.notes })).reverse());
    }
    return send(res, 200, tags.map(([tag]) => ({ name: tag })).reverse());
  }
  if ((m = /^\/github-raw\/([^/]+)\/([^/]+)\/(.+)\/(app\.json|app\.lua|README\.md)$/.exec(p))) {
    const r = repos[`${m[1]}/${m[2]}`];
    const rel = r?.releases[decodeURIComponent(m[3])];
    if (!rel) return send(res, 404, '404: Not Found');
    const content = m[4] === 'app.json' ? JSON.stringify(rel.json, null, 2) : m[4] === 'app.lua' ? rel.lua : r.readme;
    return content === null || content === '' ? send(res, 404, '404: Not Found') : send(res, 200, content);
  }
  return send(res, 404, { message: 'Not Found' });
}

async function dockerApi(req, res, p, url) {
  let m;
  const labelFilter = () => {
    const f = url.searchParams.get('filters');
    return f ? JSON.parse(f).label || [] : [];
  };
  if (p === '/_ping') return send(res, 200, 'OK');
  if (p === '/images/create' && req.method === 'POST') {
    return send(res, 200, `{"status":"Pulling from ${url.searchParams.get('fromImage')}"}\n{"status":"Status: Image is up to date"}\n`);
  }
  if (p === '/volumes/create' && req.method === 'POST') {
    const b = await json(req);
    if (!volumes.has(b.Name)) volumes.set(b.Name, { Name: b.Name, Labels: b.Labels || {} });
    return send(res, 201, volumes.get(b.Name));
  }
  if ((m = /^\/volumes\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
    if ([...containers.values()].some((c) => c.HostConfig.Mounts?.some((x) => x.Source === m[1]))) return send(res, 409, { message: 'volume is in use' });
    return volumes.delete(m[1]) ? send(res, 204, '') : send(res, 404, { message: 'no such volume' });
  }
  if (p === '/containers/json') {
    const want = labelFilter();
    const list = [...containers.values()].filter((c) => want.every((l) => {
      const [k, v] = l.split('=');
      return c.Labels[k] === v;
    }));
    return send(res, 200, list.map((c) => ({ Id: c.Id, Names: [`/${c.Name}`], Image: c.Image, Labels: c.Labels, State: c.state })));
  }
  if (p === '/containers/create' && req.method === 'POST') {
    const name = url.searchParams.get('name');
    if ([...containers.values()].some((c) => c.Name === name)) return send(res, 409, { message: `Conflict. The container name "/${name}" is already in use` });
    const b = await json(req);
    const id = randomBytes(32).toString('hex');
    const vol = b.HostConfig?.Mounts?.find((x) => x.Target === '/etc/iot-open')?.Source;
    containers.set(id, { Id: id, Name: name, Image: b.Image, Labels: b.Labels || {}, Env: b.Env, HostConfig: b.HostConfig || {}, state: 'created', created: new Date().toISOString(), restarts: 0, config: vol ? volumes.get(vol)?.config : null, vol });
    return send(res, 201, { Id: id, Warnings: [] });
  }
  if ((m = /^\/containers\/([0-9a-f]+)(?:\/([a-z]+))?$/.exec(p))) {
    const c = containers.get(m[1]) || [...containers.values()].find((x) => x.Id.startsWith(m[1]));
    if (!c) return send(res, 404, { message: `No such container: ${m[1]}` });
    const sub = m[2] || '';
    if (sub === 'json') {
      return send(res, 200, {
        Id: c.Id, Name: `/${c.Name}`, Created: c.created, RestartCount: c.restarts, Config: { Image: c.Image, Labels: c.Labels },
        Mounts: c.vol ? [{ Type: 'volume', Name: c.vol, Destination: '/etc/iot-open' }] : [],
        State: { Status: c.state, Running: c.state === 'running', Restarting: false, StartedAt: c.startedAt || '0001-01-01T00:00:00Z', FinishedAt: c.finishedAt || '0001-01-01T00:00:00Z', ExitCode: c.state === 'exited' ? 0 : 0, Error: '' },
      });
    }
    if (sub === 'archive' && req.method === 'PUT') {
      const files = parseTar(await body(req));
      if (files['iotopen.json']) {
        c.config = JSON.parse(files['iotopen.json']);
        if (c.vol && volumes.has(c.vol)) volumes.get(c.vol).config = c.config;
      }
      return send(res, 200, '');
    }
    if (sub === 'logs') return send(res, 200, dockerLogs(c), { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
    if (sub === 'start') {
      if (c.state === 'running') return send(res, 304, '');
      Object.assign(c, { state: 'running', startedAt: new Date().toISOString() });
      return send(res, 204, '');
    }
    if (sub === 'stop') {
      if (c.state !== 'running') return send(res, 304, '');
      Object.assign(c, { state: 'exited', finishedAt: new Date().toISOString() });
      return send(res, 204, '');
    }
    if (sub === 'restart') {
      Object.assign(c, { state: 'running', startedAt: new Date().toISOString(), restarts: c.restarts + 1 });
      return send(res, 204, '');
    }
    if (sub === '' && req.method === 'DELETE') {
      if (c.state === 'running' && url.searchParams.get('force') !== 'true') return send(res, 409, { message: 'container is running' });
      containers.delete(c.Id);
      return send(res, 204, '');
    }
  }
  return send(res, 404, { message: 'page not found' });
}

export function createMock() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
      if (p.startsWith('/api/')) return await lynxApi(req, res, p, url);
      if (p.startsWith('/github-')) return githubApi(req, res, p, url);
      if (p.startsWith('/docker/')) return await dockerApi(req, res, p.replace(/^\/docker(\/v[\d.]+)?/, ''), url);
      send(res, 404, { message: 'not found' });
    } catch (e) {
      console.error(e);
      send(res, 500, { message: e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMock().listen(PORT, () => console.log(`IoT Open + GitHub + Docker mock on :${PORT}  (demo@example.com / demo, API key demo-api-key)`));
}
