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

  async function createContainer(iid, user) {
    await ensureNetwork();
    const body = {
      Image: cfg.edge.image,
      Env: ['HEADLESS=true'],
      Labels: labels(iid, user),
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        // the image's /etc/iot-open (mosquitto template) is copied into the new volume, iotopen.json is added
        Mounts: [{ Type: 'volume', Source: volumeName(iid), Target: '/etc/iot-open' }],
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
      job,
    };
  }

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
        await docker.json('DELETE', `/containers/${c.Id}`, { query: { force: 'true' } });
        const id = await createContainer(iid, user);
        await docker.json('POST', `/containers/${id}/start`);
      });
      return { ...before, job: { action: job.action, step: job.step, error: '', running: true, started: job.started } };
    },

    async remove(iid, removeConfig) {
      if (jobs.get(iid) && !jobs.get(iid).done) throw new HttpError(409, 'En annan åtgärd pågår redan för den här edge clienten');
      jobs.delete(iid);
      const c = await must(iid);
      await docker.json('DELETE', `/containers/${c.Id}`, { query: { force: 'true' } });
      if (removeConfig) await docker.json('DELETE', `/volumes/${volumeName(iid)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      return { exists: false, image: cfg.edge.image };
    },
  };
}
