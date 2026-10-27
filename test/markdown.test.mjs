import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, splitRow } from '../src/lib/markdown.js';

test('GitHub tables', () => {
  const md = [
    '| Setting | Default | Option |',
    '|---|:---:|---:|',
    '| Max antal köade meddelanden | 1000 | `max_queued_messages` (0-10 000 000) |',
    '| Köa även QoS 0 | off |',
    '',
    'After.',
  ].join('\n');
  const [table, p] = parseMarkdown(md);
  assert.equal(table.t, 'table');
  assert.deepEqual(table.head, ['Setting', 'Default', 'Option']);
  assert.deepEqual(table.align, [null, 'center', 'right']);
  assert.deepEqual(table.rows[0], ['Max antal köade meddelanden', '1000', '`max_queued_messages` (0-10 000 000)']);
  assert.deepEqual(table.rows[1], ['Köa även QoS 0', 'off', ''], 'missing cells are empty');
  assert.deepEqual(p, { t: 'p', text: 'After.' });
});

test('pipes in code and escaped pipes stay in the cell', () => {
  assert.deepEqual(splitRow('| a | `x|y` | b \\| c |'), ['a', '`x|y`', 'b | c']);
});

test('a pipe in a paragraph without a separator line is no table', () => {
  assert.deepEqual(parseMarkdown('a | b\nc'), [{ t: 'p', text: 'a | b c' }]);
});

test('wrapped list items stay one item', () => {
  const md = [
    '- at most **1000 messages** are queued; when the queue is full, new messages are dropped,',
    '  so the end of a long outage is what is missing,',
    '- only QoS 1 or 2,',
    'lazy continuation without indentation.',
    '',
    '1. first',
    '2. second',
  ].join('\n');
  const [ul, ol] = parseMarkdown(md);
  assert.equal(ul.t, 'ul');
  assert.equal(ul.items.length, 2);
  assert.match(ul.items[0], /dropped, so the end of a long outage is what is missing,$/);
  assert.equal(ul.items[1], 'only QoS 1 or 2, lazy continuation without indentation.');
  assert.deepEqual(ol, { t: 'ol', items: ['first', 'second'] });
});

test('paragraph lines are joined, headings and code blocks', () => {
  const md = '# Title\nline one\nline two\n\n```bash\nlua5.3 tests/test_app.lua\n```';
  assert.deepEqual(parseMarkdown(md), [
    { t: 'h', level: 3, text: 'Title' },
    { t: 'p', text: 'line one line two' },
    { t: 'code', lines: ['lua5.3 tests/test_app.lua'] },
  ]);
});

test('inline: code, bold, italic and links', () => {
  assert.deepEqual(parseInline('a `x*y*` **b** *c* _d_ [e](https://example.com) [LICENSE](LICENSE) snake_case_name'), [
    { t: 'text', text: 'a ' },
    { t: 'code', text: 'x*y*' },
    { t: 'text', text: ' ' },
    { t: 'strong', text: 'b' },
    { t: 'text', text: ' ' },
    { t: 'em', text: 'c' },
    { t: 'text', text: ' ' },
    { t: 'em', text: 'd' },
    { t: 'text', text: ' ' },
    { t: 'link', text: 'e', href: 'https://example.com' },
    { t: 'text', text: ' ' },
    { t: 'text', text: 'LICENSE' },
    { t: 'text', text: ' snake_case_name' },
  ]);
  assert.deepEqual(parseInline('[x](javascript:alert(1))').filter((t) => t.t === 'link'), [], 'only https links');
});
