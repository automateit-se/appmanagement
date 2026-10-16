import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHealth, appLogLines, appProcesses, CRASH_LOOP } from '../server/appHealth.mjs';

// Lines and processes in the format of IoT Open's edge client (edged and edge-app from the iotopen-edge package).

const now = Date.parse('2026-10-16T12:00:00Z');
const at = (sec) => new Date(now - sec * 1000).toISOString();
const line = (sec, text) => ({ stream: 'stderr', time: at(sec), text });

const top = {
  Titles: ['PID', 'RSS', 'ELAPSED', 'COMMAND'],
  Processes: [
    ['4100', '18000', '7200', '/usr/bin/python3 /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf'],
    ['4200', '9000', '7200', '/usr/bin/iotopen-rt /usr/bin/edged'],
    ['4300', '20964', '7100', '/usr/bin/iotopen-rt edge-app -a /var/lib/iot-open/edge/configs/11 -r 5'],
    ['4400', '15000', '30', '/usr/bin/iotopen-rt edge-app -a /var/lib/iot-open/edge/configs/12 -r 7'],
  ],
};

test('app processes from docker top', () => {
  assert.deepEqual(appProcesses(top), {
    11: { pid: 4300, memoryKb: 20964, uptimeSec: 7100 },
    12: { pid: 4400, memoryKb: 15000, uptimeSec: 30 },
  });
  assert.deepEqual(appProcesses(null), {});
  // while edged replaces an instance two processes can exist: the newest counts
  const two = { ...top, Processes: [...top.Processes, ['4500', '1000', '2', '/usr/bin/iotopen-rt edge-app -a /var/lib/iot-open/edge/configs/11 -r 9']] };
  assert.equal(appProcesses(two)[11].pid, 4500);
});

test('running, crashing, stopped and edge stopped apps', () => {
  const lines = [
    line(7100, 'edge-app-11[40]: Starting edge app 11'),
    line(7099, 'edge-app-11[40]: Door counter ready'),
    // 13 is in a crash loop: started, failed and restarted by edged every 10 seconds
    ...[50, 40, 30, 20].flatMap((s, i) => [
      line(s, `edge-app-13[${60 + i}]: Starting edge app 13`),
      line(s - 0.2, `edge-app-13[${60 + i}]: error running app code: /var/lib/iot-open/edge/apps/7-1.2.0:42: attempt to index a nil value`),
      line(s - 0.3, `edged[12]: pid ${60 + i} died with 1`),
    ]),
    // 14 was stopped normally (removed or changed) and has not come back
    line(600, 'edge-app-14[70]: Starting edge app 14'),
    line(500, 'edged[12]: pid 70 died with 0'),
    // a Lua error in a callback of 11, after start: only the code file names it
    line(100, 'ErrorObject: /var/lib/iot-open/edge/apps/5-2.0.0:17: bad argument #1 to \'format\''),
    // old, outside the window
    line(4 * 3600, 'edge-app-12[30]: Starting edge app 12'),
    line(4 * 3600 - 1, 'edged[12]: pid 30 died with 1'),
    line(30, 'edge-app-12[31]: Starting edge app 12'),
  ];
  const h = appHealth({ processes: appProcesses(top), lines, now });
  assert.equal(h.apps[11].state, 'running');
  assert.equal(h.apps[11].memoryKb, 20964);
  assert.equal(h.apps[11].uptimeSec, 7100);
  assert.equal(h.apps[11].starts, 0); // its start is more than an hour ago
  assert.equal(h.apps[12].state, 'running');
  assert.equal(h.apps[12].crashes, 0, 'old crashes do not count');
  assert.equal(h.apps[13].state, 'crashing');
  assert.equal(h.apps[13].crashes, 4);
  assert.ok(h.apps[13].crashes >= CRASH_LOOP);
  assert.match(h.apps[13].lastError.text, /attempt to index a nil value/);
  assert.equal(h.apps[13].running, false);
  assert.equal(h.apps[14].state, 'stopped');
  assert.deepEqual(h.apps[14].lastExit, { time: at(500), code: 0 });
  assert.match(h.byLogic['5-2.0.0'].lastError.text, /^\/var\/lib\/iot-open\/edge\/apps\/5-2.0.0:17: bad argument/);
  assert.equal(h.byLogic['5-2.0.0'].errors, 1);

  const off = appHealth({ processes: {}, lines, edgeRunning: false, now });
  assert.equal(off.apps[11].state, 'edge-stopped');
  assert.equal(off.apps[11].running, false);
});

test('one exit without a crash loop: crashing only while it is down', () => {
  const lines = [line(40, 'edge-app-21[5]: Starting edge app 21'), line(39, 'edged[1]: pid 5 died with 255')];
  assert.equal(appHealth({ lines, now }).apps[21].state, 'crashing');
  const back = [...lines, line(29, 'edge-app-21[6]: Starting edge app 21')];
  const procs = { 21: { pid: 900, memoryKb: 1000, uptimeSec: 29 } };
  assert.equal(appHealth({ processes: procs, lines: back, now }).apps[21].state, 'running');
});

test('log lines of one instance', () => {
  const lines = [
    line(30, 'edge-app-11[40]: Starting edge app 11'),
    line(29, 'edge-app-12[41]: Starting edge app 12'),
    line(28, 'mosquitto: bridge connected'),
    line(27, 'edge-app-11[40]: error running app code: x'),
    line(26, 'edged[1]: pid 40 died with 1'),
    line(25, 'edged[1]: pid 41 died with 0'),
    line(24, 'ErrorObject: /var/lib/iot-open/edge/apps/5-2.0.0:17: boom'),
  ];
  assert.deepEqual(appLogLines(lines, 11, '5-2.0.0').map((l) => [l.text, l.error]), [
    ['Starting edge app 11', false],
    ['error running app code: x', true],
    ['pid 40 died with 1', true],
    ['/var/lib/iot-open/edge/apps/5-2.0.0:17: boom', true],
  ]);
  assert.deepEqual(appLogLines(lines, 12).map((l) => l.text), ['Starting edge app 12', 'pid 41 died with 0']);
});
