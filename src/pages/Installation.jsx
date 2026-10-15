import { useApp } from '../context/AppContext.jsx';
import { config } from '../api/config.js';
import { Icon } from '../components/icons.jsx';
import InstalledApps from './InstalledApps.jsx';
import Catalog from './Catalog.jsx';
import EdgeClient from './EdgeClient.jsx';

const TABS = [
  { id: '', label: 'Installerade appar', icon: 'app' },
  { id: 'add', label: 'Lägg till app', icon: 'plus' },
  { id: 'edge', label: 'Edge client', icon: 'box' },
];

export default function Installation({ iid, tab }) {
  const { installations } = useApp();
  const inst = installations.find((i) => i.id === iid);
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
  const tabs = TABS.filter((t) => t.id !== 'edge' || config.edgeClients);
  const current = tabs.some((t) => t.id === tab) ? tab : '';
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
      {current === '' && <InstalledApps installation={inst} />}
      {current === 'add' && <Catalog installation={inst} />}
      {current === 'edge' && <EdgeClient installation={inst} />}
    </div>
  );
}
