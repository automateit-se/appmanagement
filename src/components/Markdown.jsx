// A small, safe Markdown renderer for README files from GitHub: headings, paragraphs, lists, code blocks,
// inline code, bold and https links. Everything is rendered as React elements (escaped), never as HTML.

function inline(text, keyBase) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else
      out.push(
        <a key={k} href={m[4]} target="_blank" rel="noopener noreferrer">
          {m[3]}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  let code = null;
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join(' ') });
    if (list) blocks.push(list);
    para = [];
    list = null;
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        blocks.push(code);
        code = null;
      } else code.lines.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      code = { t: 'code', lines: [] };
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: 'h', level: Math.min(h[1].length + 2, 6), text: h[2] });
      continue;
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) flush();
      if (!list) list = { t: 'ul', items: [] };
      list.items.push(li[1]);
      continue;
    }
    if (!line.trim() || /^<!--|^<\/?[a-z]/i.test(line.trim()) || /^!\[/.test(line.trim())) {
      flush();
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  if (code) blocks.push(code);
  flush();

  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        if (b.t === 'p') return <p key={i}>{inline(b.text, i)}</p>;
        if (b.t === 'code') return <pre key={i}>{b.lines.join('\n')}</pre>;
        if (b.t === 'ul')
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it, `${i}-${j}`)}</li>
              ))}
            </ul>
          );
        const H = `h${b.level}`;
        return <H key={i}>{inline(b.text, i)}</H>;
      })}
    </div>
  );
}
