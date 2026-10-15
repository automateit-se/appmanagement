import { useEffect, useMemo, useState } from 'react';
import { lynx } from '../api/lynx.js';
import { formLayout, inputKind, isToggleOn, matchesFilter, toggleOff, toggleOn } from '../lib/configForm.js';

// Settings form generated from an edge app's app.json (see lib/configForm.js).

const nameOf = (x) => x?.meta?.name || `#${x?.id}`;

function usePickables(iid, layout) {
  const kinds = useMemo(() => new Set(Object.values(layout.inputs).map(inputKind)), [layout]);
  const needFunctions = kinds.has('function') || kinds.has('functions');
  const needDevices = kinds.has('device') || kinds.has('devices');
  const [data, setData] = useState({ functions: [], devices: [], error: '' });
  useEffect(() => {
    let alive = true;
    Promise.all([needFunctions ? lynx.functions(iid) : [], needDevices ? lynx.devices(iid) : []])
      .then(([functions, devices]) => alive && setData({ functions: functions || [], devices: devices || [], error: '' }))
      .catch((e) => alive && setData({ functions: [], devices: [], error: e.message }));
    return () => {
      alive = false;
    };
  }, [iid, needFunctions, needDevices]);
  return data;
}

function MultiPick({ items, value, onChange }) {
  const sel = new Set((Array.isArray(value) ? value : []).map(Number));
  if (!items.length) return <p className="muted small">Inget att välja i installationen.</p>;
  return (
    <ul className="check-list">
      {items.map((it) => (
        <li key={it.id}>
          <label className="check">
            <input
              type="checkbox"
              checked={sel.has(it.id)}
              onChange={(e) => {
                const next = new Set(sel);
                if (e.target.checked) next.add(it.id);
                else next.delete(it.id);
                onChange([...next]);
              }}
            />
            <span>
              {nameOf(it)} <span className="muted small">#{it.id}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function JsonInput({ value, onChange }) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
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

function Input({ name, input, value, onChange, pick }) {
  const kind = inputKind(input);
  const id = `cfg-${name}`;
  if (kind === 'toggle') {
    return (
      <label className="check">
        <input id={id} type="checkbox" checked={isToggleOn(input, value)} onChange={(e) => onChange(e.target.checked ? toggleOn(input) : toggleOff(input))} /> På
      </label>
    );
  }
  if (kind === 'number') {
    return <input id={id} type="number" value={value ?? ''} min={input.min} max={input.max} step="any" onChange={(e) => onChange(e.target.value)} />;
  }
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
  if (kind === 'function' || kind === 'device') {
    const items = (kind === 'function' ? pick.functions : pick.devices).filter((x) => matchesFilter(x, input.filter));
    return (
      <select id={id} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}>
        <option value="">Välj {kind === 'function' ? 'funktion' : 'enhet'}…</option>
        {items.map((it) => (
          <option key={it.id} value={it.id}>
            {nameOf(it)} (#{it.id})
          </option>
        ))}
      </select>
    );
  }
  if (kind === 'functions' || kind === 'devices') {
    const items = (kind === 'functions' ? pick.functions : pick.devices).filter((x) => matchesFilter(x, input.filter));
    return <MultiPick items={items} value={value} onChange={onChange} />;
  }
  if (kind === 'json') return <JsonInput value={value} onChange={onChange} />;
  return <input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

export function ConfigForm({ iid, options, values, onChange, errors = {} }) {
  const layout = useMemo(() => formLayout(options), [options]);
  const pick = usePickables(iid, layout);
  const set = (name) => (v) => onChange({ ...values, [name]: v });

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
          {page.fields.map((name) => {
            const input = layout.inputs[name];
            return (
              <div className="field" key={name}>
                <label htmlFor={`cfg-${name}`}>
                  {input.name || name}
                  {input.required && <span className="req"> *</span>}
                </label>
                <Input name={name} input={input} value={values[name]} onChange={set(name)} pick={pick} />
                {errors[name] ? <small className="err">{errors[name]}</small> : input.description ? <small className="muted">{input.description}</small> : null}
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
