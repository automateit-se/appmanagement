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

/** Latest version available for an IoT Open app: from GitHub when it came from there, else from IoT Open. */
async function latestFor(app) {
  const gh = githubRepo(app.source_url);
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

function EdgeHint({ iid }) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    if (!config.edgeClients || !onDefaultServer()) return;
    backend.edgeStatus(iid).then(setSt, () => setSt(null));
  }, [iid]);
  if (!st) return null;
  if (!st.exists) {
    return (
      <div className="info-box row gap wrap">
        <Icon name="box" />
        <span className="grow">Apparna körs av en edge client som är kopplad till installationen. Har du ingen kan App Management sätta upp en IoT Open Docker Edge Client åt dig.</span>
        <a className="btn" href={`#/i/${iid}/edge`}>
          Sätt upp edge client
        </a>
      </div>
    );
  }
  if (!st.running) {
    return (
      <div className="warn-box row gap wrap">
        <Icon name="alert" />
        <span className="grow">Installationens edge client här är inte igång, så apparna körs inte.</span>
        <a className="btn" href={`#/i/${iid}/edge`}>
          Visa edge client
        </a>
      </div>
    );
  }
  return null;
}

export default function InstalledApps({ installation }) {
  const iid = installation.id;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = (await lynx.instances(iid)) || [];
      const ids = [...new Set(list.map((i) => i.app_id))];
      const apps = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await lynx.edgeApp(id).catch(() => null)])));
      const latest = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, apps[id] ? await latestFor(apps[id]) : null])));
      setRows(
        list
          .map((inst) => ({ inst, app: apps[inst.app_id], latest: latest[inst.app_id] }))
          .sort((a, b) => String(a.inst.name).localeCompare(String(b.inst.name), 'sv')),
      );
    } catch (e) {
      setError(errText(e));
      setRows([]);
    }
  }, [iid]);

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
      <EdgeHint iid={iid} />
      {error && <div className="error-box">{error}</div>}
      {rows === null && <p className="muted">Laddar…</p>}
      {rows && !rows.length && !error && (
        <div className="empty">
          <Icon name="app" size={32} />
          <p>Inga edge apps är installerade på den här installationen.</p>
          <a className="btn primary" href={`#/i/${iid}/add`}>
            <Icon name="plus" size={16} /> Lägg till app
          </a>
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
              <div className="badges">
                {latest?.source === 'github' ? <span className="badge">GitHub</span> : <span className="badge">IoT Open</span>}
                {update && <span className="badge accent">Ny version {latest.version}</span>}
                {latest?.unreachable && <span className="badge">GitHub nås inte</span>}
                {!app && <span className="badge warn">Appen finns inte längre i IoT Open</span>}
              </div>
              <div className="card-actions">
                {update && (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => setJob(latest.github ? { mode: 'update', instance: inst, github: latest.github } : { mode: 'update', instance: inst, app, version: latest.version })}
                  >
                    <Icon name="download" size={16} /> Uppdatera
                  </button>
                )}
                {app && (
                  <button type="button" className="btn" onClick={() => setJob({ mode: 'settings', instance: inst, app })}>
                    <Icon name="settings" size={16} /> Inställningar
                  </button>
                )}
                <span className="grow" />
                <button type="button" className="icon-btn" title="Ta bort" aria-label={`Ta bort ${inst.name}`} onClick={() => setRemoving(inst)}>
                  <Icon name="trash" size={18} />
                </button>
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
