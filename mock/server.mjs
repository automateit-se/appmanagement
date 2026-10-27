// Local mock of the three services App Management talks to, for development, the demo and the tests.
// No dependencies. Everything is in memory and made up.
//
//   /api/v2/...        IoT Open (Lynx): sign-in, installations, devices, functions, edge apps, gateway credentials
//   /github-api/...    GitHub REST API: topic search, repositories, releases, tags
//   /github-raw/...    raw.githubusercontent.com: app.json, app.lua, README.md per tag
//   /docker/...        Docker Engine API: containers, volumes, images, logs, archive
//   /mqtt              MQTT over WebSocket: retained edge status on <client_id>/box/event/status
//
// Logins: demo@example.com / demo, API key demo-api-key, twofa@example.com / demo + code 123456.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------- IoT Open

const users = [
  { id: 1, email: 'demo@example.com', password: 'demo', first_name: 'Demo', last_name: 'Användare', organizations: [10] },
  { id: 2, email: 'twofa@example.com', password: 'demo', first_name: 'Två', last_name: 'Faktor', organizations: [10], twofa: '123456' },
  // roles like IoT Open's: an owner of one installation, and a read-only user
  { id: 3, email: 'owner@example.com', password: 'demo', first_name: 'Ägare', last_name: 'Exempel', organizations: [10], role: 47, assigned: [1001] },
  { id: 4, email: 'viewer@example.com', password: 'demo', first_name: 'Läsare', last_name: 'Exempel', organizations: [10], role: 48, assigned: [1001, 1002] },
];
const tokens = new Map([['demo-api-key', 1], ['owner-api-key', 3], ['viewer-api-key', 4]]);

// IoT Open roles (the permissions App Management looks at), keyed by role id
const ROLE_PERMS = {
  27: { name: 'admin', all: true },
  47: { name: 'owner', assigned: ['gateway/reset/password', 'edge/app/configured/create_delete', 'edge/app/configured/update', 'edge/app/configured/list'], plain: ['edge/app/create'] },
  48: { name: 'read_only', assigned: ['edge/app/configured/list'], plain: [] },
};
function rolePermissions(id) {
  const r = ROLE_PERMS[id];
  const names = ['gateway/reset/password', 'edge/app/configured/create_delete', 'edge/app/configured/update', 'edge/app/configured/list'];
  const p = {};
  for (const n of names) {
    p[`${n}/all`] = !!r.all;
    p[`${n}/assigned`] = !!r.all || r.assigned.includes(n);
  }
  p['edge/app/create'] = !!r.all || r.plain.includes('edge/app/create');
  // external permissions have no /all or /assigned and can be wildcards
  if (r.all) p['external/example/*'] = true;
  if (r.name === 'owner') p['external/example/edge/manager'] = true;
  return { id: Number(id), name: r.name, priority: 50, permissions: p };
}
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

// the publisher of an organization's apps is the organization itself (publisher.id = organization id)
const publishers = { 10: { id: 10, name: 'Exempelbolaget AB' } };
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
  {
    // the same app as example-vendor/edge-app-door-counter on GitHub, published by its vendor without source_url
    id: 2, name: 'Door counter', category: 'counter', tags: ['counter'], short_description: 'Counts door openings',
    description: '# Door counter', publisher: { id: 1, name: 'IoT Open' }, official: true, public: true, source_url: '',
    created: now() - 86400 * 50, updated: now() - 86400 * 50,
    versions: [{ name: '1.0.0', hash: hash(), timestamp: now() - 86400 * 50, app_json: JSON.stringify({ input: {}, guide: [] }), app_lua: '-- door counter 1.0.0\n' }],
  },
  {
    // published from GitHub by another organization (like IoT Open's own apps): installed from IoT Open, not copied
    id: 3, name: 'Value logger', category: 'logger', tags: ['logger'], short_description: 'Logs values to a file',
    description: '# Value logger', publisher: { id: 3, name: 'IoT Open' }, official: false, public: true,
    source_url: 'https://github.com/example-org/value-logger', created: now() - 86400 * 30, updated: now() - 86400 * 30,
    versions: [{ name: '1.2.0', hash: hash(), timestamp: now() - 86400 * 30, app_json: JSON.stringify({ input: { level: { type: 'toggle', name: 'Level', true_value: 'high', false_value: 'low' } }, guide: [] }), app_lua: '-- value logger\n' }],
  },
];
let nextAppId = 4;
const instances = [{ id: 9001, app_id: 1, installation_id: 1001, version: '1.0.0', name: 'Väderdata', config: { city: 'Stockholm', interval: 30 }, created: now() - 86400 * 100, updated: now() - 86400 * 100 }];
let nextInstanceId = 9002;

const publicApp = ({ versions, ...a }) => a;

// Edge status as the edge client's mosquitto bridge publishes it (retained "1" / "0").
// "Kontoret" (1002) already has an edge client somewhere that is online; "Demohuset" (1001) has none.
const retained = new Map([['5002/box/event/status', '1']]);
const mqttClients = new Set();
const subscribed = (c, topic) => [...c.topics].some((pat) => mqttMatch(pat, topic));
function mqttMatch(pattern, topic) {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length || (p[i] !== '+' && p[i] !== t[i])) return false;
  }
  return p.length === t.length;
}
function setEdgeStatus(clientId, online) {
  const topic = `${clientId}/box/event/status`;
  retained.set(topic, online ? '1' : '0');
  for (const c of mqttClients) if (c.authed && subscribed(c, topic)) mqttSend(c, topic, online ? '1' : '0', true);
}

// What edge apps publish on obj/… and evt/…: IoT Open's message history (GET /api/v3beta/log) and live on MQTT.
// "Demohuset" has a door counter logging on obj and raising alarms on evt, "Kontoret" a weather app on obj.
const messageLog = []; // { client_id, installation_id, topic, value, msg, timestamp }, oldest first
function publishApp(inst, topic, value, msg, at = Date.now()) {
  const m = { client_id: inst.client_id, installation_id: inst.id, topic: `${inst.client_id}/${topic}`, value, msg, timestamp: at / 1000 };
  messageLog.push(m);
  if (messageLog.length > 20000) messageLog.splice(0, messageLog.length - 20000);
  const text = JSON.stringify({ value, msg, timestamp: m.timestamp });
  for (const c of mqttClients) if (c.authed && subscribed(c, m.topic)) mqttSend(c, m.topic, text, false);
}
let doorCount = 0;
function appTraffic(at) {
  const [demo, office] = [installations[0], installations[1]];
  doorCount++;
  publishApp(demo, 'obj/doorcounter/9001/log', doorCount, `Door opened, ${doorCount} today`, at);
  if (doorCount % 5 === 0) publishApp(demo, 'evt/doorcounter/9001/alarm', 1, 'Door held open for 60 s', at);
  publishApp(office, 'obj/weather/office/temperature', 18 + (doorCount % 7) / 2, '', at);
}
// three hours of history, then a message every few seconds
for (let t = Date.now() - 3 * 3600_000; t < Date.now(); t += 5 * 60_000) appTraffic(t);

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
  'example-org/light-control': {
    description: 'Tänder lampor när en dörr öppnas',
    topics: ['iotopen-edge-app', 'lights'],
    readme: '# Light control\n\nTänder valda lampor med valda värden när en dörr öppnas, och skickar en notis.\n',
    releases: {
      'v2.0.0': {
        json: {
          author: 'Exempelbolaget',
          licence: 'MIT',
          input: {
            door: { type: 'single_function_selector', name: 'Dörr', description: 'Dörren som tänder lamporna', required: true },
            lights: { type: 'multi_function_selector', name: 'Lampor', description: 'Lampor och värdet de ska få', value: true, required: true },
            timeout: { type: 'number', name: 'Tid (minuter)', description: 'Hur länge lamporna lyser', default: '10' },
            days: { type: 'checkbox', name: 'Dagar', description: 'Dagar appen är aktiv', values: { mon: 'Mån', tue: 'Tis', wed: 'Ons', thu: 'Tor', fri: 'Fre', sat: 'Lör', sun: 'Sön' }, default: ['mon', 'tue', 'wed', 'thu', 'fri'] },
            trigger_value: { type: 'single_function_selector', name: 'Givare', description: 'Givare och värde', value: true, filter: { type: 'temperature' } },
            temp: { type: 'repeat', name: 'Temperaturvillkor', description: 'Givare och värden som också tänder lamporna', min: 1, max: 3, input_fields: ['trigger_value'] },
            notification: { type: 'single_notification_output_selector', name: 'Notis', description: 'Var en notis skickas' },
            message: { type: 'text', name: 'Meddelande', multiline: true, default: 'Dörren öppnades' },
          },
          guide: [
            { id: 'stage_1', title: 'Funktioner', description: 'Välj dörr och lampor.', input_fields: ['door', 'lights', 'temp'] },
            { id: 'stage_2', title: 'Tider och notiser', description: '', input_fields: ['timeout', 'days', 'notification', 'message'] },
          ],
        },
        lua: '-- light control 2.0.0\n', at: '2026-09-20T10:00:00Z', notes: '',
      },
    },
  },
  // Installed from commits first, then released: v0.1.0 has the code of commit 2562ba3 (only a changelog was added).
  'example-org/broker-tuning': {
    description: 'Sets the broker queue',
    topics: ['iotopen-edge-app', 'mqtt'],
    readme: '# Broker tuning\n',
    commits: {
      f331424aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { json: { input: {}, guide: [] }, lua: '-- broker tuning\nreturn M\n' },
      '2562ba3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { json: { input: {}, guide: [] }, lua: '-- broker tuning\n' },
    },
    releases: { 'v0.1.0': { json: { input: {}, guide: [] }, lua: '-- broker tuning\n', at: '2026-10-27T17:00:00Z', notes: 'First version.' } },
  },
  'example-org/value-logger': {
    description: 'Logs values to a file',
    topics: ['iotopen-edge-app', 'logger'],
    readme: '# Value logger\n',
    releases: { 'v1.2.0': { json: { input: {}, guide: [] }, lua: '-- value logger\n', at: '2026-09-01T10:00:00Z', notes: '' } },
  },
  // Like IoT Open's own edge apps: no topic, no releases or tags, branch "master", metadata in edge-app.json.
  // Listed through GITHUB_INCLUDE=example-vendor/edge-app-*.
  'example-vendor/edge-app-door-counter': {
    description: 'Edge app counting door openings',
    topics: [],
    defaultBranch: 'master',
    readme: '# Door counter\n\nCounts how many times a door has been opened, per day and in total.\n',
    manifest: {
      category: 'counter',
      description: '# Door counter\n\nCounts door openings per day and in total. The count can be reset.',
      name: 'Door counter',
      public: true,
      publisher: { id: 1 },
      short_description: 'Counts door openings',
      source_url: '',
      tags: ['counter', 'door'],
    },
    head: { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', date: '2026-08-27T09:00:00Z', message: 'Reset at midnight' },
    releases: {},
    branchFiles: {
      json: {
        author: 'Example Vendor',
        licence: 'MIT',
        input: {
          doors: { type: 'multi_function_selector', name: 'Doors', description: 'Doors to count', required: true, filter: { type: ['door', 'switch'] } },
          reset: { type: 'toggle', name: 'Reset at midnight', default: true, true_value: 'Ja', false_value: 'Nej' },
        },
        guide: [{ id: 'stage_1', title: 'Doors', description: '', input_fields: ['doors', 'reset'] }],
      },
      lua: '-- door counter (master)\n',
    },
  },
  'example-vendor/not-an-app': { description: 'Not matching the include pattern', topics: [], defaultBranch: 'master', readme: '', releases: {} },
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
    full_name: full, name, owner: { login: owner }, description: r.description, topics: r.topics, default_branch: r.defaultBranch || 'main',
    html_url: `https://github.com/${full}`, stargazers_count: 3, pushed_at: '2026-09-15T10:00:00Z', archived: false, license: { spdx_id: 'MIT' },
  };
};

/** Files of a repository at a ref: a release tag, the default branch or the head commit. */
function filesAt(r, ref) {
  if (r.releases[ref]) return { ...r.releases[ref], manifest: r.manifest };
  if (r.commits?.[ref]) return { ...r.commits[ref], manifest: r.manifest };
  if (ref === (r.defaultBranch || 'main') || ref === r.head?.sha) {
    if (r.branchFiles) return { ...r.branchFiles, manifest: r.manifest };
    const last = Object.values(r.releases).at(-1);
    return last ? { ...last, manifest: r.manifest } : null;
  }
  return null;
}

// ---------------------------------------------------------------- Docker

const containers = new Map(); // id -> container
const volumes = new Map();
const networks = new Map([['bridge', { Name: 'bridge', Driver: 'bridge' }]]);

// Edge apps on a running mock edge client: one process per instance of its installation, like IoT Open's edged.
// An instance whose name contains "alarm" crashes over and over (edged restarts it every 10 seconds).
const crashes = (inst) => /alarm/i.test(inst.name);
function mockAppProcesses(c, { log = false } = {}) {
  // a stopped container keeps its log
  if ((c.state !== 'running' && !log) || !c.config || !c.startedAt) return [];
  const since = Date.parse(c.startedAt || 0);
  return instances
    .filter((i) => i.installation_id === Number(c.config.installation_id))
    .map((i) => ({ inst: i, started: Math.max(since, i.updated * 1000), crashing: crashes(i), pid: 100 + (i.id % 1000) }));
}

function dockerTop(c) {
  const now = Date.now();
  const rows = [
    ['2001', '18200', String(Math.round((now - Date.parse(c.startedAt)) / 1000)), '/usr/bin/python3 /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf'],
    ['2002', '9100', '60', '/usr/bin/iotopen-rt /usr/bin/edged'],
  ];
  for (const a of mockAppProcesses(c)) {
    if (a.crashing) continue;
    rows.push([String(3000 + a.pid), String(14000 + (a.inst.id % 7) * 1000), String(Math.round((now - a.started) / 1000)), `/usr/bin/iotopen-rt edge-app -a /var/lib/iot-open/edge/configs/${a.inst.id} -r 5`]);
  }
  return { Titles: ['PID', 'RSS', 'ELAPSED', 'COMMAND'], Processes: rows };
}

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
    const at = (ms) => new Date(ms).toISOString();
    const apps = [];
    for (const a of mockAppProcesses(c, { log: true })) {
      const id = a.inst.id;
      if (!a.crashing) {
        apps.push([a.started, 2, `edge-app-${id}[${a.pid}]: Starting edge app ${id}`]);
        apps.push([a.started + 500, 2, `edge-app-${id}[${a.pid}]: ${a.inst.name} started`]);
        continue;
      }
      // a crash loop: started, failed, restarted by edged 10 seconds later
      const end = c.state === 'running' ? Date.now() : Date.parse(c.finishedAt);
      for (let t = a.started, n = 0; t <= end && n < 12; t += 10_000, n++) {
        const pid = a.pid + n;
        apps.push([t, 2, `edge-app-${id}[${pid}]: Starting edge app ${id}`]);
        apps.push([t + 200, 2, `edge-app-${id}[${pid}]: error running app code: /var/lib/iot-open/edge/apps/${a.inst.app_id}-${a.inst.version}:42: attempt to index a nil value (global 'sensor')`]);
        apps.push([t + 300, 2, `edged[12]: pid ${pid} died with 1`]);
      }
    }
    apps.sort((x, y) => x[0] - y[0]);
    for (const [t, stream, text] of apps) lines.push([stream, `${at(t)} ${text}`]);
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

function logApi(res, iid, url) {
  const inst = installations.find((i) => i.id === Number(iid));
  const from = Number(url.searchParams.get('from') || Date.now() / 1000 - 86400);
  const to = Number(url.searchParams.get('to') || Date.now() / 1000);
  const limit = Math.min(10000, Number(url.searchParams.get('limit') || 10000));
  const topics = url.searchParams.getAll('topics').flatMap((t) => t.split(','));
  let list = messageLog.filter((m) => m.installation_id === inst.id && m.timestamp >= from && m.timestamp <= to && (!topics.length || topics.includes(m.topic)));
  list = list.reverse(); // newest first, like IoT Open
  const data = list.slice(0, limit);
  return send(res, 200, { count: data.length, total: list.length, last: data.at(-1)?.timestamp || 0, data });
}

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
  if ((m = /^\/api\/v3beta\/log\/(\d+)$/.exec(p))) {
    if (!canSee(u, m[1])) return send(res, 403, { message: 'forbidden' });
    return logApi(res, m[1], url);
  }
  if ((m = /^\/api\/v2\/status\/(\d+)$/.exec(p))) {
    if (!canSee(u, m[1])) return send(res, 403, { message: 'forbidden' });
    const last = new Map();
    for (const x of messageLog) if (x.installation_id === Number(m[1]) && x.topic.split('/')[1] === 'obj') last.set(x.topic, x);
    return send(res, 200, [...last.values()].map((x) => ({ ...x, value: String(x.value), timestamp: String(x.timestamp) })));
  }
  if (p === '/api/v2/user/me') {
    return send(res, 200, {
      id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, organisations: u.organizations,
      role: u.role || 27, assigned_installations: u.assigned || installations.filter((i) => u.organizations.includes(i.organization_id)).map((i) => i.id),
    });
  }
  if ((m = /^\/api\/v2\/role\/(\d+)$/.exec(p))) {
    // a user can read its own role; an admin every role
    const own = Number(m[1]) === (u.role || 27);
    if (!ROLE_PERMS[m[1]] || (!own && (u.role || 27) !== 27)) return send(res, 403, { message: 'forbidden' });
    return send(res, 200, rolePermissions(m[1]));
  }
  if (p === '/api/v2/installationinfo') return send(res, 200, installations.filter((i) => u.organizations.includes(i.organization_id)));
  if ((m = /^\/api\/v2\/(devicex|functionx)\/(\d+)$/.exec(p))) {
    if (!canSee(u, m[2])) return send(res, 403, { message: 'forbidden' });
    return send(res, 200, (m[1] === 'devicex' ? devices : functions)[m[2]] || []);
  }
  if ((m = /^\/api\/v2\/gateway\/credentials\/(\d+)$/.exec(p)) && req.method === 'POST') {
    const inst = installations.find((i) => i.id === Number(m[1]));
    if (!inst || !canSee(u, inst.id)) return send(res, 403, { message: 'forbidden' });
    const host = req.headers.host || 'localhost';
    // the old credentials stop working: an edge client using them drops off (a mock container reconnects on start)
    if (retained.get(`${inst.client_id}/box/event/status`) === '1') setEdgeStatus(inst.client_id, false);
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
  if ((m = /^\/api\/v2\/notification\/(\d+)\/output$/.exec(p))) {
    if (!canSee(u, m[1])) return send(res, 403, { message: 'forbidden' });
    return send(res, 200, [{ id: 401, installation_id: Number(m[1]), name: 'E-post till driften', notification_executor_id: 1, config: {} }]);
  }
  if (p === '/api/v2/edge/app' && req.method === 'PUT') {
    // update takes the id in the body
    const b = await json(req);
    const app = edgeApps.find((a) => a.id === Number(b.id));
    if (!app) return send(res, 404, { message: 'not found' });
    if (!u.organizations.some((o) => publishers[o]?.id === app.publisher?.id)) return send(res, 403, { message: 'forbidden' });
    for (const k of ['name', 'short_description', 'description', 'tags', 'category', 'source_url', 'public']) if (b[k] !== undefined) app[k] = b[k];
    app.updated = now();
    return send(res, 200, publicApp(app));
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
      // identical to the latest upload: 204, no new version
      const last = app.versions[app.versions.length - 1];
      if (last && last.app_json === parts.app_json && last.app_lua === parts.app_lua) return send(res, 204, '');
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
    const inName = /(\S+) in:name/.exec(q)?.[1]?.toLowerCase();
    const items = Object.keys(repos)
      .filter((k) => (!topic || repos[k].topics.includes(topic)) && (!owners.length || owners.includes(k.split('/')[0].toLowerCase())))
      .filter((k) => !inName || k.split('/')[1].toLowerCase().includes(inName))
      .map(ghRepo);
    return send(res, 200, { total_count: items.length, items });
  }
  if ((m = /^\/github-api\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/.exec(p))) {
    const r = repos[`${m[1]}/${m[2]}`];
    const ref = decodeURIComponent(m[3]);
    const sha = r?.commits && Object.keys(r.commits).find((k) => k.startsWith(ref.toLowerCase()) && ref.length >= 7);
    if (sha) return send(res, 200, { sha, commit: { message: '', committer: { date: '2026-10-27T16:00:00Z' } } });
    if (!r || ref !== (r.defaultBranch || 'main')) return send(res, 404, { message: 'Not Found' });
    const h = r.head || { sha: 'f'.repeat(40), date: '2026-09-15T10:00:00Z', message: '' };
    return send(res, 200, { sha: h.sha, commit: { message: h.message, committer: { date: h.date } } });
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
  if ((m = /^\/github-raw\/([^/]+)\/([^/]+)\/(.+)\/(app\.json|app\.lua|README\.md|edge-app\.json|edge_app\.json)$/.exec(p))) {
    const r = repos[`${m[1]}/${m[2]}`];
    const f = r && filesAt(r, decodeURIComponent(m[3]));
    if (!f) return send(res, 404, '404: Not Found');
    const content = {
      'app.json': f.json ? JSON.stringify(f.json, null, 2) : null,
      'app.lua': f.lua,
      'README.md': r.readme,
      'edge-app.json': f.manifest ? JSON.stringify(f.manifest, null, 2) : null,
      'edge_app.json': null,
    }[m[4]];
    return content === null || content === undefined || content === '' ? send(res, 404, '404: Not Found') : send(res, 200, content);
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
  if ((m = /^\/networks\/([^/]+)$/.exec(p)) && req.method === 'GET') {
    return networks.has(m[1]) ? send(res, 200, networks.get(m[1])) : send(res, 404, { message: `network ${m[1]} not found` });
  }
  if (p === '/networks/create' && req.method === 'POST') {
    const b = await json(req);
    if (networks.has(b.Name)) return send(res, 409, { message: 'network with name already exists' });
    networks.set(b.Name, { Name: b.Name, Id: randomBytes(32).toString('hex'), Driver: b.Driver, Labels: b.Labels || {} });
    return send(res, 201, { Id: networks.get(b.Name).Id });
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
    const net = b.HostConfig?.NetworkMode;
    if (net && !['bridge', 'host', 'none', 'default'].includes(net) && !networks.has(net)) return send(res, 404, { message: `network ${net} not found` });
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
    if (sub === 'top') {
      if (c.state !== 'running') return send(res, 409, { message: `Container ${c.Id} is not running` });
      return send(res, 200, dockerTop(c));
    }
    if (sub === 'stats') {
      const apps = mockAppProcesses(c).filter((a) => !a.crashing).length;
      return send(res, 200, { memory_stats: c.state === 'running' ? { usage: (40 + 6 * apps) * 1048576, limit: 256 * 1048576, stats: { inactive_file: 2 * 1048576 } } : {} });
    }
    if (sub === 'start') {
      if (c.state === 'running') return send(res, 304, '');
      // like Docker: a host port taken by another container, or by something else on the host (18099 here)
      const hostPorts = (x) => Object.values(x.HostConfig.PortBindings || {}).flat().map((b) => Number(b.HostPort));
      const busy = hostPorts(c).find((hp) => hp === 18099 || [...containers.values()].some((o) => o !== c && o.state === 'running' && hostPorts(o).includes(hp)));
      if (busy) return send(res, 500, { message: `driver failed programming external connectivity on endpoint ${c.Name}: Bind for 0.0.0.0:${busy} failed: port is already allocated` });
      Object.assign(c, { state: 'running', startedAt: new Date().toISOString() });
      if (c.config) setEdgeStatus(c.config.client_id, true);
      return send(res, 204, '');
    }
    if (sub === 'stop') {
      if (c.state !== 'running') return send(res, 304, '');
      Object.assign(c, { state: 'exited', finishedAt: new Date().toISOString() });
      if (c.config) setEdgeStatus(c.config.client_id, false);
      return send(res, 204, '');
    }
    if (sub === 'restart') {
      Object.assign(c, { state: 'running', startedAt: new Date().toISOString(), restarts: c.restarts + 1 });
      if (c.config) setEdgeStatus(c.config.client_id, true);
      return send(res, 204, '');
    }
    if (sub === '' && req.method === 'DELETE') {
      if (c.state === 'running' && url.searchParams.get('force') !== 'true') return send(res, 409, { message: 'container is running' });
      containers.delete(c.Id);
      if (c.config && c.state === 'running') setEdgeStatus(c.config.client_id, false);
      return send(res, 204, '');
    }
  }
  return send(res, 404, { message: 'page not found' });
}

// ---------------------------------------------------------------- MQTT over WebSocket

function wsSend(socket, bytes) {
  const len = bytes.length;
  const head = len < 126 ? Buffer.from([0x82, len]) : Buffer.from([0x82, 126, len >> 8, len & 255]);
  socket.write(Buffer.concat([head, Buffer.from(bytes)]));
}
const mstr = (s) => {
  const b = Buffer.from(s);
  return [b.length >> 8, b.length & 255, ...b];
};
const mlen = (n) => {
  const o = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    o.push(d);
  } while (n > 0);
  return o;
};
function mqttSend(c, topic, text, retain) {
  const t = mstr(topic);
  const p = [...Buffer.from(text)];
  wsSend(c.socket, [retain ? 0x31 : 0x30, ...mlen(t.length + p.length), ...t, ...p]);
}
function handleMqtt(c, type, body) {
  if (type === 1) {
    // CONNECT: the password is the IoT Open token
    let o = 10;
    o += 2 + ((body[o] << 8) | body[o + 1]);
    o += 2 + ((body[o] << 8) | body[o + 1]);
    const pl = (body[o] << 8) | body[o + 1];
    c.authed = tokens.has(body.subarray(o + 2, o + 2 + pl).toString());
    wsSend(c.socket, [0x20, 2, 0, c.authed ? 0 : 5]);
  } else if (type === 8) {
    const rc = [];
    const fresh = [];
    for (let o = 2; o < body.length; ) {
      const l = (body[o] << 8) | body[o + 1];
      const t = body.subarray(o + 2, o + 2 + l).toString();
      c.topics.add(t);
      fresh.push(t);
      o += 3 + l;
      rc.push(0);
    }
    wsSend(c.socket, [0x90, 2 + rc.length, body[0], body[1], ...rc]);
    for (const t of fresh) for (const [rt, v] of retained) if (mqttMatch(t, rt)) mqttSend(c, rt, v, true);
  } else if (type === 12) wsSend(c.socket, [0xd0, 0]);
}
function mqttUpgrade(req, socket) {
  if (!req.url.startsWith('/mqtt')) return socket.destroy();
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`);
  const c = { socket, topics: new Set(), authed: false };
  mqttClients.add(c);
  let wsBuf = Buffer.alloc(0);
  let mq = Buffer.alloc(0);
  socket.on('data', (d) => {
    wsBuf = Buffer.concat([wsBuf, d]);
    for (;;) {
      if (wsBuf.length < 2) break;
      const op = wsBuf[0] & 15;
      let len = wsBuf[1] & 127;
      let o = 2;
      if (len === 126) {
        if (wsBuf.length < 4) break;
        len = wsBuf.readUInt16BE(2);
        o = 4;
      }
      if (wsBuf.length < o + 4 + len) break;
      const mask = wsBuf.subarray(o, o + 4);
      const data = Buffer.from(wsBuf.subarray(o + 4, o + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      wsBuf = wsBuf.subarray(o + 4 + len);
      if (op === 8) return socket.end();
      if (op !== 2 && op !== 0) continue;
      mq = Buffer.concat([mq, data]);
      for (;;) {
        if (mq.length < 2) break;
        let mul = 1;
        let l = 0;
        let i = 1;
        let b;
        do {
          if (i >= mq.length) {
            b = -1;
            break;
          }
          b = mq[i++];
          l += (b & 127) * mul;
          mul *= 128;
        } while (b & 128);
        if (b === -1 || mq.length < i + l) break;
        handleMqtt(c, mq[0] >> 4, mq.subarray(i, i + l));
        mq = mq.subarray(i + l);
      }
    }
  });
  const drop = () => mqttClients.delete(c);
  socket.on('close', drop);
  socket.on('error', drop);
}

export function createMock() {
  const server = http.createServer(async (req, res) => {
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
  server.on('upgrade', mqttUpgrade);
  const traffic = setInterval(() => appTraffic(Date.now()), Number(process.env.MOCK_TRAFFIC_MS) || 3000);
  traffic.unref();
  server.on('close', () => clearInterval(traffic));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMock().listen(PORT, () => console.log(`IoT Open (REST + MQTT) + GitHub + Docker mock on :${PORT}  (demo@example.com / demo, API key demo-api-key)`));
}
