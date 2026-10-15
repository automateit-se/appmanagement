import { useCallback, useEffect, useState } from 'react';
import { backend } from '../api/backend.js';
import { onDefaultServer } from '../api/server.js';

// Edge status in IoT Open: is there an edge client on the installation and is it online? Read by the backend
// from the retained <client_id>/box/event/status that every edge client's MQTT bridge publishes.

/** { state: 'online' | 'offline' | 'unknown', since } or null while loading. Polls every `every` ms. */
export function usePresence(iid, every = 30000) {
  const [p, setP] = useState(null);
  const enabled = onDefaultServer();
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve();
    return backend.presence(iid).then(setP, () => setP({ state: 'unknown', reason: 'error' }));
  }, [iid, enabled]);
  useEffect(() => {
    load();
    if (!every) return;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [load, every]);
  return [enabled ? p : { state: 'unknown', reason: 'other-server' }, load, setP];
}

const fmtSince = (s) => (s ? new Date(s * 1000).toLocaleString('sv-SE') : '');

export function PresenceBadge({ p }) {
  if (!p) return <span className="state off">Kontrollerar…</span>;
  if (p.state === 'online')
    return (
      <span className="state ok" title={p.since ? `Sedan ${fmtSince(p.since)}` : undefined}>
        <span className="dot" /> Online
      </span>
    );
  if (p.state === 'offline')
    return (
      <span className="state crit" title={p.since ? `Sedan ${fmtSince(p.since)}` : undefined}>
        <span className="dot" /> Offline
      </span>
    );
  return (
    <span className="state off" title="Ingen edge client har rapporterat status för installationen, eller så gick statusen inte att läsa">
      <span className="dot" /> Okänd
    </span>
  );
}

export { fmtSince };
