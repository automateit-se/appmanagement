import { useEffect, useMemo, useState } from 'react';
import { lynx } from '../api/lynx.js';
import { backend } from '../api/backend.js';
import { config } from '../api/config.js';
import { githubRepo, latestVersion, normUrl } from '../lib/install.js';
import { sortVersionsDesc } from '../../shared/version.js';
import { Icon } from '../components/icons.jsx';
import { Field, Modal, errText } from '../components/Modal.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { InstallDialog } from '../components/InstallDialog.jsx';

const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('sv-SE') : '');

function GithubDetail({ item, twin, onClose, onInstall, onOpenTwin }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [tag, setTag] = useState('');
  useEffect(() => {
    backend.repo(item.owner, item.repo).then(
      (x) => {
        setD(x);
        setTag(x.versions?.[0]?.tag || '');
      },
      (e) => setError(errText(e)),
    );
  }, [item]);
  const v = d?.versions?.find((x) => x.tag === tag);
  return (
    <Modal
      title={item.name}
      wide
      onClose={onClose}
      footer={
        <>
          <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer">
            <Icon name="github" size={16} /> GitHub
          </a>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Stäng
          </button>
          <button type="button" className="btn primary" disabled={!v} onClick={() => onInstall({ mode: 'install', title: item.name, github: { owner: d.owner, repo: d.repo, tag: v.tag } })}>
            Installera{v && !v.unreleased ? ` ${v.name}` : ''}
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      {!d && !error && <p className="muted">Laddar…</p>}
      {d && (
        <>
          <p className="muted small">
            {d.owner}/{d.repo}
            {d.license ? ` · ${d.license}` : ''}
          </p>
          {!config.githubOwners?.length && (
            <div className="warn-box small">Appens kod körs på installationens edge client med installationens behörigheter. Installera bara appar från källor du litar på.</div>
          )}
          {d.versions?.length ? (
            <Field label="Version" help={v?.published ? `${v.unreleased ? 'Ändrad' : 'Släppt'} ${fmtDate(v.published)}` : undefined}>
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                {d.versions.map((x, i) => (
                  <option key={x.tag} value={x.tag}>
                    {x.unreleased ? `Senaste ändringen ${fmtDate(x.published)} (${x.name})` : `${x.name}${i === 0 ? ' (senaste)' : ''}`}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="warn-box">Appen har ingen release på GitHub ännu och kan inte installeras.</div>
          )}
          {v?.unreleased && (
            <div className="info-box small">Appen har inga releaser på GitHub, så den senaste ändringen på {d.defaultBranch} installeras. När en ny ändring görs där visas den som en ny version.</div>
          )}
          {twin && (
            <div className="info-box small row gap wrap">
              <span className="grow">
                Det finns redan en app med samma namn i IoT Open ({twin.publisher?.name || 'IoT Open'}
                {twin.official ? ', officiell' : ''}). Den är troligen samma app och kan installeras därifrån utan att en kopia skapas i din organisation.
              </span>
              <button type="button" className="btn" onClick={onOpenTwin}>
                Visa i IoT Open
              </button>
            </div>
          )}
          {v?.notes && !v.unreleased && (
            <details className="notes">
              <summary>Nyheter i {v.name}</summary>
              <Markdown text={v.notes} />
            </details>
          )}
          {d.readme ? <Markdown text={d.readme} /> : <p>{d.description}</p>}
        </>
      )}
    </Modal>
  );
}

function IotOpenDetail({ app, repo, onClose, onInstall }) {
  const [versions, setVersions] = useState(null);
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    lynx.edgeAppVersions(app.id).then(
      (list) => {
        const named = sortVersionsDesc((list || []).filter((x) => x.name), (x) => x.name);
        setVersions(named);
        setVersion(latestVersion(named)?.name || '');
      },
      (e) => setError(errText(e)),
    );
  }, [app]);
  return (
    <Modal
      title={app.name}
      wide
      onClose={onClose}
      footer={
        <>
          {repo && (
            <a className="btn" href={repo.url} target="_blank" rel="noopener noreferrer">
              <Icon name="github" size={16} /> GitHub
            </a>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Stäng
          </button>
          <button type="button" className="btn primary" disabled={!version} onClick={() => onInstall({ mode: 'install', title: app.name, app, version })}>
            Installera{version ? ` ${version}` : ''}
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      <p className="muted small">
        {app.publisher?.name || 'IoT Open'}
        {app.official ? ' · officiell' : ''}
      </p>
      {versions && !versions.length && <div className="warn-box">Appen har ingen publicerad version.</div>}
      {versions?.length > 0 && (
        <Field label="Version">
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            {versions.map((x, i) => (
              <option key={x.name} value={x.name}>
                {x.name}
                {i === 0 ? ' (senaste)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {app.description ? <Markdown text={app.description} /> : <p>{app.short_description}</p>}
    </Modal>
  );
}

export default function Catalog({ installation }) {
  const iid = installation.id;
  const [gh, setGh] = useState(null);
  const [ghError, setGhError] = useState('');
  const [io, setIo] = useState(null);
  const [ioError, setIoError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // { kind: 'github'|'iotopen', item }
  const [job, setJob] = useState(null);
  const [done, setDone] = useState('');

  useEffect(() => {
    backend.catalog().then(setGh, (e) => {
      setGh([]);
      setGhError(errText(e));
    });
    lynx
      .edgeAppsOrganization(installation.organization_id, true)
      .catch(() => lynx.edgeApps())
      .then(
        (list) => setIo(list || []),
        (e) => {
          setIo([]);
          setIoError(errText(e));
        },
      );
  }, [installation.organization_id]);

  const needle = q.trim().toLowerCase();
  const hit = (...s) => !needle || s.some((x) => String(x || '').toLowerCase().includes(needle));
  const ghUrls = useMemo(() => new Set((gh || []).map((r) => normUrl(r.url))), [gh]);
  // apps that came from GitHub through App Management are listed once, under GitHub
  const ioShown = (io || []).filter((a) => !(githubRepo(a.source_url) && ghUrls.has(normUrl(a.source_url)))).filter((a) => hit(a.name, a.short_description, ...(a.tags || [])));
  const ghShown = (gh || []).filter((r) => hit(r.name, r.description, r.id, ...(r.topics || [])));
  // the GitHub repository is already published in IoT Open by another organization (e.g. IoT Open's own apps):
  // install that app and its published versions instead of making a copy in this organization
  const publishedElsewhere = (r) =>
    (io || []).find((a) => normUrl(a.source_url) === normUrl(r.url) && Number(a.publisher?.id) !== Number(installation.organization_id));
  // an app already in IoT Open under the same name, from another publisher (e.g. IoT Open's own copy of its GitHub app)
  const twinOf = (r) => (io || []).find((a) => a.name?.trim().toLowerCase() === r.name.trim().toLowerCase() && normUrl(a.source_url) !== normUrl(r.url));

  return (
    <>
      <div className="row gap wrap toolbar">
        <p className="muted small grow">
          Appar på GitHub med topic <code>{config.githubTopic}</code>
          {config.githubOwners?.length ? ` från ${config.githubOwners.join(', ')}` : ''} och appar som redan finns i IoT Open.
        </p>
        <input className="search" placeholder="Sök app…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {done && (
        <div className="info-box row gap">
          <Icon name="check" /> <span className="grow">{done} är installerad.</span>
          <a href={`#/i/${iid}`}>Visa installerade appar</a>
        </div>
      )}

      <h2 className="section-title">
        <Icon name="github" size={18} /> Från GitHub
      </h2>
      {ghError && <div className="error-box">{ghError}</div>}
      {gh === null && <p className="muted">Laddar…</p>}
      {gh && !ghShown.length && !ghError && <p className="muted">{needle ? 'Ingen app matchar sökningen.' : 'Hittade inga appar på GitHub.'}</p>}
      <div className="cards">
        {ghShown.map((r) => (
          <button
            type="button"
            key={r.id}
            className="card pick"
            onClick={() => (publishedElsewhere(r) ? setOpen({ kind: 'iotopen', item: publishedElsewhere(r), repo: r }) : setOpen({ kind: 'github', item: r }))}
          >
            <header className="card-head">
              <Icon name="github" className="card-icon" />
              <div className="grow">
                <h3>{r.name}</h3>
                <span className="muted small">{r.id}</span>
              </div>
            </header>
            <p className="small card-text">{r.description}</p>
            <div className="badges">
              {publishedElsewhere(r) && <span className="badge">Publicerad i IoT Open av {publishedElsewhere(r).publisher?.name || 'IoT Open'}</span>}
              {r.topics.slice(0, 4).map((t) => (
                <span key={t} className="badge">
                  {t}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      <h2 className="section-title">
        <Icon name="cloud" size={18} /> Finns i IoT Open
      </h2>
      {ioError && <div className="error-box">{ioError}</div>}
      {io === null && <p className="muted">Laddar…</p>}
      {io && !ioShown.length && !ioError && <p className="muted">{needle ? 'Ingen app matchar sökningen.' : 'Inga andra appar finns tillgängliga i IoT Open.'}</p>}
      <div className="cards">
        {ioShown.map((a) => (
          <button type="button" key={a.id} className="card pick" onClick={() => setOpen({ kind: 'iotopen', item: a })}>
            <header className="card-head">
              <Icon name="cloud" className="card-icon" />
              <div className="grow">
                <h3>{a.name}</h3>
                <span className="muted small">
                  {a.publisher?.name || 'IoT Open'}
                  {a.official ? ' · officiell' : ''}
                </span>
              </div>
            </header>
            <p className="small card-text">{a.short_description}</p>
          </button>
        ))}
      </div>

      {open?.kind === 'github' && (
        <GithubDetail
          item={open.item}
          twin={twinOf(open.item)}
          onClose={() => setOpen(null)}
          onInstall={(j) => (setOpen(null), setJob(j))}
          onOpenTwin={() => setOpen({ kind: 'iotopen', item: twinOf(open.item) })}
        />
      )}
      {open?.kind === 'iotopen' && <IotOpenDetail app={open.item} repo={open.repo} onClose={() => setOpen(null)} onInstall={(j) => (setOpen(null), setJob(j))} />}
      {job && (
        <InstallDialog
          installation={installation}
          job={job}
          onClose={() => setJob(null)}
          onDone={() => {
            setDone(job.title || 'Appen');
            setJob(null);
          }}
        />
      )}
    </>
  );
}
