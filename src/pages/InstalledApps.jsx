import { useCallback, useEffect, useState } from 'react';
import { lynx } from '../api/lynx.js';
import { backend } from '../api/backend.js';
import { config } from '../api/config.js';
import { onDefaultServer } from '../api/server.js';
import { compareVersions } from '../../shared/version.js';
import { githubRepo, latestVersion } from '../lib/install.js';
import { Icon } from '../components/icons.jsx';
import { Confirm, errText } from '../components/Modal.jsx';
import { InstallDialog } from '../components/InstallDialog.jsx';
import { PresenceBadge, usePresence } from '../components/EdgePresence.jsx';
import { AppHealthPanel, instanceHealth, useAppHealth } from '../components/AppHealth.jsx';

/**
 * Latest version available for an IoT Open app: from GitHub when the organization publishes it from there through
 * App Management, else the newest version published in IoT Open (also for other publishers' apps whose source is
 * on GitHub - only their publisher can add versions).
 */
async function latestFor(app, orgId) {
  const gh = Number(app.publisher?.id) === Number(orgId) ? githubRepo(app.source_url) : null;
  if (gh) {
    try {
      const d = await backend.repo(gh.owner, gh.repo);
      const v = d.versions?.[0];
      return v ? { version: v.name, github: { owner: d.owner, repo: d.repo, tag: v.tag }, source: 'github', url: d.url } : { source: 'github', url: d.url };
    } catch {
      return { source: 'github', url: app.source_url, unreachable: true };
    }
  }
  const v = latestVersion(await lynx.edgeAppVersions(app.id).catch(() => []));
  return { version: v?.name, source: 'iotopen' };
}

function EdgeHint({ iid, access }) {
  const [st, setSt] = useState(null);
  const [p] = usePresence(iid, 0);
  const local = config.edgeClients && onDefaultServer() && !!(access?.viewEdge || access?.manageEdge);
  useEffect(() => {
    if (!local) return;
    backend.edgeStatus(iid).then(setSt, () => setSt(null));
  }, [iid, local]);
  if (!onDefaultServer() || !p) return null;
  const edgeLink = local && (st?.exists || access?.createEdge) && (
    <a className="btn" href={`#/i/${iid}/edge`}>
      {st?.exists ? 'Visa edge client' : 'Sätt upp edge client'}
    </a>
  );
  if (p.state === 'online') {
    return (
      <div className="info-box row gap wrap">
        <Icon name="box" />
        <span className="grow">
          Edge client: <PresenceBadge p={p} /> {st?.exists ? 'Den körs här i App Management.' : local && st ? 'Apparna körs av installationens edge client, som körs någon annanstans än här i App Management.' : 'Apparna körs av installationens edge client.'}
        </span>
      </div>
    );
  }
  if (p.state === 'offline') {
    return (
      <div className="warn-box row gap wrap">
        <Icon name="alert" />
        <span className="grow">
          Installationens edge client är <strong>offline</strong> i IoT Open, så apparna körs inte just nu.
          {st?.exists && !st.running ? ' Den finns här men är stoppad.' : ''}
        </span>
        {edgeLink}
      </div>
    );
  }
  if (!local || st?.exists || !access?.createEdge) return null;
  return (
    <div className="info-box row gap wrap">
      <Icon name="box" />
      <span className="grow">Ingen edge client har rapporterat in för installationen. Apparna körs av en edge client; har du ingen kan App Management sätta upp en IoT Open Docker Edge Client åt dig.</span>
      {edgeLink}
    </div>
  );
}

export default function InstalledApps({ installation, access }) {
  const iid = installation.id;
  // unknown access (other server, still loading): offer everything, IoT Open refuses what is not allowed
  const canUpdate = access ? access.updateApps : true;
  const canRemove = access ? access.installApps : true;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  // apps run by an edge client here in App Management's Docker environment: health read from Docker
  const local = config.edgeClients && onDefaultServer() && !!access?.viewEdge;
  const [health, reloadHealth] = useAppHealth(iid, local && !!rows?.length);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = (await lynx.instances(iid)) || [];
      const ids = [...new Set(list.map((i) => i.app_id))];
      const apps = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await lynx.edgeApp(id).catch(() => null)])));
      const latest = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, apps[id] ? await latestFor(apps[id], installation.organization_id) : null])));
      setRows(
        list
          .map((inst) => ({ inst, app: apps[inst.app_id], latest: latest[inst.app_id] }))
          .sort((a, b) => String(a.inst.name).localeCompare(String(b.inst.name), 'sv')),
      );
    } catch (e) {
      setError(errText(e));
      setRows([]);
    }
  }, [iid, installation.organization_id]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    setBusy(true);
    try {
      await lynx.deleteInstance(iid, removing.id);
      setRemoving(null);
      await load();
    } catch (e) {
      setError(errText(e));
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <EdgeHint iid={iid} access={access} />
      {error && <div className="error-box">{error}</div>}
      {rows === null && <p className="muted">Laddar…</p>}
      {rows && !rows.length && !error && (
        <div className="empty">
          <Icon name="app" size={32} />
          <p>Inga edge apps är installerade på den här installationen.</p>
          {canRemove && (
            <a className="btn primary" href={`#/i/${iid}/add`}>
              <Icon name="plus" size={16} /> Lägg till app
            </a>
          )}
        </div>
      )}
      <div className="cards">
        {rows?.map(({ inst, app, latest }) => {
          const update = latest?.version && compareVersions(latest.version, inst.version) > 0;
          return (
            <article key={inst.id} className="card">
              <header className="card-head">
                <Icon name={latest?.source === 'github' ? 'github' : 'cloud'} className="card-icon" />
                <div className="grow">
                  <h3>{inst.name}</h3>
                  <span className="muted small">
                    {app ? app.name : `App ${inst.app_id}`} · version {inst.version}
                  </span>
                </div>
              </header>
              {app?.short_description && <p className="small card-text">{app.short_description}</p>}
              {health && (
                <AppHealthPanel iid={iid} inst={inst} health={instanceHealth(health, inst)} windowSec={health.windowSec} canRestart={canUpdate} onRestarted={reloadHealth} />
              )}
              <div className="badges">
                {latest?.source === 'github' ? <span className="badge">GitHub</span> : <span className="badge">IoT Open</span>}
                {update && <span className="badge accent">Ny version {latest.version}</span>}
                {latest?.unreachable && <span className="badge">GitHub nås inte</span>}
                {!app && <span className="badge warn">Appen finns inte längre i IoT Open</span>}
              </div>
              <div className="card-actions">
                {update && canUpdate && (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => setJob(latest.github ? { mode: 'update', instance: inst, github: latest.github } : { mode: 'update', instance: inst, app, version: latest.version })}
                  >
                    <Icon name="download" size={16} /> Uppdatera
                  </button>
                )}
                {app && canUpdate && (
                  <button type="button" className="btn" onClick={() => setJob({ mode: 'settings', instance: inst, app })}>
                    <Icon name="settings" size={16} /> Inställningar
                  </button>
                )}
                <span className="grow" />
                {canRemove && (
                  <button type="button" className="icon-btn" title="Ta bort" aria-label={`Ta bort ${inst.name}`} onClick={() => setRemoving(inst)}>
                    <Icon name="trash" size={18} />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {job && (
        <InstallDialog
          installation={installation}
          job={job}
          onClose={() => setJob(null)}
          onDone={() => {
            setJob(null);
            load();
          }}
        />
      )}
      {removing && (
        <Confirm title={`Ta bort ${removing.name}?`} danger confirmText="Ta bort" busy={busy} onClose={() => setRemoving(null)} onConfirm={remove}>
          <p>Appen tas bort från installationen och slutar köras på edge clienten. Dess inställningar försvinner.</p>
        </Confirm>
      )}
    </>
  );
}
