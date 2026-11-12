// The settings form of an edge app comes from its app.json: "input" describes every setting and "guide" groups
// them into pages. The values are saved as the instance's "config" in IoT Open, keyed by input name.
// Types and config shapes follow IoT Open's documentation of app.json:
//   text (multiline, validator, on_error), number, option, checkbox, toggle (true_value / false_value),
//   single/multi_function_selector and single/multi_device_selector (filter, value),
//   single/multi_notification_output_selector, repeat (input_fields, min, max).
// Anything else is edited as JSON, so no app is blocked by a type this form does not know.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const EMPTY = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

/** text | number | toggle | option | checkbox | function(s) | device(s) | notification(s) | repeat | json */
export function inputKind(input) {
  const t = String(input?.type || 'text').toLowerCase();
  if (t === 'text' || t === 'string' || t === 'password') return 'text';
  if (t === 'number' || t === 'integer' || t === 'float') return 'number';
  if (t === 'toggle' || t === 'boolean') return 'toggle';
  if (t === 'option' || t === 'select' || t === 'single_select') return 'option';
  if (t === 'checkbox' || t === 'multi_select') return 'checkbox';
  if (t === 'repeat') return 'repeat';
  const multi = /^multi|multiple/.test(t);
  if (t.includes('notification')) return multi ? 'notifications' : 'notification';
  if (t.includes('function')) return multi ? 'functions' : 'function';
  if (t.includes('device')) return multi ? 'devices' : 'device';
  return 'json';
}

/** Selector whose config carries a value per selected id ({ "<id>": value }) instead of just ids. */
export const withValue = (input) => input?.value === true && ['function', 'functions', 'device', 'devices'].includes(inputKind(input));

/** Inputs that are only used inside a repeat (they are not pages of their own). */
function repeatChildren(inputs) {
  const out = new Set();
  for (const input of Object.values(inputs)) {
    if (inputKind(input) === 'repeat' && Array.isArray(input.input_fields)) input.input_fields.forEach((n) => out.add(n));
  }
  return out;
}

/** { pages: [{ id, title, description, fields: [name] }], inputs } - inputs missing from the guide get a last page. */
export function formLayout(options) {
  const inputs = isObj(options?.input) ? options.input : {};
  const guide = Array.isArray(options?.guide) ? options.guide : [];
  const seen = new Set();
  const pages = guide
    .map((g, i) => ({
      id: String(g.id || `page_${i}`),
      title: g.title || '',
      description: g.description || '',
      fields: (Array.isArray(g.input_fields) ? g.input_fields : []).filter((n) => inputs[n] && !seen.has(n) && seen.add(n)),
    }))
    .filter((p) => p.fields.length || p.description);
  const children = repeatChildren(inputs);
  const rest = Object.keys(inputs).filter((n) => !seen.has(n) && !children.has(n));
  if (rest.length) pages.push({ id: 'other', title: pages.length ? 'Övrigt' : '', description: '', fields: rest });
  return { pages, inputs };
}

/** Names shown at the top level of the form (on a page), in page order. */
const topLevel = (options) => formLayout(options).pages.flatMap((p) => p.fields);

export const toggleOn = (input) => (input.true_value !== undefined ? input.true_value : true);
export const toggleOff = (input) => (input.false_value !== undefined ? input.false_value : false);
export const isToggleOn = (input, v) => v === toggleOn(input) || (input.true_value === undefined && v === true);

/** Default value of one input (undefined = nothing). */
export function defaultFor(input, inputs) {
  const kind = inputKind(input);
  if (kind === 'toggle') {
    const d = input.default;
    return d === true || d === 'true' || (d !== undefined && d === input.true_value) ? toggleOn(input) : toggleOff(input);
  }
  if (kind === 'checkbox') return input.default === undefined ? [] : Array.isArray(input.default) ? input.default : [input.default];
  if (kind === 'repeat') {
    const n = Math.max(0, Number(input.min) || 0);
    return Array.from({ length: n }, () => repeatItem(input, inputs));
  }
  if (input.default !== undefined) return input.default;
  if (kind === 'functions' || kind === 'devices' || kind === 'notifications') return withValue(input) ? {} : [];
  return undefined;
}

/** A new, empty entry of a repeat input. */
export function repeatItem(input, inputs) {
  const item = {};
  for (const n of input.input_fields || []) {
    const sub = inputs[n];
    if (!sub) continue;
    const d = defaultFor(sub, inputs);
    if (d !== undefined) item[n] = d;
  }
  return item;
}

/** Values for the form: existing config first, then each input's default. */
export function initialValues(options, current = {}) {
  const { inputs } = formLayout(options);
  const out = { ...(current || {}) };
  for (const name of topLevel(options)) {
    if (out[name] !== undefined) continue;
    const d = defaultFor(inputs[name], inputs);
    if (d !== undefined) out[name] = d;
  }
  return out;
}

function regex(src) {
  if (src instanceof RegExp) return src;
  if (typeof src !== 'string' || !src) return null;
  try {
    // anchored like a form validator: "[a-zA-Z]*" has to match the whole text
    return new RegExp(`^(?:${src})$`);
  } catch {
    return null;
  }
}

/** Error message for one value, or null. Repeat entries are checked too ("name.0.field" keys). */
function check(input, v, inputs, key, errors) {
  const kind = inputKind(input);
  if (EMPTY(v)) {
    if (input.required && kind !== 'toggle') errors[key] = 'Måste fyllas i';
    else if (kind === 'repeat' && Number(input.min) > 0) errors[key] = `Minst ${input.min}`;
    return;
  }
  if (kind === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) errors[key] = 'Ange ett tal';
    else if (input.min !== undefined && n < Number(input.min)) errors[key] = `Minst ${input.min}`;
    else if (input.max !== undefined && n > Number(input.max)) errors[key] = `Högst ${input.max}`;
  } else if (kind === 'text') {
    const re = regex(input.validator);
    if (re && !re.test(String(v))) errors[key] = input.on_error || 'Ogiltigt värde';
  } else if (kind === 'option') {
    const keys = Object.keys(input.values || {});
    if (keys.length && !keys.includes(String(v))) errors[key] = 'Välj ett av alternativen';
  } else if (kind === 'checkbox') {
    const keys = Object.keys(input.values || {});
    if (!Array.isArray(v)) errors[key] = 'Ogiltigt värde';
    else if (keys.length && v.some((x) => !keys.includes(String(x)))) errors[key] = 'Välj bland alternativen';
  } else if (kind === 'repeat') {
    if (!Array.isArray(v)) return void (errors[key] = 'Ogiltigt värde');
    if (input.min !== undefined && v.length < Number(input.min)) errors[key] = `Minst ${input.min}`;
    else if (input.max !== undefined && v.length > Number(input.max)) errors[key] = `Högst ${input.max}`;
    v.forEach((item, i) => {
      for (const n of input.input_fields || []) if (inputs[n]) check(inputs[n], item?.[n], inputs, `${key}.${i}.${n}`, errors);
    });
  } else if (withValue(input)) {
    if (!isObj(v)) errors[key] = 'Ogiltigt värde';
    else if (Object.values(v).some((x) => x === '' || x === undefined || x === null)) errors[key] = 'Ange ett värde för varje vald';
  }
}

/** { name: message } for every value that IoT Open (or the app) would not accept. Empty object = valid. */
export function validate(options, values) {
  const { inputs } = formLayout(options);
  const errors = {};
  for (const name of topLevel(options)) check(inputs[name], values?.[name], inputs, name, errors);
  return errors;
}

/** "12" -> 12, other text unchanged: values typed in a form are text. */
export const numeric = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v);

function cleanOne(input, v, inputs) {
  const kind = inputKind(input);
  if (v === undefined) return undefined;
  if (kind === 'number') return v === '' || v === null ? undefined : Number.isFinite(Number(v)) ? Number(v) : v;
  if (kind === 'text') return v === '' && !input.required ? undefined : v;
  if (kind === 'option') {
    const key = Object.keys(input.values || {}).find((k) => k === String(v));
    // app.json keys are strings; keep a number when the default is a number
    return key !== undefined && typeof input.default === 'number' ? numeric(key) : (key ?? v);
  }
  if (kind === 'checkbox' && Array.isArray(v)) return v.map((x) => (typeof input.default === 'number' || (Array.isArray(input.default) && typeof input.default[0] === 'number') ? numeric(x) : x));
  if (kind === 'repeat' && Array.isArray(v)) {
    return v.map((item) => {
      const out = {};
      for (const n of input.input_fields || []) {
        if (!inputs[n]) continue;
        const c = cleanOne(inputs[n], item?.[n], inputs);
        if (c !== undefined) out[n] = c;
      }
      return out;
    });
  }
  if (withValue(input) && isObj(v)) return Object.fromEntries(Object.entries(v).map(([id, x]) => [id, numeric(x)]));
  return v;
}

/** Values as IoT Open should store them (numbers as numbers, option keys as in app.json, no empty texts). */
export function cleanValues(options, values) {
  const { inputs } = formLayout(options);
  const out = { ...values };
  for (const name of topLevel(options)) {
    const c = cleanOne(inputs[name], out[name], inputs);
    if (c === undefined) delete out[name];
    else out[name] = c;
  }
  return out;
}

/** Does a device or function match the input's "filter" (type and/or metadata)? */
export function matchesFilter(item, filter) {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([k, want]) => {
    const have = k === 'type' ? item.type : (item.meta?.[k] ?? item[k]);
    if (want === '*' || want === '') return have !== undefined && have !== '';
    if (Array.isArray(want)) return want.map(String).includes(String(have));
    return String(have) === String(want);
  });
}

// ---- what an update changes in the settings ---------------------------------------------------------------------

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const LIMITS = ['min', 'max'];

/** Readable value of a setting: option texts, on/off, lists, numbers and text. */
export function describeValue(input, v) {
  if (v === undefined || v === null || v === '') return '(tomt)';
  const kind = inputKind(input || {});
  if (String(input?.type).toLowerCase() === 'password') return '••••';
  if (kind === 'toggle') return isToggleOn(input, v) ? 'På' : 'Av';
  if (kind === 'option') return String(input.values?.[String(v)] ?? v);
  if (kind === 'checkbox' && Array.isArray(v)) return v.map((x) => input.values?.[String(x)] ?? x).join(', ') || '(inget valt)';
  if (kind === 'repeat' && Array.isArray(v)) return `${v.length} st`;
  if (['functions', 'devices', 'notifications'].includes(kind)) return `${Array.isArray(v) ? v.length : Object.keys(v || {}).length} valda`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * What an update from one version's settings (oldOptions, null when unknown) to another's (newOptions) means for an
 * instance's config:
 *   added:   settings the new version has and the old did not, with the value they will get (their default)
 *   removed: settings the old version had and the new does not, with the value they have now; they are dropped on
 *            update. Without the old version's settings, config keys the new version does not know are listed as
 *            unknown instead, and kept (an app may read a key its form does not show).
 *   changed: settings in both whose type, default, limits, choices or required flag changed, and settings whose
 *            current value the new version does not accept
 *   unchanged: the number of settings that stay as they are
 */
export function settingsDiff(oldOptions, newOptions, config = {}) {
  const now = formLayout(newOptions).inputs;
  const before = oldOptions ? formLayout(oldOptions).inputs : null;
  const newTop = topLevel(newOptions);
  const oldTop = oldOptions ? topLevel(oldOptions) : null;
  const cfg = config || {};
  const label = (name, input) => input?.name || name;
  const errors = validate(newOptions, initialValues(newOptions, cfg));

  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const name of newTop) {
    const input = now[name];
    const had = oldTop ? oldTop.includes(name) : cfg[name] !== undefined;
    if (!had) {
      added.push({ name, label: label(name, input), value: describeValue(input, defaultFor(input, now)), required: !!input.required && defaultFor(input, now) === undefined });
      continue;
    }
    const was = before?.[name];
    const notes = [];
    if (was) {
      if (inputKind(was) !== inputKind(input)) notes.push(`typ: ${was.type} → ${input.type}`);
      if (!same(was.default, input.default)) notes.push(`standardvärde: ${describeValue(was, was.default)} → ${describeValue(input, input.default)}`);
      for (const k of LIMITS) if (!same(was[k], input[k])) notes.push(`${k === 'min' ? 'minsta' : 'största'} värde: ${was[k] ?? '–'} → ${input[k] ?? '–'}`);
      if (!same(Object.keys(was.values || {}), Object.keys(input.values || {}))) {
        const gone = Object.keys(was.values || {}).filter((k) => !(k in (input.values || {})));
        const fresh = Object.keys(input.values || {}).filter((k) => !(k in (was.values || {})));
        if (fresh.length) notes.push(`nya val: ${fresh.map((k) => input.values[k]).join(', ')}`);
        if (gone.length) notes.push(`borttagna val: ${gone.map((k) => was.values[k]).join(', ')}`);
      }
      if (!was.required && input.required) notes.push('måste nu fyllas i');
    }
    const problem = errors[name] || (Object.keys(errors).some((k) => k.startsWith(`${name}.`)) ? 'Ett värde i listan godtas inte' : null);
    if (notes.length || problem) changed.push({ name, label: label(name, input), value: describeValue(input, cfg[name] ?? defaultFor(input, now)), notes, problem });
    else unchanged++;
  }

  const known = new Set([...newTop, ...Object.keys(now)]);
  const leftover = Object.keys(cfg).filter((k) => !known.has(k));
  const removed = oldTop ? leftover.filter((k) => oldTop.includes(k) || (before && before[k])).map((name) => ({ name, label: label(name, before[name]), value: describeValue(before[name], cfg[name]) })) : [];
  const gone = new Set(removed.map((r) => r.name));
  const unknown = leftover.filter((k) => !gone.has(k)).map((name) => ({ name, label: name, value: describeValue(null, cfg[name]) }));
  return { added, removed, changed, unknown, unchanged, any: added.length + removed.length + changed.length + unknown.length > 0 };
}

/** The config an update saves: the form's values without the settings the new version no longer has. */
export function withoutRemoved(values, diff) {
  const out = { ...(values || {}) };
  for (const r of diff?.removed || []) delete out[r.name];
  return out;
}

/**
 * A name for a new instance that no instance on the installation has: the wanted name itself when free, else the
 * same with the lowest free number ("Väderdata 2", "Väderdata 3", …). Case and spaces at the ends do not count.
 */
export function uniqueName(wanted, taken = []) {
  const base = String(wanted || '').trim() || 'App';
  const used = new Set((taken || []).map((n) => String(n || '').trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  // "Väderdata 3" copied again counts on from "Väderdata", not "Väderdata 3 2"
  const stem = base.replace(/\s+\d+$/, '') || base;
  for (let n = 2; ; n++) if (!used.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
}
