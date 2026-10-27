// A small, safe Markdown renderer for README files and release notes from GitHub. The parsing is in
// ../lib/markdown.js; everything is rendered as React elements (escaped), never as HTML.
import { parseInline, parseMarkdown } from '../lib/markdown.js';

function inline(text, keyBase) {
  return parseInline(text).map((tok, i) => {
    const k = `${keyBase}-${i}`;
    if (tok.t === 'code') return <code key={k}>{tok.text}</code>;
    if (tok.t === 'strong') return <strong key={k}>{inline(tok.text, k)}</strong>;
    if (tok.t === 'em') return <em key={k}>{inline(tok.text, k)}</em>;
    if (tok.t === 'link')
      return (
        <a key={k} href={tok.href} target="_blank" rel="noopener noreferrer">
          {tok.text}
        </a>
      );
    return tok.text;
  });
}

export function Markdown({ text }) {
  return (
    <div className="markdown">
      {parseMarkdown(text).map((b, i) => {
        if (b.t === 'p') return <p key={i}>{inline(b.text, i)}</p>;
        if (b.t === 'code') return <pre key={i}>{b.lines.join('\n')}</pre>;
        if (b.t === 'ul' || b.t === 'ol') {
          const L = b.t;
          return (
            <L key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it, `${i}-${j}`)}</li>
              ))}
            </L>
          );
        }
        if (b.t === 'table')
          return (
            <div key={i} className="md-table">
              <table>
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                        {inline(c, `${i}-h${j}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((c, j) => (
                        <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                          {inline(c, `${i}-${r}-${j}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        const H = `h${b.level}`;
        return <H key={i}>{inline(b.text, i)}</H>;
      })}
    </div>
  );
}
