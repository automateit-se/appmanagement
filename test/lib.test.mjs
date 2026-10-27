import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isCommitVersion, isNewerVersion, sortVersionsDesc, versionName } from '../shared/version.js';
import { cleanValues, formLayout, initialValues, inputKind, matchesFilter, validate } from '../src/lib/configForm.js';
import { ensureGithubVersion, githubRepo, latestVersion, normUrl } from '../src/lib/install.js';
import { demuxLogs, splitImage } from '../server/docker.mjs';
import { makeTar } from '../server/tar.mjs';
import { checkPorts, parsePorts } from '../server/edgeClient.mjs';
import { checkOrigin, loadConfig, parseDockerHost } from '../server/config.mjs';
import { parseInclude, prettyName, readManifest } from '../server/github.mjs';
import { parseStatus } from '../server/presence.mjs';

test('version names and ordering', () => {
  assert.equal(versionName('v1.2.0'), '1.2.0');
  assert.equal(versionName('version-2'), 'version-2');
  assert.ok(compareVersions('1.10.0', '1.9.2') > 0);
  assert.ok(compareVersions('v2.0.0', '1.99') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc1') > 0);
  assert.ok(compareVersions('1.0', '1.0.1') < 0);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
  assert.deepEqual(sortVersionsDesc(['1.0.0', '1.10.0', '1.2.0']), ['1.10.0', '1.2.0', '1.0.0']);
});

test('updates for apps without releases (commit versions)', () => {
  const a = 'commit-20261027-f331424';
  const b = 'commit-20261027-2562ba3';
  assert.ok(isCommitVersion(a) && !isCommitVersion('0.1.0'));
  // same day: the hash cannot be ordered, so the head commit on GitHub is newer than any other installed commit
  assert.equal(isNewerVersion(b, a, { headCommit: true }), true);
  assert.equal(isNewerVersion(b, a), false); // not known to be the head (e.g. a version list in IoT Open)
  assert.equal(isNewerVersion(a, a, { headCommit: true }), false);
  // another day: the date decides
  assert.equal(isNewerVersion('commit-20261028-0000001', a), true);
  assert.equal(isNewerVersion(a, 'commit-20261028-0000001', { headCommit: true }), false);
  // the app got releases: any release replaces a commit, a commit never replaces a release
  assert.equal(isNewerVersion('0.1.0', a), true);
  assert.equal(isNewerVersion(a, '0.1.0', { headCommit: true }), false);
  // releases as before
  assert.equal(isNewerVersion('0.2.0', '0.1.9'), true);
  assert.equal(isNewerVersion('0.1.9', '0.1.9'), false);
  assert.equal(isNewerVersion(undefined, '0.1.9'), false);
});

const options = {
  input: {
    sensor: { type: 'single_function_selector', name: 'Givare', required: true, filter: { type: 'temperature' } },
    meters: { type: 'multi_function_selector', name: 'Mätare' },
    limit: { type: 'number', name: 'Gräns', required: true, default: 25, min: -40, max: 100 },
    level: { type: 'option', name: 'Nivå', values: { 1: 'Varning', 2: 'Kritisk' }, default: 1 },
    notify: { type: 'toggle', name: 'Notis', default: true, true_value: 'yes', false_value: 'no' },
    label: { type: 'text', name: 'Namn', validator: '^.{1,5}$', on_error: 'Max 5 tecken' },
    rows: { type: 'repeat', name: 'Rader', input_fields: ['row_value'] },
    row_value: { type: 'number', name: 'Värde' },
  },
  guide: [
    { id: 'a', title: 'Givare', input_fields: ['sensor', 'limit', 'nonexistent'] },
    { id: 'b', title: 'Larm', input_fields: ['level', 'notify', 'label'] },
  ],
};

test('input kinds', () => {
  assert.equal(inputKind({ type: 'single_function_selector' }), 'function');
  assert.equal(inputKind({ type: 'multi_function_selector' }), 'functions');
  assert.equal(inputKind({ type: 'single_device_selector' }), 'device');
  assert.equal(inputKind({ type: 'multi_device_selector' }), 'devices');
  assert.equal(inputKind({ type: 'option' }), 'option');
  assert.equal(inputKind({ type: 'repeat' }), 'repeat');
  assert.equal(inputKind({ type: 'checkbox' }), 'checkbox');
  assert.equal(inputKind({ type: 'single_notification_output_selector' }), 'notification');
  assert.equal(inputKind({ type: 'multi_notification_output_selector' }), 'notifications');
  assert.equal(inputKind({ type: 'something_new' }), 'json');
  assert.equal(inputKind({}), 'text');
});

test('form layout puts inputs outside the guide on a last page', () => {
  const { pages } = formLayout(options);
  assert.deepEqual(
    pages.map((p) => [p.id, p.fields]),
    [
      ['a', ['sensor', 'limit']],
      ['b', ['level', 'notify', 'label']],
      ['other', ['meters', 'rows']],
    ],
  );
  assert.deepEqual(formLayout(null).pages, []);
});

test('initial values keep existing config and fill defaults', () => {
  const v = initialValues(options, { limit: 30 });
  assert.equal(v.limit, 30);
  assert.equal(v.level, 1);
  assert.equal(v.notify, 'yes');
  assert.deepEqual(v.meters, []);
  assert.equal(v.sensor, undefined);
});

test('validation', () => {
  const errs = validate(options, { limit: 200, level: 3, label: 'too long', notify: 'no' });
  assert.equal(errs.sensor, 'Måste fyllas i');
  assert.equal(errs.limit, 'Högst 100');
  assert.equal(errs.level, 'Välj ett av alternativen');
  assert.equal(errs.label, 'Max 5 tecken');
  assert.deepEqual(validate(options, { sensor: 302, limit: '20', level: '2', label: 'ok' }), {});
});

test('clean values: numbers as numbers, option keys typed like the default', () => {
  const v = cleanValues(options, { sensor: 302, limit: '20', level: '2', label: '' });
  assert.equal(v.limit, 20);
  assert.equal(v.level, 2);
  assert.equal('label' in v, false);
});

test('filters on type and metadata', () => {
  const fn = { id: 1, type: 'temperature', meta: { room: 'Hall' } };
  assert.ok(matchesFilter(fn, { type: 'temperature' }));
  assert.ok(matchesFilter(fn, { room: '*' }));
  assert.ok(!matchesFilter(fn, { type: 'switch' }));
  assert.ok(matchesFilter(fn, { type: ['switch', 'temperature'] }));
  assert.ok(matchesFilter(fn, undefined));
});

test('github urls', () => {
  assert.deepEqual(githubRepo('https://github.com/example-org/temperature-alarm'), { owner: 'example-org', repo: 'temperature-alarm' });
  assert.deepEqual(githubRepo('https://github.com/example-org/x.git'), { owner: 'example-org', repo: 'x' });
  assert.equal(githubRepo('https://gitlab.com/a/b'), null);
  assert.equal(githubRepo(''), null);
  assert.equal(normUrl('https://GitHub.com/A/B/'), 'https://github.com/a/b');
  assert.equal(latestVersion([{ name: '1.0.0' }, { name: '' }, { name: '1.2.0' }]).name, '1.2.0');
  assert.equal(prettyName('temperature-alarm'), 'Temperature alarm');
  assert.equal(prettyName('edge-app-share-data'), 'Share data');
  const inc = parseInclude('IoTOpen/edge-app-*');
  assert.ok(inc.test('edge-app-visitscounter') && inc.test('Edge-App-X') && !inc.test('docker-edge-client'));
  assert.equal(inc.prefix, 'edge-app-');
  assert.ok(parseInclude('owner/one-repo').test('one-repo'));
  assert.equal(parseInclude('not a pattern'), null);
  assert.deepEqual(readManifest('{"name":"Data share","category":"share","description":"","tags":["a",1],"publisher":{"id":1}}'), {
    name: 'Data share', category: 'share', short_description: undefined, description: undefined, tags: ['a'],
  });
  assert.equal(readManifest('{ "publisher": { "id": x } }'), null, 'invalid JSON (seen in the wild) is ignored');
});

function fakeLynx({ apps = [], publisher = { id: 77 }, versions = {}, uploadAnswer = 'hash' } = {}) {
  const calls = [];
  let next = 100;
  return {
    calls,
    edgeAppsOrganization: async () => apps,
    edgePublisher: async () => {
      if (!publisher) throw Object.assign(new Error('not found'), { status: 404 });
      return publisher;
    },
    createEdgeApp: async (a) => {
      calls.push(['create', a]);
      const app = { ...a, id: next++ };
      apps.push(app);
      versions[app.id] = [];
      return app;
    },
    updateEdgeApp: async (a) => (calls.push(['update', a]), a),
    edgeAppVersions: async (id, untagged) => (versions[id] || []).filter((v) => untagged || v.name),
    createEdgeAppVersion: async (id, json, lua) => {
      calls.push(['upload', id, json, lua]);
      versions[id].push({ name: '', hash: 'h1', timestamp: 1 });
      return uploadAnswer === 'hash' ? { hash: 'h1' } : null;
    },
    publishEdgeAppVersion: async (id, name, hash) => {
      calls.push(['publish', id, name, hash]);
      versions[id].find((v) => v.hash === hash).name = name;
    },
  };
}

const pkg = {
  version: '1.1.0',
  appJson: '{"input":{}}',
  appLua: '-- lua',
  meta: { name: 'Temperature alarm', short_description: 'Larm', description: '# Readme', tags: ['alarm'], category: 'other', source_url: 'https://github.com/example-org/temperature-alarm' },
};

test('ensureGithubVersion creates the app, uploads and publishes the version', async () => {
  const lynx = fakeLynx();
  const r = await ensureGithubVersion(lynx, { orgId: 10, pkg });
  assert.equal(r.version, '1.1.0');
  assert.deepEqual(
    lynx.calls.map((c) => c[0]),
    ['create', 'upload', 'publish'],
  );
  assert.equal(lynx.calls[0][1].public, false);
  assert.deepEqual(lynx.calls[0][1].publisher, { id: 77 });
});

test('ensureGithubVersion reuses the app and an existing version', async () => {
  const app = { id: 5, ...pkg.meta };
  const lynx = fakeLynx({ apps: [app], versions: { 5: [{ name: '1.1.0', hash: 'x' }] } });
  const r = await ensureGithubVersion(lynx, { orgId: 10, pkg: { ...pkg, meta: { ...pkg.meta, source_url: 'https://github.com/Example-Org/temperature-alarm/' } } });
  assert.equal(r.app.id, 5);
  assert.deepEqual(lynx.calls.map((c) => c[0]), ['update']); // only the source_url spelling differed
});

test('ensureGithubVersion finds the hash when IoT Open answers 204', async () => {
  const app = { id: 5, ...pkg.meta };
  const lynx = fakeLynx({ apps: [app], versions: { 5: [] }, uploadAnswer: null });
  await ensureGithubVersion(lynx, { orgId: 10, pkg });
  assert.deepEqual(lynx.calls.at(-1), ['publish', 5, '1.1.0', 'h1']);
});

test('ensureGithubVersion uses the organization as publisher and explains a refusal', async () => {
  const lynx = fakeLynx({ publisher: null });
  await ensureGithubVersion(lynx, { orgId: 10, pkg });
  assert.deepEqual(lynx.calls[0][1].publisher, { id: 10 });
  const refusing = fakeLynx();
  refusing.createEdgeApp = async () => {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  };
  await assert.rejects(ensureGithubVersion(refusing, { orgId: 10, pkg }), /får inte publicera edge apps/);
});

test('ensureGithubVersion: identical files (204) reuse the latest named version', async () => {
  const app = { id: 5, ...pkg.meta };
  const lynx = fakeLynx({ apps: [app], versions: { 5: [{ name: '1.0.0', hash: 'h0', timestamp: 5 }] }, uploadAnswer: null });
  lynx.createEdgeAppVersion = async () => null; // nothing new stored
  const r = await ensureGithubVersion(lynx, { orgId: 10, pkg });
  assert.equal(r.version, '1.0.0');
  assert.equal(r.sameAs, '1.1.0');
});

test('docker log demultiplexing', () => {
  const frame = (stream, text) => {
    const p = Buffer.from(text);
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(p.length, 4);
    return Buffer.concat([h, p]);
  };
  const lines = demuxLogs(Buffer.concat([frame(1, '2026-01-01T00:00:00.000Z hello\n2026-01-01T00:00:01.000Z two\n'), frame(2, 'oops\n')]));
  assert.deepEqual(lines, [
    { stream: 'stdout', time: '2026-01-01T00:00:00.000Z', text: 'hello' },
    { stream: 'stdout', time: '2026-01-01T00:00:01.000Z', text: 'two' },
    { stream: 'stderr', time: null, text: 'oops' },
  ]);
  assert.deepEqual(demuxLogs(Buffer.from('plain tty line\n')), [{ stream: 'stdout', time: null, text: 'plain tty line' }]);
});

test('image references', () => {
  assert.deepEqual(splitImage('ghcr.io/iotopen/edge-client:latest'), { repo: 'ghcr.io/iotopen/edge-client', tag: 'latest' });
  assert.deepEqual(splitImage('localhost:5000/edge'), { repo: 'localhost:5000/edge', tag: 'latest' });
  assert.deepEqual(splitImage('edge@sha256:abc'), { repo: 'edge', tag: 'sha256:abc' });
});

test('tar archive', () => {
  const tar = makeTar([{ name: 'iotopen.json', content: '{"a":1}' }]);
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.subarray(0, 12).toString(), 'iotopen.json');
  assert.equal(tar.subarray(512, 519).toString(), '{"a":1}');
  assert.equal(tar.subarray(100, 107).toString(), '0000600');
  // header checksum: sum of all header bytes with the checksum field read as spaces
  const h = Buffer.from(tar.subarray(0, 512));
  const stored = parseInt(h.subarray(148, 154).toString(), 8);
  h.fill(0x20, 148, 156);
  assert.equal(stored, h.reduce((a, b) => a + b, 0));
});

test('configuration is validated', () => {
  assert.equal(checkOrigin('X', 'https://lynx.iotopen.se'), 'https://lynx.iotopen.se');
  assert.throws(() => checkOrigin('X', 'https://lynx.iotopen.se/'), /only scheme/);
  assert.throws(() => checkOrigin('X', 'http://lynx.iotopen.se'), /https/);
  assert.throws(() => checkOrigin('X', 'https://user:pw@lynx.iotopen.se'), /only scheme/);
  assert.throws(() => checkOrigin('X', 'https://evil.example', { allowedHosts: ['lynx.iotopen.se'] }), /ALLOWED_LYNX_HOSTS/);
  assert.deepEqual(parseDockerHost('unix:///var/run/docker.sock'), { socketPath: '/var/run/docker.sock' });
  assert.deepEqual(parseDockerHost('tcp://docker-proxy:2375'), { host: 'docker-proxy', port: 2375, prefix: '' });
  assert.equal(parseDockerHost(''), null);
  assert.throws(() => parseDockerHost('ssh://host'), /DOCKER_HOST/);

  const c = loadConfig({});
  assert.equal(c.lynxUrl, 'https://lynx.iotopen.se');
  assert.equal(c.github.topic, 'iotopen-edge-app');
  assert.equal(c.edge.docker, null);
  assert.throws(() => loadConfig({ BASE_PATH: '/x/' }), /BASE_PATH/);
  assert.throws(() => loadConfig({ API_MODE: 'other' }), /API_MODE/);
  assert.throws(() => loadConfig({ GITHUB_OWNERS: 'a b' }), /GITHUB_OWNERS/);
  assert.throws(() => loadConfig({ EDGE_CLIENT_IMAGE: 'x;rm -rf' }), /EDGE_CLIENT_IMAGE/);
  assert.throws(() => loadConfig({ CUSTOM_SERVERS: 'yes' }), /true or false/);
  assert.deepEqual(c.github.include, ['IoTOpen/edge-app-*']);
  assert.deepEqual(loadConfig({ GITHUB_INCLUDE: '' }).github.include, []);
  assert.throws(() => loadConfig({ GITHUB_INCLUDE: 'x/../y' }), /GITHUB_INCLUDE/);
});

test('edge status payloads', () => {
  for (const v of [1, '1', true, 'online', { value: 1 }, { value: '1', timestamp: 1 }]) assert.equal(parseStatus(v), 'online');
  for (const v of [0, '0', false, 'offline', { value: 0 }]) assert.equal(parseStatus(v), 'offline');
  for (const v of [null, '', 'maybe', { msg: 'x' }]) assert.equal(parseStatus(v), null);
});

const doc = {
  input: {
    trigger_function: { type: 'single_function_selector', value: true, required: true },
    lights: { type: 'multi_function_selector', value: true },
    plain: { type: 'multi_device_selector' },
    timeout: { type: 'number', default: '10' },
    days: { type: 'checkbox', values: { mon: 'Mån', tue: 'Tis' }, default: ['mon'] },
    trigger_value: { type: 'single_function_selector', value: true, required: true },
    temp: { type: 'repeat', min: 2, max: 4, input_fields: ['trigger_value'] },
    text_example: { type: 'text', validator: '[a-zA-Z]*', on_error: 'Bara bokstäver' },
  },
  guide: [{ id: 'a', input_fields: ['trigger_function', 'lights', 'plain', 'timeout', 'days', 'temp', 'text_example'] }],
};

test('app.json as documented by IoT Open: values, checkbox, repeat', () => {
  const v = initialValues(doc);
  assert.deepEqual(v.lights, {});
  assert.deepEqual(v.plain, []);
  assert.deepEqual(v.days, ['mon']);
  assert.equal(v.temp.length, 2);
  assert.equal('trigger_value' in v, false, 'inputs used only inside a repeat are not top level');

  const errs = validate(doc, { ...v, trigger_function: { 4456: '' }, text_example: 'abc1' });
  assert.equal(errs.trigger_function, 'Ange ett värde för varje vald');
  assert.equal(errs['temp.0.trigger_value'], 'Måste fyllas i');
  assert.equal(errs.text_example, 'Bara bokstäver', 'the validator must match the whole text');

  const ok = { ...v, trigger_function: { 4456: '255' }, temp: [{ trigger_value: { 9: '26' } }, { trigger_value: { 12: '10' } }], text_example: 'Hello' };
  assert.deepEqual(validate(doc, ok), {});
  assert.deepEqual(cleanValues(doc, ok), {
    trigger_function: { 4456: 255 },
    lights: {},
    plain: [],
    timeout: 10,
    days: ['mon'],
    temp: [{ trigger_value: { 9: 26 } }, { trigger_value: { 12: 10 } }],
    text_example: 'Hello',
  });
  assert.equal(validate(doc, { ...ok, temp: [ok.temp[0]] }).temp, 'Minst 2');
  assert.equal(validate(doc, { ...ok, days: ['xyz'] }).days, 'Välj bland alternativen');
});

test('EDGE_PORT_RANGE and EDGE_PORT_BIND', () => {
  assert.equal(loadConfig({}).edge.ports, null);
  assert.deepEqual(loadConfig({ EDGE_PORT_RANGE: '18000-18099' }).edge.ports, { from: 18000, to: 18099, bind: '0.0.0.0' });
  assert.deepEqual(loadConfig({ EDGE_PORT_RANGE: '18000 - 18010', EDGE_PORT_BIND: '192.168.1.20' }).edge.ports, { from: 18000, to: 18010, bind: '192.168.1.20' });
  for (const r of ['80-90', '18099-18000', '18000', '18000-70000']) assert.throws(() => loadConfig({ EDGE_PORT_RANGE: r }), /EDGE_PORT_RANGE/);
  assert.throws(() => loadConfig({ EDGE_PORT_RANGE: '18000-18099', EDGE_PORT_BIND: 'all; rm' }), /EDGE_PORT_BIND/);
});

test('published ports: label and checks', () => {
  assert.deepEqual(parsePorts('8090:18010, 8091:18011,bad'), [{ container: 8090, host: 18010 }, { container: 8091, host: 18011 }]);
  assert.deepEqual(parsePorts(undefined), []);
  const range = { from: 18000, to: 18099 };
  assert.deepEqual(checkPorts([{ container: '8091', host: 18011 }, { container: 8090, host: 18010 }], range), [{ container: 8090, host: 18010 }, { container: 8091, host: 18011 }]);
  assert.throws(() => checkPorts([{ container: 1883, host: 18010 }], range), /1883/);
  assert.throws(() => checkPorts([{ container: 80, host: 18010 }], range), /1024/);
  assert.throws(() => checkPorts([{ container: 8090, host: 17999 }], range), /utanför/);
  assert.throws(() => checkPorts([{ container: 8090, host: 18010 }], range, new Set([18010])), /annan edge client/);
  assert.throws(() => checkPorts(Array.from({ length: 6 }, (_, i) => ({ container: 9000 + i, host: 18000 + i })), range), /Högst 5/);
  assert.throws(() => checkPorts('8090', range), /lista/);
});
