import { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { Icon } from '../components/icons.jsx';

export default function Installations() {
  const { installations } = useApp();
  const [q, setQ] = useState('');

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
          </a>
        ))}
      </div>
    </div>
  );
}
