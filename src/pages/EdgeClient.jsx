import { useCallback, useEffect, useRef, useState } from 'react';
import { backend } from '../api/backend.js';
import { onDefaultServer, serverLabel } from '../api/server.js';
import { Icon } from '../components/icons.jsx';
import { Confirm, errText } from '../components/Modal.jsx';
import { PresenceBadge, fmtSince, usePresence } from '../components/EdgePresence.jsx';
import { megabytes, useAppHealth } from '../components/AppHealth.jsx';

// IoT Open Docker Edge Client for one installation, run in the same Docker environment as App Management.

const fmt = (s) => {
  if (!s || s.startsWith('0001-')) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('sv-SE');
};

const STATE = {
  running: { text: 'Kör', cls: 'ok' },
  restarting: { text: 'Startar om', cls: 'warn' },
  created: { text: 'Skapad, inte startad', cls: 'off' },
  exited: { text: 'Stoppad', cls: 'off' },
  paused: { text: 'Pausad', cls: 'off' },
  dead: { text: 'Fel', cls: 'crit' },
};

function Logs({ iid, refreshKey }) {
  const [lines, setLines] = useState(null);
  const [tail, setTail] = useState(200);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState('');
  const box = useRef(null);

  const load = useCallback(() => {
    backend.edgeLogs(iid, tail).then(
      (l) => {
        setLines(l);
        setError('');
      },
      (e) => setError(errText(e)),
    );
  }, [iid, tail]);

  useEffect(() => {
    load();
    if (!follow) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, follow, refreshKey]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const shown = (lines || []).filter((l) => !onlyErrors || l.error);
  return (
    <section className="panel">
      <div className="row gap wrap panel-head">
        <h2 className="grow">
          <Icon name="terminal" size={18} /> Logg
        </h2>
        <label className="check small">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Bara fel
        </label>
        <label className="check small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Följ
        </label>
        <select className="compact" value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Antal rader">
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>
              {n} rader
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" onClick={load} title="Läs om" aria-label="Läs om loggen">
          <Icon name="refresh" size={18} />
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="log" ref={box}>
        {lines === null && <span className="muted">Laddar…</span>}
        {lines && !shown.length && <span className="muted">{onlyErrors ? 'Inga fel i de senaste raderna.' : 'Loggen är tom.'}</span>}
        {shown.map((l, i) => (
          <div key={i} className={`log-line${l.error ? ' bad' : ''}${l.stream === 'stderr' ? ' stderr' : ''}`}>
            {l.time && <span className="log-time">{fmt(l.time)}</span>}
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** What IoT Open says about an edge client the installation may already have. */
function ExistingWarning({ p }) {
  if (!p) {
    return (
      <div className="info-box progress">
        <span className="spinner" aria-hidden="true" /> Kontrollerar om installationen redan har en edge client i IoT Open…
      </div>
    );
  }
  if (p.state === 'online') {
    return (
      <div className="error-box">
        <strong>Installationen har redan en edge client som är online.</strong> IoT Open rapporterar Edge status: Online
        {p.since ? ` sedan ${fmtSince(p.since)}` : ''}. Det kan vara en Raspberry Pi, en gateway eller en annan Docker-värd. Den kopplas bort och slutar fungera om
        du fortsätter, och apparna flyttar hit.
      </div>
    );
  }
  if (p.state === 'offline') {
    return (
      <div className="warn-box">
        Installationen har haft en edge client, men den är <strong>offline</strong>
        {p.since ? ` sedan ${fmtSince(p.since)}` : ''}. När nya credentials skapas kan den inte ansluta igen med de gamla.
      </div>
    );
  }
  return (
    <div className="warn-box">
      Ingen edge client har rapporterat status för installationen. IoT Open har ändå <strong>en uppsättning credentials per installation</strong>: om det finns en edge
      client som inte är ansluten just nu (till exempel en avstängd Raspberry Pi) slutar den att fungera när nya credentials skapas.
    </div>
  );
}

/**
 * No edge client here, and the user may not set one up: what IoT Open says about the installation's edge client,
 * which may well run elsewhere (a gateway, a Raspberry Pi, another server).
 */
function Elsewhere({ p, access }) {
  const why = !access?.manageEdge
    ? `Din roll i IoT Open (${access?.role || 'okänd'}) får inte sätta upp en edge client här; det kräver rätten att byta installationens gateway-credentials.`
    : access?.restrictedBy === 'EDGE_PERMISSION'
      ? 'Att sätta upp en edge client här kräver en roll i IoT Open med en särskild rättighet. Kontakta den som administrerar rollerna i IoT Open.'
      : 'På den här servern får bara utvalda användare sätta upp edge clients. Kontakta den som driftar App Management.';
  const here = 'Status, logg och apparnas hälsa kan App Management bara visa för edge clients som körs här.';
  if (p?.state === 'online' || p?.state === 'offline') {
    return (
      <>
        <div className="info-box">
          <p className="row gap wrap" style={{ margin: '0 0 6px' }}>
            <strong>Installationens edge client körs någon annanstans</strong> <PresenceBadge p={p} />
          </p>
          IoT Open rapporterar att installationen har en edge client{p.since ? ` (${p.state === 'online' ? 'online' : 'offline'} sedan ${fmtSince(p.since)})` : ''}, men den
          körs inte här i App Management, utan till exempel på en gateway, en Raspberry Pi eller en annan server.{' '}
          {p.state === 'online' ? 'Apparna körs av den.' : 'Apparna körs inte förrän den är online igen.'} {here}
        </div>
        <p className="muted small">{why}</p>
      </>
    );
  }
  return (
    <div className="info-box">
      {p ? 'Installationen har ingen edge client här, och ingen edge client har rapporterat status till IoT Open.' : 'Installationen har ingen edge client här.'} {why}
    </div>
  );
}

function Setup({ iid, onCreated }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [p, reloadPresence, setP] = usePresence(iid, 0);
  const online = p?.state === 'online';
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      onCreated(await backend.edgeCreate(iid, online));
    } catch (e) {
      // went online while the page was open: show it and ask again
      if (e.body?.code === 'edge-online') {
        setP(e.body.presence);
        setOk(false);
      }
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>
        <Icon name="box" size={18} /> Sätt upp en edge client
      </h2>
      <p>
        Edge apps körs av en <strong>edge client</strong> som är kopplad till installationen. App Management kan starta en IoT Open Docker Edge Client i samma
        Docker-miljö som App Management körs i. Den kopplar upp sig mot {serverLabel()} med MQTT och hämtar automatiskt de appar som är installerade här.
      </p>
      <ol className="steps">
        <li>Den senaste versionen av IoT Opens edge client hämtas.</li>
        <li>Nya credentials för installationen skapas i IoT Open och sparas i edge clientens egen volym. De visas aldrig i webbläsaren.</li>
        <li>Edge clienten startas och startar om sig själv om Docker-värden startas om.</li>
      </ol>
      <ExistingWarning p={p} />
      {p && (
        <div className="row gap wrap small muted presence-row">
          Edge status i IoT Open: <PresenceBadge p={p} />
          <button type="button" className="link-btn small" onClick={() => (setP(null), reloadPresence())}>
            Kontrollera igen
          </button>
        </div>
      )}
      <label className="check confirm-check">
        <input type="checkbox" checked={ok} disabled={!p} onChange={(e) => setOk(e.target.checked)} />{' '}
        {online ? 'Jag förstår att edge clienten som är online kopplas bort och ersätts av en här' : 'Jag förstår att befintliga credentials för installationen ersätts'}
      </label>
      {error && <div className="error-box">{error}</div>}
      <button type="button" className={`btn ${online ? 'danger-solid' : 'primary'}`} disabled={!ok || busy || !p} onClick={create}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Startar…
          </>
        ) : (
          online ? 'Ersätt och sätt upp edge client' : 'Sätt upp edge client'
        )}
      </button>
    </section>
  );
}

export default function EdgeClient({ installation, access }) {
  const iid = installation.id;
  // IoT Open decides: gateway/reset/password on the installation (see server/access.mjs)
  const readOnly = !access?.manageEdge;
  const [st, setSt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null); // 'renew' | 'remove' | 'update'
  const [removeConfig, setRemoveConfig] = useState(true);
  const [logKey, setLogKey] = useState(0);
  const [presence, reloadPresence] = usePresence(iid, st?.exists ? 20000 : 0);
  const [health] = useAppHealth(iid, !!st?.running);
  const appCount = health ? Object.values(health.apps).filter((a) => a.running).length : 0;
  const [jobError, setJobError] = useState(null); // { action, error } of a set-up or update that failed
  const working = !!st?.job?.running;

  const accept = useCallback((s) => {
    setSt(s);
    // the backend reports a failed job once; keep it on screen until the next action
    if (s?.job?.error) setJobError({ action: s.job.action, error: s.job.error });
  }, []);
  const load = useCallback(() => backend.edgeStatus(iid).then((s) => (accept(s), setError('')), (e) => setError(errText(e))), [iid, accept]);
  useEffect(() => {
    if (!onDefaultServer()) return;
    load();
    // while setting up or updating, follow the progress closely
    const t = setInterval(load, working ? 2000 : 10000);
    return () => clearInterval(t);
  }, [load, working]);
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) {
      setLogKey((k) => k + 1);
      setTimeout(reloadPresence, 5000);
    }
    wasWorking.current = working;
  }, [working, reloadPresence]);

  if (!onDefaultServer()) {
    return <div className="info-box">Edge clients kan bara hanteras när du är inloggad mot App Managements egen IoT Open-server. Logga ut och välj standardservern.</div>;
  }

  const run = async (what, fn) => {
    setBusy(what);
    setError('');
    setJobError(null);
    try {
      accept(await fn());
      setLogKey((k) => k + 1);
      setTimeout(reloadPresence, 3000);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
      setConfirm(null);
    }
  };

  const jobFailed = jobError && (
    <div className="error-box">
      {jobError.action === 'create' ? 'Uppsättningen av edge clienten misslyckades' : 'Uppdateringen misslyckades'}: {jobError.error}
    </div>
  );

  if (working) {
    return (
      <section className="panel">
        <h2>
          <Icon name="box" size={18} /> {st.job.action === 'create' ? 'Sätter upp edge client' : 'Uppdaterar edge client'}
        </h2>
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          {st.job.step || 'Arbetar…'}
        </div>
        <p className="muted small">Det kan ta några minuter första gången, när IoT Opens edge client hämtas. Du kan lämna sidan; arbetet fortsätter.</p>
      </section>
    );
  }

  if (st && !st.exists) {
    return (
      <>
        {error && <div className="error-box">{error}</div>}
        {jobFailed}
        {!access?.createEdge ? (
          <Elsewhere p={presence} access={access} />
        ) : (
          <Setup iid={iid} onCreated={(s) => (setJobError(null), accept(s))} />
        )}
      </>
    );
  }

  const state = st ? STATE[st.state] || { text: st.state, cls: 'off' } : null;
  return (
    <>
      {error && <div className="error-box">{error}</div>}
      {jobFailed}
      {!st && !error && <p className="muted">Laddar…</p>}
      {st && (
        <section className="panel">
          <div className="row gap wrap panel-head">
            <h2 className="grow">
              <Icon name="box" size={18} /> IoT Open Docker Edge Client
            </h2>
            <span className={`state ${state.cls}`}>
              <span className="dot" /> {state.text}
            </span>
          </div>
          <dl className="facts">
            <dt>Container</dt>
            <dd>
              <code>{st.name}</code> <span className="muted small">{st.id}</span>
            </dd>
            <dt>Image</dt>
            <dd>
              <code>{st.image}</code>
            </dd>
            {st.running ? (
              <>
                <dt>Startad</dt>
                <dd>{fmt(st.startedAt) || '-'}</dd>
              </>
            ) : (
              <>
                <dt>Stoppad</dt>
                <dd>
                  {fmt(st.finishedAt) || '-'}
                  {st.exitCode ? ` (kod ${st.exitCode})` : ''}
                </dd>
              </>
            )}
            <dt>I IoT Open</dt>
            <dd className="row gap wrap">
              <PresenceBadge p={presence} />
              {presence?.state === 'offline' && st.running && <span className="muted small">Containern kör men har inte kontakt med IoT Open. Se loggen.</span>}
              {presence?.state === 'unknown' && st.running && <span className="muted small">Ingen status från edge clienten ännu.</span>}
            </dd>
            {health?.memory && (
              <>
                <dt>Minne</dt>
                <dd>
                  {megabytes(health.memory.usage / 1024)}
                  {health.memory.limit ? ` av ${megabytes(health.memory.limit / 1024)}` : ''}
                </dd>
              </>
            )}
            {health?.processesRead && (
              <>
                <dt>Appar som kör</dt>
                <dd>{appCount}</dd>
              </>
            )}
            <dt>Omstarter</dt>
            <dd>{st.restartCount}</dd>
            <dt>Fel i loggen</dt>
            <dd>
              {st.recentErrors ? (
                <span className="err">
                  {st.recentErrors} av de senaste 300 raderna
                  {st.lastError && (
                    <>
                      <br />
                      <code className="wrap-code">{st.lastError.text}</code>
                    </>
                  )}
                </span>
              ) : (
                'Inga'
              )}
            </dd>
            {st.error && (
              <>
                <dt>Docker</dt>
                <dd className="err">{st.error}</dd>
              </>
            )}
          </dl>
          {readOnly ? (
            <p className="muted small">Din roll i IoT Open ({access?.role || 'okänd'}) kan se edge clienten men inte ändra den.</p>
          ) : (
          <div className="row gap wrap">
            {st.running ? (
              <button type="button" className="btn" disabled={!!busy} onClick={() => run('stop', () => backend.edgeAction(iid, 'stop'))}>
                <Icon name="stop" size={16} /> {busy === 'stop' ? 'Stoppar…' : 'Stoppa'}
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => run('start', () => backend.edgeAction(iid, 'start'))}>
                <Icon name="play" size={16} /> {busy === 'start' ? 'Startar…' : 'Starta'}
              </button>
            )}
            <button type="button" className="btn" disabled={!!busy} onClick={() => run('restart', () => backend.edgeAction(iid, 'restart'))}>
              <Icon name="refresh" size={16} /> {busy === 'restart' ? 'Startar om…' : 'Starta om'}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => setConfirm('update')}>
              <Icon name="download" size={16} /> Uppdatera
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => setConfirm('renew')}>
              <Icon name="key" size={16} /> Nya credentials
            </button>
            <span className="grow" />
            <button type="button" className="btn danger" disabled={!!busy} onClick={() => setConfirm('remove')}>
              <Icon name="trash" size={16} /> Ta bort
            </button>
          </div>
          )}
        </section>
      )}
      {st?.exists && <Logs iid={iid} refreshKey={logKey} />}

      {confirm === 'update' && (
        <Confirm title="Uppdatera edge clienten?" confirmText="Uppdatera" busy={busy === 'update'} onClose={() => setConfirm(null)} onConfirm={() => run('update', () => backend.edgeAction(iid, 'update'))}>
          <p>
            Senaste versionen av <code>{st.image}</code> hämtas och edge clienten startas om med den. Inställningar och credentials behålls. Apparna står still under
            några sekunder.
          </p>
        </Confirm>
      )}
      {confirm === 'renew' && (
        <Confirm title="Skapa nya credentials?" confirmText="Skapa nya" danger busy={busy === 'renew'} onClose={() => setConfirm(null)} onConfirm={() => run('renew', () => backend.edgeRenew(iid))}>
          <p>Använd det här om edge clienten inte längre kommer in i IoT Open, till exempel för att credentials har skapats någon annanstans.</p>
          <p className="row gap small">
            Edge status i IoT Open just nu: <PresenceBadge p={presence} />
          </p>
          {presence?.state === 'online' && !st.running ? (
            <div className="error-box">En annan edge client är online för installationen. Den kopplas bort.</div>
          ) : (
            <div className="warn-box">Alla andra edge clients som använder installationens nuvarande credentials slutar att fungera.</div>
          )}
        </Confirm>
      )}
      {confirm === 'remove' && (
        <Confirm title="Ta bort edge clienten?" confirmText="Ta bort" danger busy={busy === 'remove'} onClose={() => setConfirm(null)} onConfirm={() => run('remove', () => backend.edgeRemove(iid, removeConfig))}>
          <p>Containern stoppas och tas bort. Apparna på installationen ligger kvar i IoT Open men körs inte förrän en edge client är kopplad igen.</p>
          <label className="check">
            <input type="checkbox" checked={removeConfig} onChange={(e) => setRemoveConfig(e.target.checked)} /> Ta även bort sparade credentials (volymen{' '}
            <code>iotopen-edge-{iid}-config</code>)
          </label>
        </Confirm>
      )}
    </>
  );
}
