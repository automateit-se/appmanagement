import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { backend } from '../api/backend.js';
import { onDefaultServer } from '../api/server.js';
import { Icon } from '../components/icons.jsx';
import { PresenceBadge } from '../components/EdgePresence.jsx';

/** Edge status of the installations in IoT Open, read by the backend in one go; refreshed every minute. */
function usePresenceMany(installations) {
  const [map, setMap] = useState({});
  const key = installations.map((i) => i.id).slice(0, 200).join(',');
  useEffect(() => {
    if (!key || !onDefaultServer()) return undefined;
    let alive = true;
    const load = () => backend.presenceMany(key.split(',')).then((m) => alive && setMap(m || {}), () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return map;
}

export default function Installations() {
  const { installations } = useApp();
  const [q, setQ] = useState('');
  const presence = usePresenceMany(installations);

  const needle = q.trim().toLowerCase();
  const shown = installations.filter((i) => !needle || i.name.toLowerCase().includes(needle) || String(i.id).includes(needle));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Installationer</h1>
          <p className="muted small lead">Välj en installation för att se, installera och uppdatera dess edge apps.</p>
        </div>
        {installations.length > 6 && <input className="search" placeholder="Sök…" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {!installations.length && <p className="muted">Ditt konto har inga installationer i IoT Open.</p>}
      <div className="inst-list">
        {shown.map((i) => (
          <a key={i.id} className="inst" href={`#/i/${i.id}`}>
            <Icon name="home" />
            <span>
              <strong>{i.name || `Installation ${i.id}`}</strong>
              <span className="muted small">
                id {i.id} · client_id {i.client_id}
              </span>
            </span>
            {/* only installations that have an edge client: online or offline in IoT Open */}
            {['online', 'offline'].includes(presence[i.id]?.state) && (
              <span className="inst-edge" title="Edge client i IoT Open">
                <PresenceBadge p={presence[i.id]} />
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
