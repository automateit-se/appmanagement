// Parser for the small, safe Markdown subset App Management shows: README files and release notes from GitHub.
// It returns plain data (blocks and inline tokens); Markdown.jsx turns that into React elements, so nothing is ever
// inserted as HTML.
//
// Blocks: headings, paragraphs, bullet and numbered lists (with wrapped continuation lines), code blocks and GitHub
// tables. Inline: `code`, **bold**, *italic* / _italic_, and links (https as links, other targets as plain text).

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Cells of a table row: split on | that is not escaped (\|) or inside `code`. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      cur += c;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isTableStart = (line, next) => line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-');

function align(sep) {
  return splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
}

/** Markdown text -> blocks: { t: 'h', level, text } | { t: 'p', text } | { t: 'ul' | 'ol', items: [text] } |
 *  { t: 'code', lines } | { t: 'table', head: [text], align: [..], rows: [[text]] }. */
export function parseMarkdown(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join(' ') });
    if (list) blocks.push(list);
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code = { t: 'code', lines: [] };
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.lines.push(lines[i]);
      blocks.push(code);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ t: 'h', level: Math.min(h[1].length + 2, 6), text: h[2] });
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const table = { t: 'table', head, align: align(lines[i + 1]), rows: [] };
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
        const cells = splitRow(lines[i]);
        table.rows.push(head.map((_, c) => cells[c] ?? ''));
      }
      i--;
      blocks.push(table);
      continue;
    }
    const li = ITEM.exec(line);
    if (li) {
      const kind = /\d/.test(li[2]) ? 'ol' : 'ul';
      if (para.length || (list && list.t !== kind)) flush();
      if (!list) list = { t: kind, items: [] };
      list.items.push(li[3].trim());
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || /^<!--|^<\/?[a-z]/i.test(trimmed) || /^!\[/.test(trimmed)) {
      flush();
      continue;
    }
    if (list) {
      // a wrapped line continues the last item (indented or not, as on GitHub)
      list.items[list.items.length - 1] += ' ' + trimmed;
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return blocks;
}

/** Inline Markdown -> tokens: { t: 'text' | 'code' | 'strong' | 'em', text } | { t: 'link', text, href }. */
export function parseInline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)|\[([^\]]+)\]\(([^\s)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', text: text.slice(last, m.index) });
    if (m[1]) out.push({ t: 'code', text: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'strong', text: m[2].slice(2, -2) });
    else if (m[3]) out.push({ t: 'em', text: m[3].slice(1, -1) });
    else if (m[4]) out.push({ t: 'em', text: m[4].slice(1, -1) });
    else if (/^https:\/\//.test(m[6])) out.push({ t: 'link', text: m[5], href: m[6] });
    else out.push({ t: 'text', text: m[5] }); // relative or other links: the text only
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', text: text.slice(last) });
  return out;
}
