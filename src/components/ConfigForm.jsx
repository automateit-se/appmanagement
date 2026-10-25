import { useEffect, useMemo, useState } from 'react';
import { lynx } from '../api/lynx.js';
import { formLayout, inputKind, isToggleOn, matchesFilter, repeatItem, toggleOff, toggleOn, withValue } from '../lib/configForm.js';
import { Icon } from './icons.jsx';

// Settings form generated from an edge app's app.json (see lib/configForm.js).

const nameOf = (x) => x?.meta?.name || x?.name || `#${x?.id}`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Functions, devices and notification outputs of the installation, loaded only when the form needs them. */
function usePickables(iid, inputs) {
  const kinds = useMemo(() => new Set(Object.values(inputs).map(inputKind)), [inputs]);
  const need = {
    functions: kinds.has('function') || kinds.has('functions'),
    devices: kinds.has('device') || kinds.has('devices'),
    outputs: kinds.has('notification') || kinds.has('notifications'),
  };
  const [data, setData] = useState({ functions: [], devices: [], outputs: [], error: '' });
  useEffect(() => {
    let alive = true;
    Promise.all([
      need.functions ? lynx.functions(iid) : [],
      need.devices ? lynx.devices(iid) : [],
      need.outputs ? lynx.notificationOutputs(iid).catch(() => []) : [],
    ])
      .then(([functions, devices, outputs]) => alive && setData({ functions: functions || [], devices: devices || [], outputs: outputs || [], error: '' }))
      .catch((e) => alive && setData({ functions: [], devices: [], outputs: [], error: e.message }));
    return () => {
      alive = false;
    };
  }, [iid, need.functions, need.devices, need.outputs]);
  return data;
}

function itemsFor(kind, input, pick) {
  if (kind.startsWith('function')) return pick.functions.filter((x) => matchesFilter(x, input.filter));
  if (kind.startsWith('device')) return pick.devices.filter((x) => matchesFilter(x, input.filter));
  return pick.outputs;
}

/** Value to set for a selected function (value: true): on/off for switches, otherwise free text or number. */
function ValueInput({ item, value, onChange, label }) {
  const onoff = /switch|onoff|on_off|relay|plug|lamp|light/i.test(String(item?.type || ''));
  if (onoff) {
    return (
      <select className="compact" aria-label={label} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}>
        <option value="">Värde…</option>
        <option value="1">På (1)</option>
        <option value="0">Av (0)</option>
      </select>
    );
  }
  return <input className="value-input" aria-label={label} placeholder="Värde" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

function SinglePick({ id, kind, input, items, value, onChange }) {
  const valued = withValue(input);
  const selected = valued ? (isObj(value) ? Object.keys(value)[0] : '') : value === undefined || value === null ? '' : String(value);
  const label = kind === 'function' ? 'funktion' : kind === 'device' ? 'enhet' : 'notifieringsutgång';
  const item = items.find((x) => String(x.id) === String(selected));
  return (
    <div className="row gap wrap">
      <select
        id={id}
        className="grow"
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onChange(valued ? {} : undefined);
          else onChange(valued ? { [v]: '' } : Number(v));
        }}
      >
        <option value="">Välj {label}…</option>
        {items.map((it) => (
          <option key={it.id} value={it.id}>
            {nameOf(it)} (#{it.id})
          </option>
        ))}
      </select>
      {valued && selected && <ValueInput item={item} label={`Värde för ${nameOf(item)}`} value={value[selected]} onChange={(v) => onChange({ [selected]: v })} />}
    </div>
  );
}

function MultiPick({ input, items, value, onChange }) {
  const valued = withValue(input);
  const sel = valued ? new Set(Object.keys(isObj(value) ? value : {}).map(String)) : new Set((Array.isArray(value) ? value : []).map(String));
  if (!items.length) return <p className="muted small">Inget att välja i installationen.</p>;
  const toggle = (id, on) => {
    if (valued) {
      const next = { ...(isObj(value) ? value : {}) };
      if (on) next[id] = next[id] ?? '';
      else delete next[id];
      onChange(next);
    } else {
      const next = new Set(sel);
      if (on) next.add(String(id));
      else next.delete(String(id));
      onChange([...next].map(Number));
    }
  };
  return (
    <ul className="check-list">
      {items.map((it) => (
        <li key={it.id} className="row gap">
          <label className="check grow">
            <input type="checkbox" checked={sel.has(String(it.id))} onChange={(e) => toggle(it.id, e.target.checked)} />
            <span>
              {nameOf(it)} <span className="muted small">#{it.id}</span>
            </span>
          </label>
          {valued && sel.has(String(it.id)) && <ValueInput item={it} label={`Värde för ${nameOf(it)}`} value={value[it.id]} onChange={(v) => onChange({ ...value, [it.id]: v })} />}
        </li>
      ))}
    </ul>
  );
}

function JsonInput({ id, value, onChange }) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        id={id}
        className="mono"
        rows={Math.min(12, Math.max(3, text.split('\n').length))}
        value={text}
        spellCheck={false}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setBad(false);
            return onChange(undefined);
          }
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <small className="err">Ogiltig JSON</small>}
    </>
  );
}

function Repeat({ name, input, inputs, value, onChange, pick, errors, path }) {
  const list = Array.isArray(value) ? value : [];
  const max = input.max === undefined ? Infinity : Number(input.max);
  const min = Number(input.min) || 0;
  const fields = (input.input_fields || []).filter((n) => inputs[n]);
  const setItem = (i, item) => onChange(list.map((x, j) => (j === i ? item : x)));
  return (
    <div className="repeat">
      {list.map((item, i) => (
        <div key={i} className="repeat-item">
          <div className="row gap repeat-head">
            <strong className="grow small">
              {input.name || name} {i + 1}
            </strong>
            <button type="button" className="icon-btn" disabled={list.length <= min} title="Ta bort" aria-label={`Ta bort ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <Icon name="trash" size={16} />
            </button>
          </div>
          {fields.map((n) => (
            <Field
              key={n}
              name={n}
              input={inputs[n]}
              inputs={inputs}
              value={item?.[n]}
              onChange={(v) => setItem(i, { ...item, [n]: v })}
              pick={pick}
              errors={errors}
              path={`${path}.${i}.${n}`}
            />
          ))}
        </div>
      ))}
      <button type="button" className="btn small-btn" disabled={list.length >= max} onClick={() => onChange([...list, repeatItem(input, inputs)])}>
        <Icon name="plus" size={14} /> Lägg till
      </button>
    </div>
  );
}

function Control({ name, input, inputs, value, onChange, pick, errors, path }) {
  const kind = inputKind(input);
  const id = `cfg-${path}`;
  if (kind === 'toggle' && (input.true_value !== undefined || input.false_value !== undefined)) {
    // the app names both positions (e.g. "under" / "over"): show them, not an on/off box
    const opts = [
      [toggleOff(input), false],
      [toggleOn(input), true],
    ];
    return (
      <div className="seg" role="radiogroup" id={id}>
        {opts.map(([v, on]) => (
          <button key={String(on)} type="button" role="radio" aria-checked={isToggleOn(input, value) === on} className={isToggleOn(input, value) === on ? 'on' : ''} onClick={() => onChange(v)}>
            {String(v)}
          </button>
        ))}
      </div>
    );
  }
  if (kind === 'toggle') {
    return (
      <label className="check">
        <input id={id} type="checkbox" checked={isToggleOn(input, value)} onChange={(e) => onChange(e.target.checked ? toggleOn(input) : toggleOff(input))} /> På
      </label>
    );
  }
  if (kind === 'number') return <input id={id} type="number" value={value ?? ''} min={input.min} max={input.max} step="any" onChange={(e) => onChange(e.target.value)} />;
  if (kind === 'option') {
    return (
      <select id={id} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">Välj…</option>
        {Object.entries(input.values || {}).map(([k, label]) => (
          <option key={k} value={k}>
            {typeof label === 'string' ? label : k}
          </option>
        ))}
      </select>
    );
  }
  if (kind === 'checkbox') {
    const sel = new Set((Array.isArray(value) ? value : []).map(String));
    return (
      <div className="check-group" id={id}>
        {Object.entries(input.values || {}).map(([k, label]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={sel.has(k)}
              onChange={(e) => {
                const next = new Set(sel);
                if (e.target.checked) next.add(k);
                else next.delete(k);
                onChange([...next]);
              }}
            />{' '}
            {typeof label === 'string' ? label : k}
          </label>
        ))}
      </div>
    );
  }
  if (kind === 'function' || kind === 'device' || kind === 'notification') {
    return <SinglePick id={id} kind={kind} input={input} items={itemsFor(kind, input, pick)} value={value} onChange={onChange} />;
  }
  if (kind === 'functions' || kind === 'devices' || kind === 'notifications') {
    return <MultiPick input={input} items={itemsFor(kind, input, pick)} value={value} onChange={onChange} />;
  }
  if (kind === 'repeat') return <Repeat name={name} input={input} inputs={inputs} value={value} onChange={onChange} pick={pick} errors={errors} path={path} />;
  if (kind === 'json') return <JsonInput id={id} value={value} onChange={onChange} />;
  if (input.multiline) return <textarea id={id} rows={4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  // type "password" (a PIN, an API key): hidden while typed and never offered by the browser's autofill
  if (String(input.type).toLowerCase() === 'password') return <input id={id} type="password" autoComplete="new-password" value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  return <input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

function Field({ name, input, inputs, value, onChange, pick, errors, path }) {
  const kind = inputKind(input);
  const error = errors[path];
  return (
    <div className="field">
      <label htmlFor={kind === 'repeat' || kind.endsWith('s') ? undefined : `cfg-${path}`}>
        {input.name || name}
        {input.required && <span className="req"> *</span>}
      </label>
      <Control name={name} input={input} inputs={inputs} value={value} onChange={onChange} pick={pick} errors={errors} path={path} />
      {error ? <small className="err">{error}</small> : input.description ? <small className="muted">{input.description}</small> : null}
    </div>
  );
}

export function ConfigForm({ iid, options, values, onChange, errors = {} }) {
  const layout = useMemo(() => formLayout(options), [options]);
  const pick = usePickables(iid, layout.inputs);

  if (!layout.pages.length) return <p className="muted">Appen har inga inställningar.</p>;
  return (
    <div className="config-form">
      {pick.error && <div className="warn-box">Kunde inte läsa enheter och funktioner: {pick.error}</div>}
      {layout.pages.map((page, i) => (
        <fieldset key={page.id} className="cfg-page">
          {(page.title || layout.pages.length > 1) && (
            <legend>
              {layout.pages.length > 1 && <span className="step">{i + 1}</span>}
              {page.title || `Steg ${i + 1}`}
            </legend>
          )}
          {page.description && <p className="muted small">{page.description}</p>}
          {page.fields.map((name) => (
            <Field
              key={name}
              name={name}
              input={layout.inputs[name]}
              inputs={layout.inputs}
              value={values[name]}
              onChange={(v) => onChange({ ...values, [name]: v })}
              pick={pick}
              errors={errors}
              path={name}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
