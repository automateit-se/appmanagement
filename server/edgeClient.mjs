import { HttpError } from './http.mjs';
import { makeTar } from './tar.mjs';
import { appHealth, appLogLines, appProcesses } from './appHealth.mjs';

// IoT Open Docker Edge Client (ghcr.io/iotopen/edge-client), one container per installation, run in the same
// Docker environment as App Management. The backend only ever touches containers and volumes it created itself
// (recognised by labels), and only for installations the signed-in user can see in IoT Open.
//
// Credentials: POST /api/v2/gateway/credentials/{installation} in IoT Open, as the signed-in user. The answer is
// the edge client's /etc/iot-open/iotopen.json. It is written straight into the container's config volume and is
// never sent to the browser. IoT Open keeps one set per installation, so creating new ones disconnects any other
// edge client (for example a Raspberry Pi) that uses the old ones.

const L = 'se.automateit.appmanagement';
const ERROR_LINE = /\b(error|fatal|fail(ed|ure)?|panic|denied|refused|unauthori[sz]ed|not authori[sz]ed|connection lost|exception)\b/i;
const MAX_LOG_LINES = 1000;
// enough log to cover about an hour of a crashing app (edged restarts it every 10 s)
const APP_LOG_LINES = 3000;

export const containerName = (iid) => `iotopen-edge-${Number(iid)}`;
export const volumeName = (iid) => `iotopen-edge-${Number(iid)}-config`;
// the apps' own data (/var/lib/iot-open), e.g. the local dashboard's cache, kept when the container is recreated
export const dataVolumeName = (iid) => `iotopen-edge-${Number(iid)}-data`;

// Published ports: an app in the edge client (e.g. the local dashboard on 8090) reached on a port of this server.
// Kept in a label on the container ("8090:18010,8091:18011"), so an update recreates the container with them.
const PORTS_LABEL = `${L}.ports`;
const MAX_PORTS = 5;
// the edge client's own broker and web server are never published
const RESERVED = new Set([1883, 8883, 9001]);

/** "8090:18010,…" -> [{ container: 8090, host: 18010 }, …] */
export function parsePorts(label) {
  return String(label || '')
    .split(',')
    .map((p) => /^(\d+):(\d+)$/.exec(p.trim()))
    .filter(Boolean)
    .map((m) => ({ container: Number(m[1]), host: Number(m[2]) }));
}

/**
 * Checks the ports asked for: whole numbers, an app port of 1024 or above (not the broker), a host port in the
 * range and not used by another edge client. Returns them sorted, or throws a 400 that says what is wrong.
 */
export function checkPorts(list, range, usedElsewhere = new Set()) {
  if (!Array.isArray(list)) throw new HttpError(400, 'ports ska vara en lista');
  if (list.length > MAX_PORTS) throw new HttpError(400, `Högst ${MAX_PORTS} portar`);
  const out = [];
  for (const p of list) {
    const container = Number(p?.container);
    const host = Number(p?.host);
    if (!Number.isInteger(container) || container < 1024 || container > 65535 || RESERVED.has(container)) {
      throw new HttpError(400, `Appens port ${p?.container ?? ''} går inte att publicera: använd 1024-65535, inte ${[...RESERVED].join('/')}`);
    }
    if (!Number.isInteger(host) || host < range.from || host > range.to) throw new HttpError(400, `Serverns port ${p?.host ?? ''} ligger utanför ${range.from}-${range.to}`);
    if (usedElsewhere.has(host)) throw new HttpError(409, `Port ${host} används redan av en annan edge client`);
    if (out.some((o) => o.host === host)) throw new HttpError(400, `Port ${host} finns två gånger`);
    if (out.some((o) => o.container === container)) throw new HttpError(400, `Appens port ${container} finns två gånger`);
    out.push({ container, host });
  }
  return out.sort((a, b) => a.host - b.host);
}

export function edgeClients(cfg, docker, lynx) {
  const lynxHost = new URL(cfg.lynxUrl).host;
  const labels = (iid, user) => ({
    [`${L}.role`]: 'edge-client',
    [`${L}.installation`]: String(Number(iid)),
    [`${L}.lynx`]: lynxHost,
    [`${L}.created-by`]: String(user?.id ?? ''),
  });

  async function find(iid) {
    const list = await docker.json('GET', '/containers/json', {
      query: { all: 'true', filters: { label: [`${L}.role=edge-client`, `${L}.installation=${Number(iid)}`] } },
    });
    return (list || []).find((c) => c.Labels?.[`${L}.lynx`] === lynxHost) || null;
  }

  async function must(iid) {
    const c = await find(iid);
    if (!c) throw new HttpError(404, 'Det finns ingen edge client för installationen');
    return c;
  }

  async function writeCredentials(containerId, creds) {
    for (const k of ['client_id', 'installation_id', 'mqtt_broker', 'mqtt_password']) {
      if (creds?.[k] === undefined || creds[k] === '') throw new HttpError(502, `IoT Open svarade utan ${k} när credentials skapades`);
    }
    const tar = makeTar([{ name: 'iotopen.json', content: JSON.stringify(creds, null, 2) + '\n', mode: 0o600 }]);
    await docker.json('PUT', `/containers/${containerId}/archive`, { query: { path: '/etc/iot-open' }, body: tar, contentType: 'application/x-tar' });
  }

  /** EDGE_CLIENT_NETWORK is created on first use (a bridge network with outbound access, nothing published). */
  async function ensureNetwork() {
    const name = cfg.edge.network;
    if (!name || ['bridge', 'host', 'none', 'default'].includes(name)) return;
    const found = await docker.json('GET', `/networks/${encodeURIComponent(name)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (found) return;
    await docker.json('POST', '/networks/create', { body: { Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: { [`${L}.role`]: 'edge-network' } } }).catch((e) => {
      if (e.status !== 409) throw e; // created at the same moment by another request
    });
  }

  async function createContainer(iid, user, ports = []) {
    await ensureNetwork();
    // created with labels like the config volume (Docker would otherwise create it without them); kept if it exists
    await docker.json('POST', '/volumes/create', { body: { Name: dataVolumeName(iid), Labels: labels(iid, user) } });
    const published = cfg.edge.ports ? ports : [];
    const body = {
      Image: cfg.edge.image,
      Env: ['HEADLESS=true'],
      Labels: { ...labels(iid, user), ...(published.length ? { [PORTS_LABEL]: published.map((p) => `${p.container}:${p.host}`).join(',') } : {}) },
      ExposedPorts: Object.fromEntries(published.map((p) => [`${p.container}/tcp`, {}])),
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        // the image's /etc/iot-open (mosquitto template) is copied into the new volume, iotopen.json is added
        Mounts: [
          { Type: 'volume', Source: volumeName(iid), Target: '/etc/iot-open' },
          { Type: 'volume', Source: dataVolumeName(iid), Target: '/var/lib/iot-open' },
        ],
        PortBindings: Object.fromEntries(published.map((p) => [`${p.container}/tcp`, [{ HostIp: cfg.edge.ports.bind, HostPort: String(p.host) }]])),
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        Memory: 256 * 1024 * 1024,
        ...(cfg.edge.network ? { NetworkMode: cfg.edge.network } : {}),
      },
    };
    const r = await docker.json('POST', '/containers/create', { query: { name: containerName(iid) }, body });
    return r.Id;
  }

  /** Pulls the image; when the registry cannot be reached, a copy the host already has is good enough. */
  async function pullImage() {
    try {
      await docker.pull(cfg.edge.image);
    } catch (e) {
      const local = await docker.json('GET', `/images/${encodeURIComponent(cfg.edge.image)}/json`).catch(() => null);
      if (!local) throw e;
      console.warn(`${e.message} - using the local copy of ${cfg.edge.image}`);
    }
  }

  // Setting up and updating can take minutes (pulling the image), longer than a proxy in front waits for an answer
  // (Cloudflare: about 100 s). They run as jobs: the request answers at once and the status shows the progress.
  const jobs = new Map(); // installation -> { action, step, error, done, started }

  function runJob(iid, action, steps) {
    const cur = jobs.get(iid);
    if (cur && !cur.done) throw new HttpError(409, 'En annan åtgärd pågår redan för den här edge clienten');
    const job = { action, step: '', error: '', done: false, started: new Date().toISOString() };
    jobs.set(iid, job);
    (async () => {
      try {
        await steps((text) => (job.step = text));
      } catch (e) {
        job.error = e.message || String(e);
        console.warn(`edge client ${action} for installation ${iid} failed: ${job.error}`);
      } finally {
        job.done = true;
        job.step = '';
      }
    })();
    return job;
  }

  const jobView = (iid) => {
    const j = jobs.get(iid);
    if (!j) return null;
    if (j.done) jobs.delete(iid); // a finished job (and its error) is reported once
    if (j.done && !j.error) return null;
    return { action: j.action, step: j.step, error: j.error, running: !j.done, started: j.started };
  };

  async function status(iid) {
    const job = jobView(iid);
    const c = await find(iid);
    if (!c) return { exists: false, image: cfg.edge.image, job };
    let info;
    try {
      info = await docker.json('GET', `/containers/${c.Id}/json`);
    } catch (e) {
      // removed between the list and the inspect, e.g. while an update replaces it
      if (e.status === 404) return { exists: false, image: cfg.edge.image, job };
      throw e;
    }
    const st = info.State || {};
    let lines = [];
    try {
      lines = await docker.logs(c.Id, 300);
    } catch {
      /* status without log summary */
    }
    const errors = lines.filter((l) => ERROR_LINE.test(l.text));
    return {
      exists: true,
      id: c.Id.slice(0, 12),
      name: containerName(iid),
      image: info.Config?.Image || c.Image,
      created: info.Created,
      state: st.Status, // created | running | restarting | paused | exited | dead
      running: !!st.Running,
      restarting: !!st.Restarting,
      startedAt: st.StartedAt,
      finishedAt: st.FinishedAt,
      exitCode: st.ExitCode,
      error: st.Error || '',
      restartCount: info.RestartCount || 0,
      health: st.Health?.Status || null,
      recentErrors: errors.length,
      lastError: errors.length ? errors[errors.length - 1] : null,
      hasConfig: !!(info.Mounts || []).find((m) => m.Destination === '/etc/iot-open'),
      ports: parsePorts(c.Labels?.[PORTS_LABEL]),
      portRange: cfg.edge.ports ? { from: cfg.edge.ports.from, to: cfg.edge.ports.to, used: [...(await usedPorts(iid))].sort((a, b) => a - b) } : null,
      job,
    };
  }

  /** Host ports published by the edge clients of other installations (any IoT Open server) on this Docker host. */
  async function usedPorts(iid) {
    const list = await docker.json('GET', '/containers/json', { query: { all: 'true', filters: { label: [`${L}.role=edge-client`] } } });
    const used = new Set();
    for (const c of list || []) {
      if (c.Labels?.[`${L}.installation`] === String(Number(iid)) && c.Labels?.[`${L}.lynx`] === lynxHost) continue;
      for (const p of parsePorts(c.Labels?.[PORTS_LABEL])) used.add(p.host);
    }
    return used;
  }

  /** Recreates the container with the same volumes, ports and image; started again when it was running. */
  async function recreate(iid, user, oldId, ports) {
    await docker.json('DELETE', `/containers/${oldId}`, { query: { force: 'true' } });
    const id = await createContainer(iid, user, ports);
    await docker.json('POST', `/containers/${id}/start`);
    return id;
  }

  const portTaken = (e) => /port is already allocated|address already in use|bind for/i.test(String(e?.message || ''));

  return {
    enabled: true,
    image: cfg.edge.image,
    status,
    /** Health of the apps the edge client runs: processes (memory, uptime) and what the log says. */
    async apps(iid) {
      const c = await find(iid);
      if (!c) return { exists: false, apps: {}, byLogic: {} };
      const running = c.State === 'running';
      const [top, stats, lines] = await Promise.all([
        running ? docker.top(c.Id, '-o pid,rss,etimes,args').catch(() => null) : null,
        running ? docker.stats(c.Id).catch(() => null) : null,
        docker.logs(c.Id, APP_LOG_LINES).catch(() => []),
      ]);
      const mem = stats?.memory_stats;
      // like `docker stats`: page cache that can be dropped is not counted
      const cache = mem?.stats?.inactive_file ?? mem?.stats?.total_inactive_file ?? 0;
      return {
        exists: true,
        running,
        processesRead: !!top,
        memory: mem?.usage ? { usage: Math.max(0, mem.usage - cache), limit: mem.limit || null } : null,
        ...appHealth({ processes: appProcesses(top), lines, edgeRunning: running }),
      };
    },

    /** One app instance's log lines; `logic` ("<app id>-<version>") adds errors from its code file. */
    async appLogs(iid, instance, logic) {
      const c = await must(iid);
      return appLogLines(await docker.logs(c.Id, APP_LOG_LINES), instance, logic).slice(-MAX_LOG_LINES);
    },

    async logs(iid, tail = 200) {
      const c = await must(iid);
      const n = Math.max(10, Math.min(MAX_LOG_LINES, Number(tail) || 200));
      return (await docker.logs(c.Id, n)).map((l) => ({ ...l, error: ERROR_LINE.test(l.text) }));
    },

    /** Starts setting up an edge client; the progress is in status().job. */
    async create(iid, token, user) {
      if (await find(iid)) throw new HttpError(409, 'Installationen har redan en edge client här');
      const job = runJob(iid, 'create', async (step) => {
        step('Hämtar IoT Opens edge client…');
        await pullImage();
        step('Skapar volym och container…');
        await docker.json('POST', '/volumes/create', { body: { Name: volumeName(iid), Labels: labels(iid, user) } });
        const id = await createContainer(iid, user);
        try {
          step('Skapar credentials i IoT Open…');
          const creds = await lynx.createGatewayCredentials(token, iid);
          await writeCredentials(id, creds);
          step('Startar edge clienten…');
          await docker.json('POST', `/containers/${id}/start`);
        } catch (e) {
          // nothing half-made is left behind, in particular no volume holding credentials
          await docker.json('DELETE', `/containers/${id}`, { query: { force: 'true' } }).catch(() => {});
          await docker.json('DELETE', `/volumes/${volumeName(iid)}`).catch(() => {});
          await docker.json('DELETE', `/volumes/${dataVolumeName(iid)}`).catch(() => {});
          throw e;
        }
      });
      // answer from the state before the job: the job is already changing Docker underneath
      return { exists: false, image: cfg.edge.image, job: { action: job.action, step: job.step, error: '', running: true, started: job.started } };
    },

    /** New credentials from IoT Open (e.g. when the old ones were replaced elsewhere), then a restart. */
    async renewCredentials(iid, token) {
      if (jobs.get(iid) && !jobs.get(iid).done) throw new HttpError(409, 'En annan åtgärd pågår redan för den här edge clienten');
      const c = await must(iid);
      const creds = await lynx.createGatewayCredentials(token, iid);
      await writeCredentials(c.Id, creds);
      await docker.json('POST', `/containers/${c.Id}/restart`, { query: { t: 10 } });
      return status(iid);
    },

    async action(iid, what) {
      if (jobs.get(iid) && !jobs.get(iid).done) throw new HttpError(409, 'En annan åtgärd pågår redan för den här edge clienten');
      const c = await must(iid);
      if (!['start', 'stop', 'restart'].includes(what)) throw new HttpError(400, 'Okänd åtgärd');
      await docker.json('POST', `/containers/${c.Id}/${what}`, { query: what === 'start' ? undefined : { t: 10 }, timeout: 60_000 });
      return status(iid);
    },

    /** Pulls the image again and recreates the container with the same config volume (a job, like create). */
    async update(iid, user) {
      const c = await must(iid);
      const before = await status(iid);
      const job = runJob(iid, 'update', async (step) => {
        step('Hämtar senaste versionen…');
        await pullImage();
        step('Startar om med den nya versionen…');
        await recreate(iid, user, c.Id, parsePorts(c.Labels?.[PORTS_LABEL]));
      });
      return { ...before, job: { action: job.action, step: job.step, error: '', running: true, started: job.started } };
    },

    /**
     * Publishes app ports on this server (EDGE_PORT_RANGE), replacing the ones before; [] = none. Docker cannot
     * change the ports of a container, so it is recreated (a job). When a port turns out to be taken by something
     * else on the server, the edge client is started again with the ports it had.
     */
    async setPorts(iid, user, list) {
      if (!cfg.edge.ports) throw new HttpError(400, 'Portpublicering är inte aktiverad på servern (EDGE_PORT_RANGE)');
      if (cfg.edge.network === 'host') throw new HttpError(400, 'Edge clienterna kör i värdens nätverk (EDGE_CLIENT_NETWORK=host): appens port nås redan direkt');
      const c = await must(iid);
      const ports = checkPorts(list, cfg.edge.ports, await usedPorts(iid));
      const old = parsePorts(c.Labels?.[PORTS_LABEL]);
      const before = await status(iid);
      const job = runJob(iid, 'ports', async (step) => {
        step('Startar om edge clienten med de nya portarna…');
        try {
          await recreate(iid, user, c.Id, ports);
        } catch (e) {
          if (!portTaken(e)) throw e;
          step('Porten var upptagen, startar med de tidigare portarna…');
          const cur = await find(iid);
          if (cur) await recreate(iid, user, cur.Id, old);
          else await docker.json('POST', `/containers/${await createContainer(iid, user, old)}/start`);
          const port = /:(\d+) failed/.exec(e.message)?.[1];
          throw new HttpError(409, `${port ? `Port ${port}` : 'En av portarna'} används redan av något annat på servern. Edge clienten kör med de tidigare portarna.`);
        }
      });
      return { ...before, job: { action: job.action, step: job.step, error: '', running: true, started: job.started } };
    },

    async remove(iid, removeConfig) {
      if (jobs.get(iid) && !jobs.get(iid).done) throw new HttpError(409, 'En annan åtgärd pågår redan för den här edge clienten');
      jobs.delete(iid);
      const c = await must(iid);
      await docker.json('DELETE', `/containers/${c.Id}`, { query: { force: 'true' } });
      if (removeConfig) {
        for (const v of [volumeName(iid), dataVolumeName(iid)]) await docker.json('DELETE', `/volumes/${v}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      }
      return { exists: false, image: cfg.edge.image };
    },
  };
}
