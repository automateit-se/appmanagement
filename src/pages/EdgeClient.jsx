import { useCallback, useEffect, useRef, useState } from 'react';
import { backend } from '../api/backend.js';
import { onDefaultServer, serverLabel } from '../api/server.js';
import { Icon } from '../components/icons.jsx';
import { Confirm, errText } from '../components/Modal.jsx';

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

function Setup({ iid, onCreated }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      onCreated(await backend.edgeCreate(iid));
    } catch (e) {
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
      <div className="warn-box">
        IoT Open har <strong>en uppsättning credentials per installation</strong>. Om installationen redan har en edge client (till exempel en Raspberry Pi eller en gateway)
        slutar den att fungera när nya credentials skapas.
      </div>
      <label className="check confirm-check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Jag förstår att befintliga credentials för installationen ersätts
      </label>
      {error && <div className="error-box">{error}</div>}
      <button type="button" className="btn primary" disabled={!ok || busy} onClick={create}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Sätter upp, det kan ta någon minut…
          </>
        ) : (
          'Sätt upp edge client'
        )}
      </button>
    </section>
  );
}

export default function EdgeClient({ installation }) {
  const iid = installation.id;
  const [st, setSt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null); // 'renew' | 'remove' | 'update'
  const [removeConfig, setRemoveConfig] = useState(true);
  const [logKey, setLogKey] = useState(0);

  const load = useCallback(() => backend.edgeStatus(iid).then((s) => (setSt(s), setError('')), (e) => setError(errText(e))), [iid]);
  useEffect(() => {
    if (!onDefaultServer()) return;
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  if (!onDefaultServer()) {
    return <div className="info-box">Edge clients kan bara hanteras när du är inloggad mot App Managements egen IoT Open-server. Logga ut och välj standardservern.</div>;
  }

  const run = async (what, fn) => {
    setBusy(what);
    setError('');
    try {
      setSt(await fn());
      setLogKey((k) => k + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
      setConfirm(null);
    }
  };

  if (st && !st.exists) {
    return (
      <>
        {error && <div className="error-box">{error}</div>}
        <Setup iid={iid} onCreated={(s) => (setSt(s), setLogKey((k) => k + 1))} />
      </>
    );
  }

  const state = st ? STATE[st.state] || { text: st.state, cls: 'off' } : null;
  return (
    <>
      {error && <div className="error-box">{error}</div>}
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
          <div className="warn-box">Alla andra edge clients som använder installationens nuvarande credentials slutar att fungera.</div>
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
