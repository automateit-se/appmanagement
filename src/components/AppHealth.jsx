import { useCallback, useEffect, useState } from 'react';
import { backend } from '../api/backend.js';
import { lynx } from '../api/lynx.js';
import { Icon } from './icons.jsx';
import { errText } from './Modal.jsx';

// Health of an installed app when the installation's edge client runs here in App Management's Docker
// environment: read by the backend from the edge client's processes and log (see server/appHealth.mjs).

const STATE = {
  running: { text: 'Kör', cls: 'ok' },
  crashing: { text: 'Kraschar', cls: 'crit' },
  stopped: { text: 'Körs inte', cls: 'warn' },
  pending: { text: 'Väntar på start', cls: 'off' },
  'edge-stopped': { text: 'Edge clienten är stoppad', cls: 'off' },
};

const fmtTime = (s) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('sv-SE') : '';
};

/** The edge client names an app's code by its path on disk; app.lua is what the developer knows it as. */
export const tidy = (text) => String(text || '').replace(/\/var\/lib\/iot-open\/edge\/apps\/\d+-[^:\s]+:/g, 'app.lua:');

export function duration(sec) {
  if (sec === null || sec === undefined) return '';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${Math.max(0, Math.floor(sec))} s`;
}

export const megabytes = (kb) => (kb === null || kb === undefined ? '' : `${(kb / 1024).toFixed(kb < 10240 ? 1 : 0)} MB`);

/** Polls the health of the apps on the installation's local edge client; null when there is none here. */
export function useAppHealth(iid, enabled) {
  const [health, setHealth] = useState(null);
  const reload = useCallback(() => {
    if (!enabled) return Promise.resolve();
    return backend.edgeApps(iid).then(
      (h) => setHealth(h?.exists ? h : null),
      () => setHealth(null),
    );
  }, [iid, enabled]);
  useEffect(() => {
    if (!enabled) {
      setHealth(null);
      return undefined;
    }
    reload();
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [enabled, reload]);
  return [health, reload];
}

/** Health of one instance, merged with errors from its code file (Lua errors after start). */
export function instanceHealth(health, inst) {
  if (!health) return null;
  const h = health.apps?.[inst.id];
  const code = health.byLogic?.[`${inst.app_id}-${inst.version}`];
  const base = h || { state: health.running ? 'pending' : 'edge-stopped', starts: 0, crashes: 0, errors: 0, lastError: null };
  if (!code) return base;
  const newer = !base.lastError || Date.parse(code.lastError?.time) > Date.parse(base.lastError.time);
  return { ...base, errors: (base.errors || 0) + code.errors, lastError: newer ? code.lastError : base.lastError };
}

function AppLog({ iid, inst }) {
  const [lines, setLines] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    backend.edgeAppLogs(iid, inst.id, `${inst.app_id}-${inst.version}`).then(setLines, (e) => setError(errText(e)));
  }, [iid, inst.id, inst.app_id, inst.version]);
  if (error) return <div className="error-box">{error}</div>;
  return (
    <div className="log app-log">
      {lines === null && <span className="muted">Laddar…</span>}
      {lines && !lines.length && <span className="muted">Appen har inte loggat något i edge clientens senaste logg.</span>}
      {lines?.map((l, i) => (
        <div key={i} className={`log-line${l.error ? ' bad' : ''}`}>
          {l.time && <span className="log-time">{fmtTime(l.time)}</span>}
          <span>{tidy(l.text)}</span>
        </div>
      ))}
    </div>
  );
}

/** Status line, details, log and restart for one installed app. */
export function AppHealthPanel({ iid, inst, health, windowSec, canRestart, onRestarted }) {
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  if (!health) return null;
  const st = STATE[health.state] || { text: health.state, cls: 'off' };
  const period = windowSec >= 3600 ? 'senaste timmen' : `senaste ${Math.round(windowSec / 60)} min`;

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      // saving the instance unchanged gives it a new "updated" time: the edge client restarts it
      await lynx.updateInstance(iid, inst);
      setNote('Appen startas om inom några sekunder.');
      setTimeout(() => {
        setNote('');
        onRestarted?.();
      }, 12000);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const facts = [
    health.running && health.uptimeSec !== null && `kört ${duration(health.uptimeSec)}`,
    health.running && health.memoryKb !== null && megabytes(health.memoryKb),
    health.crashes > 0 && `${health.crashes} krasch${health.crashes === 1 ? '' : 'er'} ${period}`,
    !health.crashes && health.starts > 1 && `startad ${health.starts} gånger ${period}`,
  ].filter(Boolean);

  return (
    <div className="app-health">
      <div className="row gap wrap app-health-line">
        <span className={`state ${st.cls}`}>
          <span className="dot" />
          {st.text}
        </span>
        {facts.length > 0 && <span className="muted small">{facts.join(' · ')}</span>}
      </div>
      {health.lastError && (health.state !== 'running' || health.errors > 0) && (
        <p className="small app-health-error">
          <Icon name="alert" size={14} />
          <span>
            <span className="err">{tidy(health.lastError.text)}</span>
            {health.lastError.time && <span className="muted block">{fmtTime(health.lastError.time)}</span>}
          </span>
        </p>
      )}
      {health.state === 'pending' && <p className="muted small">Edge clienten har inte startat appen än. Den hämtar nya appar inom några sekunder.</p>}
      {note && <p className="small">{note}</p>}
      {error && <div className="error-box">{error}</div>}
      <div className="row gap wrap">
        <button type="button" className="btn small" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
          <Icon name="terminal" size={16} /> {showLog ? 'Dölj logg' : 'Logg'}
        </button>
        {canRestart && health.state !== 'edge-stopped' && (
          <button type="button" className="btn small" disabled={busy || !!note} onClick={restart}>
            <Icon name="refresh" size={16} /> {busy ? 'Startar om…' : 'Starta om'}
          </button>
        )}
      </div>
      {showLog && <AppLog iid={iid} inst={inst} />}
    </div>
  );
}
