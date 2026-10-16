import { useEffect, useRef, useState } from 'react';
import { backend } from '../api/backend.js';
import { Icon } from './icons.jsx';
import { errText } from './Modal.jsx';
import { getAppTopics } from '../lib/appTopics.js';

// Messages on MQTT topic patterns: IoT Open's history plus new ones live. Apps publish in any format, so the
// text shown is msg, else value, and the whole message is a click away.

const MAX = 1000;
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE') : '');

export function messageText(m) {
  if (m.msg) return m.msg;
  if (m.value === null || m.value === undefined) return '';
  return typeof m.value === 'object' ? JSON.stringify(m.value) : String(m.value);
}

const LIVE_STATE = {
  connecting: { text: 'Ansluter…', cls: 'off' },
  live: { text: 'Live', cls: 'ok' },
  reconnecting: { text: 'Ansluter igen…', cls: 'warn' },
  stopped: { text: 'Stoppad', cls: 'off' },
};

/**
 * patterns: topic patterns (obj/…, evt/…); compact: smaller, for an app card.
 */
export function MqttLog({ iid, patterns, compact = false }) {
  const [hours, setHours] = useState(24);
  const [history, setHistory] = useState(null);
  const [live, setLive] = useState([]);
  const [liveOn, setLiveOn] = useState(true);
  const [liveState, setLiveState] = useState('connecting');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(null);
  const box = useRef(null);
  const stick = useRef(true);
  const key = patterns.join(',');
  const several = patterns.length > 1 || patterns.some((p) => /(^|\/)[+#](\/|$)/.test(p));
  const onlyEvt = patterns.every((p) => p.startsWith('evt/'));

  useEffect(() => {
    let alive = true;
    setHistory(null);
    setError('');
    backend.mqttHistory(iid, patterns, hours).then(
      (h) => alive && setHistory(h),
      (e) => alive && (setHistory({ messages: [] }), setError(errText(e))),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iid, key, hours]);

  useEffect(() => {
    if (!liveOn) {
      setLiveState('stopped');
      return undefined;
    }
    const ac = new AbortController();
    setLiveState('connecting');
    setNote('');
    backend
      .mqttLive(
        iid,
        patterns,
        (type, data) => {
          if (type === 'state') setLiveState(data.state);
          else if (type === 'message') setLive((l) => [...l, data].slice(-MAX));
          else if (type === 'dropped') setNote(`${data.count} meddelanden hoppades över (fler än 50 per sekund).`);
          else if (type === 'end') {
            setLiveState('stopped');
            setNote(data.message);
            setLiveOn(false);
          }
        },
        ac.signal,
      )
      .then(
        () => !ac.signal.aborted && (setLiveState('stopped'), setLiveOn(false)),
        (e) => {
          if (ac.signal.aborted) return;
          setLiveState('stopped');
          setLiveOn(false);
          setError(errText(e));
        },
      );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iid, key, liveOn]);

  useEffect(() => setLive([]), [key]);

  // history, then live; a retained message that is already in the history is not repeated
  const lastHist = history?.messages?.at(-1)?.time || 0;
  const all = [...(history?.messages || []), ...live.filter((m) => !(m.retained && m.time <= lastHist))];
  const q = filter.trim().toLowerCase();
  const shown = (q ? all.filter((m) => `${m.topic} ${messageText(m)}`.toLowerCase().includes(q)) : all).slice(-MAX);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const st = LIVE_STATE[liveState] || LIVE_STATE.stopped;
  return (
    <section className={`mqtt-log${compact ? ' compact' : ''}`}>
      <div className="row gap wrap mqtt-log-bar">
        <span className={`state ${st.cls}`}>
          <span className="dot" />
          {st.text}
        </span>
        <button type="button" className="btn small" onClick={() => setLiveOn((v) => !v)}>
          <Icon name={liveOn ? 'stop' : 'play'} size={14} /> {liveOn ? 'Pausa live' : 'Lyssna live'}
        </button>
        <label className="row gap small">
          Historik
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Historik">
            <option value={1}>1 timme</option>
            <option value={6}>6 timmar</option>
            <option value={24}>1 dygn</option>
            <option value={168}>7 dygn</option>
          </select>
        </label>
        <input className="grow mqtt-filter" type="search" placeholder="Filtrera" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrera meddelanden" />
      </div>
      {error && <div className="error-box">{error}</div>}
      {note && <p className="muted small">{note}</p>}
      {history?.truncated && <p className="muted small">IoT Open lämnar högst 10 000 meddelanden per hämtning. De äldsta i perioden saknas; välj en kortare period eller exakta topics.</p>}
      <div
        className="log mqtt-lines"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {history === null && <span className="muted">Hämtar historik…</span>}
        {history && !shown.length && (
          <span className="muted">
            {q ? 'Inga meddelanden matchar filtret.' : onlyEvt ? 'Inga meddelanden ännu. Nya visas här när de kommer.' : 'Inga meddelanden i perioden. Nya visas här när de kommer.'}
          </span>
        )}
        {shown.map((m, i) => (
          <div key={`${m.time}-${i}`} className={`log-line mqtt-line${m.history ? '' : ' fresh'}`}>
            <button type="button" className="mqtt-line-btn" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span className="log-time">{fmt(m.time)}</span>
              <span className={`kind ${m.kind}`}>{m.kind}</span>
              {several && <span className="mqtt-topic">{m.topic.replace(/^(obj|evt)\//, '')}</span>}
              <span className="mqtt-text">{messageText(m) || <span className="muted">(tomt)</span>}</span>
            </button>
            {open === i && <pre className="mqtt-raw">{JSON.stringify({ topic: m.topic, value: m.value, msg: m.msg, time: new Date(m.time).toISOString() }, null, 2)}</pre>}
          </div>
        ))}
      </div>
    </section>
  );
}

/** On an app card: the MQTT topics kept as the app's log in this browser, or a way to pick them. */
export function AppMqtt({ iid, inst }) {
  const [topics] = useState(() => getAppTopics(iid, inst.id));
  const [open, setOpen] = useState(false);
  const pick = `#/i/${iid}/mqtt?app=${inst.id}`;
  if (!topics.length) {
    return (
      <a className="link-btn small app-mqtt-pick" href={pick}>
        <Icon name="activity" size={14} /> Välj MQTT-topics som logg
      </a>
    );
  }
  return (
    <div className="app-mqtt">
      <div className="row gap wrap">
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name="activity" size={16} /> {open ? 'Dölj MQTT-logg' : 'MQTT-logg'}
        </button>
        <a className="link-btn small" href={pick}>
          Ändra topics
        </a>
      </div>
      {open && <MqttLog iid={iid} patterns={topics} compact />}
    </div>
  );
}
