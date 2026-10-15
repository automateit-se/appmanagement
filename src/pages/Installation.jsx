import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { config } from '../api/config.js';
import { backend } from '../api/backend.js';
import { onDefaultServer } from '../api/server.js';
import { Icon } from '../components/icons.jsx';
import InstalledApps from './InstalledApps.jsx';
import Catalog from './Catalog.jsx';
import EdgeClient from './EdgeClient.jsx';

const TABS = [
  { id: '', label: 'Installerade appar', icon: 'app' },
  { id: 'add', label: 'Lägg till app', icon: 'plus' },
  { id: 'edge', label: 'Edge client', icon: 'box' },
];

/**
 * What the user may do here, from the user's role in IoT Open (read by the backend). On another IoT Open server
 * than the backend's own it is unknown: apps are offered (IoT Open itself refuses what is not allowed) and edge
 * clients are not.
 */
function useAccess(iid) {
  // undefined while loading, null when unknown
  const [access, setAccess] = useState(() => (onDefaultServer() ? undefined : null));
  useEffect(() => {
    if (!onDefaultServer()) return;
    let alive = true;
    setAccess(undefined);
    backend.access(iid).then(
      (a) => alive && setAccess(a),
      () => alive && setAccess(null),
    );
    return () => {
      alive = false;
    };
  }, [iid]);
  return access;
}

export default function Installation({ iid, tab }) {
  const { installations } = useApp();
  const inst = installations.find((i) => i.id === iid);
  const access = useAccess(iid);
  if (!inst) {
    return (
      <div className="page">
        <a className="back" href="#/">
          <Icon name="back" size={16} /> Installationer
        </a>
        <div className="error-box">Installationen finns inte eller så saknar ditt konto åtkomst till den.</div>
      </div>
    );
  }
  const tabs = TABS.filter((t) => t.id !== 'edge' || (config.edgeClients && (access?.viewEdge || access?.manageEdge)));
  // the edge tab appears once the access is known; a link straight to it is kept meanwhile
  const current = tabs.some((t) => t.id === tab) || (tab === 'edge' && access === undefined) ? tab : '';
  return (
    <div className="page">
      <a className="back" href="#/">
        <Icon name="back" size={16} /> Installationer
      </a>
      <div className="page-head">
        <div>
          <h1>{inst.name || `Installation ${inst.id}`}</h1>
          <p className="muted small lead">
            id {inst.id} · client_id {inst.client_id}
          </p>
        </div>
      </div>
      <nav className="page-tabs" aria-label="Avsnitt">
        <div className="page-tab-list">
          {tabs.map((t) => (
            <a key={t.id} href={`#/i/${iid}${t.id ? `/${t.id}` : ''}`} className={`page-tab${current === t.id ? ' on' : ''}`} aria-current={current === t.id ? 'page' : undefined}>
              <Icon name={t.icon} size={16} /> {t.label}
            </a>
          ))}
        </div>
      </nav>
      {access?.role && !access.installApps && !access.updateApps && (
        <div className="info-box small">Din roll i IoT Open ({access.role}) kan se installationens appar men inte ändra dem.</div>
      )}
      {current === '' && <InstalledApps installation={inst} access={access || null} />}
      {current === 'add' && <Catalog installation={inst} access={access || null} />}
      {current === 'edge' && (access === undefined ? <p className="muted">Laddar…</p> : <EdgeClient installation={inst} access={access} />)}
    </div>
  );
}
