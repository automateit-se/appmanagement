import { useEffect, useMemo, useState } from 'react';
import { backend } from '../api/backend.js';
import { lynx } from '../api/lynx.js';
import { Icon } from '../components/icons.jsx';
import { errText } from '../components/Modal.jsx';
import { MqttLog, messageText } from '../components/MqttLog.jsx';
import { getAppTopics, setAppTopics, topicMatches, validPattern } from '../lib/appTopics.js';

// What the installation's apps publish on MQTT. Apps choose their own topics, so the user finds them here (topics
// with messages lately), picks some or writes patterns with + and #, looks at the messages and can keep the
// choice as an app's log, shown on the app's card.

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE') : '');
const appFromHash = () => Number(new URLSearchParams(window.location.hash.split('?')[1] || '').get('app')) || null;

export default function Mqtt({ installation }) {
  const iid = installation.id;
  const [hours, setHours] = useState(1);
  const [found, setFound] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState([]);
  const [custom, setCustom] = useState('');
  const [shown, setShown] = useState(null);
  const [instances, setInstances] = useState([]);
  const [app, setApp] = useState(appFromHash);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let alive = true;
    setFound(null);
    setError('');
    backend.mqttTopics(iid, hours).then(
      (r) => alive && setFound(r),
      (e) => alive && (setFound({ topics: [] }), setError(errText(e))),
    );
    return () => {
      alive = false;
    };
  }, [iid, hours]);

  useEffect(() => {
    lynx.instances(iid).then((l) => setInstances(l || []), () => setInstances([]));
  }, [iid]);

  // opened from an app card: start with what is kept for that app
  useEffect(() => {
    if (!app) return;
    const t = getAppTopics(iid, app);
    if (t.length) {
      setPicked(t);
      setShown(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = filter.trim().toLowerCase();
  const list = useMemo(() => (found?.topics || []).filter((t) => !q || `${t.topic} ${t.last ? messageText(t.last) : ''}`.toLowerCase().includes(q)), [found, q]);
  const toggle = (t) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const customOk = !custom.trim() || validPattern(custom.trim());
  const addCustom = () => {
    const p = custom.trim().replace(/^\/+/, '');
    if (!p || !validPattern(p)) return;
    setPicked((x) => (x.includes(p) ? x : [...x, p]));
    setCustom('');
  };
  const covered = (topic) => picked.some((p) => p !== topic && topicMatches(p, topic));
  const appName = (id) => instances.find((i) => i.id === id)?.name || `App ${id}`;

  const save = () => {
    if (!app) return;
    setAppTopics(iid, app, picked);
    setSaved(picked.length ? `Sparat som MQTT-logg för ${appName(app)} i den här webbläsaren.` : `MQTT-loggen för ${appName(app)} är borttagen.`);
  };

  return (
    <>
      <p className="muted small lead-text">
        Det apparna publicerar på <code>obj/…</code> och <code>evt/…</code>, var installationens edge client än körs. Välj topics i listan eller skriv ett mönster
        med <code>+</code> (en nivå) och <code>#</code> (resten), till exempel <code>obj/doorcounter/#</code>.
      </p>
      {error && <div className="error-box">{error}</div>}

      <section className="panel">
        <div className="row gap wrap">
          <h2 className="grow">Topics med meddelanden</h2>
          <label className="row gap small">
            Senaste
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Period">
              <option value={1}>timmen</option>
              <option value={6}>6 timmarna</option>
              <option value={24}>dygnet</option>
            </select>
          </label>
          <input type="search" placeholder="Sök topic eller innehåll" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Sök topics" />
        </div>
        {found === null && <p className="muted">Letar efter topics…</p>}
        {found && !found.topics.length && !error && <p className="muted">Inga obj- eller evt-meddelanden på installationen under perioden.</p>}
        {found?.truncated && <p className="muted small">Installationen har mycket trafik: listan bygger på de senaste 10 000 meddelandena.</p>}
        {list.length > 0 && (
          <div className="topic-list" role="list">
            {list.slice(0, 500).map((t) => (
              <label key={t.topic} className={`topic-row${picked.includes(t.topic) ? ' on' : ''}`} role="listitem">
                <input type="checkbox" checked={picked.includes(t.topic) || covered(t.topic)} disabled={covered(t.topic)} onChange={() => toggle(t.topic)} />
                <span className={`kind ${t.kind}`}>{t.kind}</span>
                <span className="topic-name">{t.topic.replace(/^(obj|evt)\//, '')}</span>
                <span className="muted small topic-last" title={t.last ? fmt(t.last.time) : ''}>
                  {t.count ? `${t.count} st` : 'senaste värde'}
                  {t.last ? ` · ${messageText(t.last).slice(0, 60)}` : ''}
                </span>
              </label>
            ))}
            {list.length > 500 && <p className="muted small">{list.length - 500} till; sök för att hitta dem.</p>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Valda topics</h2>
        <div className="row gap wrap">
          <input
            className="grow"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
            placeholder="obj/minapp/+/log"
            aria-label="Topic eller mönster"
            aria-invalid={!customOk}
          />
          <button type="button" className="btn" disabled={!custom.trim() || !customOk} onClick={addCustom}>
            <Icon name="plus" size={16} /> Lägg till
          </button>
        </div>
        {!customOk && <p className="err small">Börja med obj/ eller evt/. + och # får bara stå som en hel nivå, och # bara sist.</p>}
        <div className="chips">
          {picked.map((p) => (
            <span key={p} className="chip">
              {p}
              <button type="button" aria-label={`Ta bort ${p}`} onClick={() => toggle(p)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          {!picked.length && <span className="muted small">Inga valda än.</span>}
        </div>
        <div className="row gap wrap">
          <button type="button" className="btn primary" disabled={!picked.length || picked.length > 10} onClick={() => setShown([...picked])}>
            <Icon name="activity" size={16} /> Visa meddelanden
          </button>
          {picked.length > 10 && <span className="err small">Högst 10 åt gången.</span>}
          <span className="grow" />
          <label className="row gap small">
            Spara som logg för
            <select value={app || ''} onChange={(e) => (setApp(Number(e.target.value) || null), setSaved(''))} aria-label="App">
              <option value="">välj app</option>
              {instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={!app || picked.length > 10} onClick={save}>
            Spara
          </button>
        </div>
        {saved && <p className="small">{saved}</p>}
      </section>

      {shown && (
        <section className="panel">
          <h2>Meddelanden</h2>
          <MqttLog iid={iid} patterns={shown} />
        </section>
      )}
    </>
  );
}
