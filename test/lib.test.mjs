import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, sortVersionsDesc, versionName } from '../shared/version.js';
import { cleanValues, formLayout, initialValues, inputKind, matchesFilter, validate } from '../src/lib/configForm.js';
import { ensureGithubVersion, githubRepo, latestVersion, normUrl } from '../src/lib/install.js';
import { demuxLogs, splitImage } from '../server/docker.mjs';
import { makeTar } from '../server/tar.mjs';
import { checkOrigin, loadConfig, parseDockerHost } from '../server/config.mjs';
import { prettyName } from '../server/github.mjs';

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

const options = {
  input: {
    sensor: { type: 'single_function_selector', name: 'Givare', required: true, filter: { type: 'temperature' } },
    meters: { type: 'multi_function_selector', name: 'Mätare' },
    limit: { type: 'number', name: 'Gräns', required: true, default: 25, min: -40, max: 100 },
    level: { type: 'option', name: 'Nivå', values: { 1: 'Varning', 2: 'Kritisk' }, default: 1 },
    notify: { type: 'toggle', name: 'Notis', default: true, true_value: 'yes', false_value: 'no' },
    label: { type: 'text', name: 'Namn', validator: '^.{1,5}$', on_error: 'Max 5 tecken' },
    rows: { type: 'repeat', name: 'Rader' },
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
  assert.equal(inputKind({ type: 'repeat' }), 'json');
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

test('ensureGithubVersion explains a missing publisher', async () => {
  const lynx = fakeLynx({ publisher: null });
  await assert.rejects(ensureGithubVersion(lynx, { orgId: 10, pkg }), /kan inte publicera edge apps/);
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
});
