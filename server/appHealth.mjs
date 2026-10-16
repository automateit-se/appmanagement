// Health of the edge apps that an edge client in this Docker environment runs, read from the outside: the
// container's process list (Docker's "top") and its log. Nothing is run inside the container.
//
// How IoT Open's edge client runs apps (edged, from the iotopen-edge package):
// - one process per app instance: `iotopen-rt edge-app -a /var/lib/iot-open/edge/configs/<instance id> -r <fd>`
// - an app's log lines (log.i/e/d) and its start and load errors go to the container log as
//   `edge-app-<instance id>[<pid>]: <text>`, all on stderr: errors can only be told apart by their text
// - edged logs `edged[<pid>]: pid <pid> died with <code>` when an app process exits, and starts apps that are not
//   running again every 10 seconds, so a broken app restarts over and over
// - a Lua error after start (in a callback) prints a traceback without the prefix, naming the app's code file
//   `/var/lib/iot-open/edge/apps/<app id>-<version>:<line>: <message>`

const APP_LINE = /^edge-app-(\d+)\[(\d+)\]:\s?(.*)$/;
const EDGED_LINE = /^edged\[\d+\]:\s?(.*)$/;
const DIED = /\bpid (\d+) died with (-?\d+)/;
const STARTING = /^Starting edge app \d+/;
const LOGIC_FILE = /\/edge\/apps\/(\d+)-([^:\s]+):\d+:\s?(.*)$/;
const CONFIG_ARG = /\bedge-app\b.*\s-a\s+\S*\/configs\/(\d+)(?:\s|$)/;
export const APP_ERROR = /\b(error|fatal|fail(ed|ure)?|panic|exception|traceback)\b|attempt to |bad argument/i;

/** Restarts within this window count towards "crashing". */
export const WINDOW_MS = 60 * 60 * 1000;
/** This many failed starts in the window means the app is crashing (edged restarts it every 10 s). */
export const CRASH_LOOP = 3;

const ms = (t) => (t ? Date.parse(t) : NaN);

/**
 * App processes from Docker's top with ps_args "-o pid,rss,etimes,args": { [instance id]: { pid, memoryKb, uptimeSec } }.
 */
export function appProcesses(top) {
  const titles = (top?.Titles || []).map((t) => String(t).toUpperCase());
  const col = (...names) => titles.findIndex((t) => names.includes(t));
  const iPid = col('PID');
  const iRss = col('RSS', 'RSZ');
  const iEt = col('ELAPSED', 'ETIMES');
  const out = {};
  for (const row of top?.Processes || []) {
    const cmd = row[row.length - 1] || '';
    const m = CONFIG_ARG.exec(cmd);
    if (!m) continue;
    const p = { pid: Number(row[iPid]) || null, memoryKb: iRss >= 0 ? Number(row[iRss]) || 0 : null, uptimeSec: iEt >= 0 ? Number(row[iEt]) || 0 : null };
    const prev = out[m[1]];
    // two processes for one instance: edged is replacing it, the older one is on its way out
    if (!prev || (p.uptimeSec ?? 0) < (prev.uptimeSec ?? 0)) out[m[1]] = p;
  }
  return out;
}

/** Which instance a log line belongs to, or null. `pids` maps container pids to instances (filled as lines are read). */
function classify(line, pids) {
  const text = line.text || '';
  let m = APP_LINE.exec(text);
  if (m) {
    pids.set(m[2], m[1]);
    return { instance: m[1], kind: STARTING.test(m[3]) ? 'start' : APP_ERROR.test(m[3]) ? 'error' : 'log', text: m[3] };
  }
  m = EDGED_LINE.exec(text);
  if (m) {
    const d = DIED.exec(m[1]);
    if (d && pids.has(d[1])) return { instance: pids.get(d[1]), kind: 'exit', code: Number(d[2]), text: m[1] };
    return null;
  }
  m = LOGIC_FILE.exec(text);
  if (m) return { logic: `${m[1]}-${m[2]}`, kind: 'error', text: text.replace(/^\s*(ErrorObject:\s*)?/, '') };
  return null;
}

/**
 * Health per app instance, from the processes and the container log (oldest line first).
 * `edgeRunning` is whether the edge client container runs at all.
 */
export function appHealth({ processes = {}, lines = [], edgeRunning = true, now = Date.now() }) {
  const pids = new Map();
  const byInstance = {};
  const byLogic = {};
  const get = (id) => (byInstance[id] ||= { starts: 0, crashes: 0, lastStart: null, lastExit: null, lastError: null, errors: 0 });
  for (const line of lines) {
    const c = classify(line, pids);
    if (!c) continue;
    const recent = !(now - ms(line.time) > WINDOW_MS); // lines without a time count as recent
    if (c.logic) {
      const l = (byLogic[c.logic] ||= { errors: 0, lastError: null });
      if (recent) l.errors++;
      l.lastError = { time: line.time, text: c.text };
      continue;
    }
    const s = get(c.instance);
    if (c.kind === 'start') {
      if (recent) s.starts++;
      s.lastStart = line.time;
    } else if (c.kind === 'error') {
      if (recent) s.errors++;
      s.lastError = { time: line.time, text: c.text };
    } else if (c.kind === 'exit') {
      if (recent && c.code !== 0) s.crashes++;
      s.lastExit = { time: line.time, code: c.code };
    }
  }

  const ids = new Set([...Object.keys(byInstance), ...Object.keys(processes)]);
  const apps = {};
  for (const id of ids) {
    const s = byInstance[id] || get(id);
    const p = processes[id] || null;
    const exitedSinceStart = s.lastExit && (!s.lastStart || ms(s.lastExit.time) >= ms(s.lastStart));
    let state;
    if (!edgeRunning) state = 'edge-stopped';
    else if (s.crashes >= CRASH_LOOP || (!p && exitedSinceStart && s.lastExit.code !== 0)) state = 'crashing';
    else if (p) state = 'running';
    else state = 'stopped';
    apps[id] = {
      state,
      running: !!p && edgeRunning,
      pid: p?.pid ?? null,
      memoryKb: p?.memoryKb ?? null,
      uptimeSec: p?.uptimeSec ?? null,
      starts: s.starts,
      crashes: s.crashes,
      errors: s.errors,
      lastStart: s.lastStart,
      lastExit: s.lastExit,
      lastError: s.lastError,
    };
  }
  return { apps, byLogic, windowSec: WINDOW_MS / 1000 };
}

/**
 * The log lines of one instance: its own lines, edged's lines about its processes and errors in its code file
 * (`logic` = "<app id>-<version>", optional).
 */
export function appLogLines(lines, instance, logic) {
  const pids = new Map();
  const out = [];
  const id = String(instance);
  for (const line of lines) {
    const c = classify(line, pids);
    if (!c) continue;
    if (c.instance === id || (logic && c.logic === logic)) {
      out.push({ time: line.time, text: c.text, error: c.kind === 'error' || (c.kind === 'exit' && c.code !== 0) });
    }
  }
  return out;
}
