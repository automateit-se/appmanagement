// The settings form of an edge app comes from its app.json: "input" describes every setting and "guide" groups
// them into steps. The values are saved as the instance's "config" in IoT Open, keyed by input name.
// Input types follow IoT Open's documentation (text, number, option, toggle, function/device selectors);
// anything else is edited as JSON so no app is blocked by a type this form does not know.

const EMPTY = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** text | number | toggle | option | function | functions | device | devices | json */
export function inputKind(input) {
  const t = String(input?.type || 'text').toLowerCase();
  if (t === 'text' || t === 'string' || t === 'password') return 'text';
  if (t === 'number' || t === 'integer' || t === 'float') return 'number';
  if (t === 'toggle' || t === 'boolean' || t === 'checkbox') return 'toggle';
  if (t === 'option' || t === 'select' || t === 'single_select') return 'option';
  const multi = /multi|multiple|list/.test(t);
  if (t.includes('function')) return multi ? 'functions' : 'function';
  if (t.includes('device')) return multi ? 'devices' : 'device';
  return 'json';
}

/** { pages: [{ id, title, description, fields: [name] }], inputs } - inputs missing from the guide get a last page. */
export function formLayout(options) {
  const inputs = options && typeof options.input === 'object' && options.input ? options.input : {};
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
  const rest = Object.keys(inputs).filter((n) => !seen.has(n));
  if (rest.length) pages.push({ id: 'other', title: pages.length ? 'Övrigt' : '', description: '', fields: rest });
  return { pages, inputs };
}

export const toggleOn = (input) => (input.true_value !== undefined ? input.true_value : true);
export const toggleOff = (input) => (input.false_value !== undefined ? input.false_value : false);
export const isToggleOn = (input, v) => v === toggleOn(input) || (input.true_value === undefined && v === true);

/** Values for the form: existing config first, then each input's default. */
export function initialValues(options, current = {}) {
  const { inputs } = formLayout(options);
  const out = { ...(current || {}) };
  for (const [name, input] of Object.entries(inputs)) {
    if (out[name] !== undefined) continue;
    const kind = inputKind(input);
    if (kind === 'toggle') {
      const d = input.default ?? input.value;
      out[name] = d === true || (d !== undefined && d === input.true_value) ? toggleOn(input) : toggleOff(input);
    } else if (input.default !== undefined) out[name] = input.default;
    else if (kind === 'functions' || kind === 'devices') out[name] = [];
  }
  return out;
}

function regex(src) {
  if (src instanceof RegExp) return src;
  if (typeof src !== 'string' || !src) return null;
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

/** { name: message } for every value that IoT Open (or the app) would not accept. Empty object = valid. */
export function validate(options, values) {
  const { inputs } = formLayout(options);
  const errors = {};
  for (const [name, input] of Object.entries(inputs)) {
    const v = values?.[name];
    const kind = inputKind(input);
    if (EMPTY(v)) {
      if (input.required && kind !== 'toggle') errors[name] = 'Måste fyllas i';
      continue;
    }
    if (kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[name] = 'Ange ett tal';
      else if (input.min !== undefined && n < Number(input.min)) errors[name] = `Minst ${input.min}`;
      else if (input.max !== undefined && n > Number(input.max)) errors[name] = `Högst ${input.max}`;
    } else if (kind === 'text') {
      const re = regex(input.validator);
      if (re && !re.test(String(v))) errors[name] = input.on_error || 'Ogiltigt värde';
    } else if (kind === 'option') {
      const keys = Object.keys(input.values || {});
      if (keys.length && !keys.includes(String(v))) errors[name] = 'Välj ett av alternativen';
    }
  }
  return errors;
}

/** Values as IoT Open should store them (numbers as numbers, option keys as in app.json). */
export function cleanValues(options, values) {
  const { inputs } = formLayout(options);
  const out = { ...values };
  for (const [name, input] of Object.entries(inputs)) {
    const v = out[name];
    const kind = inputKind(input);
    if (kind === 'number' && v !== '' && v !== undefined && v !== null && Number.isFinite(Number(v))) out[name] = Number(v);
    if (kind === 'number' && v === '') delete out[name];
    if (kind === 'option' && v !== undefined) {
      const key = Object.keys(input.values || {}).find((k) => k === String(v));
      // app.json keys are strings; keep a number when the default was a number
      if (key !== undefined) out[name] = typeof input.default === 'number' && /^-?\d+(\.\d+)?$/.test(key) ? Number(key) : key;
    }
    if (kind === 'text' && v === '' && !input.required) delete out[name];
  }
  return out;
}

/** Does a device or function match the input's "filter" (type and/or metadata)? */
export function matchesFilter(item, filter) {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([k, want]) => {
    const have = k === 'type' ? item.type : item.meta?.[k];
    if (want === '*' || want === '') return have !== undefined && have !== '';
    if (Array.isArray(want)) return want.map(String).includes(String(have));
    return String(have) === String(want);
  });
}
