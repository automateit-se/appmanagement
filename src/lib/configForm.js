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
