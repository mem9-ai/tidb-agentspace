import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileFormat, formatJson, previewCsv, prepareFilePreview } from './file-preview.ts';
import { limitMermaidDiagrams, MarkdownPreview } from './MarkdownPreview.ts';

test('file preview selects text formats case-insensitively and treats active formats as code', () => {
  assert.equal(fileFormat('/docs/README.MD').kind, 'markdown');
  assert.equal(fileFormat('/context.markdown').kind, 'markdown');
  assert.equal(fileFormat('/diagram.MMD').kind, 'mermaid');
  assert.equal(fileFormat('/diagram.mermaid').kind, 'mermaid');
  assert.equal(fileFormat('/data.json').kind, 'json');
  assert.equal(fileFormat('/data.CSV').kind, 'csv');
  assert.equal(fileFormat('/script.py').language, 'python');
  assert.equal(fileFormat('/page.html').kind, 'code');
  assert.equal(fileFormat('/image.svg').kind, 'code');
  assert.equal(fileFormat('/LICENSE').kind, 'text');
});

test('JSON formatting preserves large integer IDs, escapes and empty containers without rewriting the source', () => {
  const source =
    '{"id":9007199254740993,"label":"a, \\"quote\\"","empty":[{},[]],"nested":{"ok":true}}';
  const formatted = formatJson(source);
  assert.match(formatted, /\n {2}"id": 9007199254740993,/);
  assert.match(formatted, /"label": "a, \\"quote\\""/);
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source));
  assert.equal(formatJson('{}'), '{}');
  assert.equal(formatJson('null'), 'null');
  assert.throws(() => formatJson('{"oops":}'));
});

test('CSV preview parses quoted commas, escaped quotes, multiline values and CRLF', () => {
  const result = previewCsv(
    'name,note\r\nAda,"one, two"\r\nLin,"line 1\nline 2 with ""quotes"""\r\n',
  );
  assert.deepEqual(result, {
    rows: [
      ['name', 'note'],
      ['Ada', 'one, two'],
      ['Lin', 'line 1\nline 2 with "quotes"'],
    ],
    truncated: false,
  });
  assert.deepEqual(previewCsv('a,b,').rows, [['a', 'b', '']]);
  assert.deepEqual(previewCsv('').rows, []);
});

test('CSV preview bounds large tables and rejects malformed quoting without silently changing fields', () => {
  assert.deepEqual(previewCsv('a\nb\nc', 2), { rows: [['a'], ['b']], truncated: true });
  assert.equal(previewCsv('a\nb\n', 2).truncated, false);
  assert.throws(() => previewCsv('"unfinished'));
  assert.throws(() => previewCsv('"quoted"suffix'));
  assert.throws(() => previewCsv('un"quoted'));
  assert.throws(() => previewCsv('a,b,c', 200, 2));
});

test('preview checks UTF-8 bytes before parsing or rendering, including exact size boundaries', () => {
  const text = ('a'.repeat(1023) + '\n').repeat(128);
  assert.equal(prepareFilePreview('/large.txt', text).kind, 'text');
  assert.match(prepareFilePreview('/large.md', text + 'a').reason, /128 KiB/);
  assert.match(prepareFilePreview('/invalid.json', text + '{').reason, /128 KiB/);
  const unicode = ('é'.repeat(511) + 'a\n').repeat(128);
  assert.equal(new TextEncoder().encode(unicode).length, 128 * 1024);
  assert.equal(prepareFilePreview('/unicode.txt', unicode).kind, 'text');
  assert.match(prepareFilePreview('/unicode.txt', unicode + 'é').reason, /128 KiB/);
});

test('preview bounds line counts and long lines without rejecting ordinary unknown text formats', () => {
  assert.equal(prepareFilePreview('/LICENSE', 'x\r\n'.repeat(1999) + 'x').kind, 'text');
  assert.match(prepareFilePreview('/lines.md', 'x\r\n'.repeat(2000) + 'x').reason, /2,000-line/);
  assert.equal(prepareFilePreview('/line.txt', 'a'.repeat(10000)).kind, 'text');
  assert.match(prepareFilePreview('/line.js', 'a'.repeat(10001)).reason, /10,000-character/);
  assert.equal(prepareFilePreview('/text.custom', 'café\t→\nnext line').kind, 'text');
});

test('unsupported file types and binary/control data use an unavailable preview', () => {
  assert.match(prepareFilePreview('/report.PDF', '%PDF-1.4').reason, /not supported/);
  assert.match(prepareFilePreview('/photo.png', 'not an image decoder').reason, /not supported/);
  assert.match(prepareFilePreview('/unknown', 'a\0b').reason, /binary or control/);
  assert.match(prepareFilePreview('/log.txt', '\u001b[31m').reason, /binary or control/);
  assert.equal(prepareFilePreview('/vector.svg', '<svg></svg>').kind, 'code');
});

test('failed parsing has a useful unavailable reason and corrected content recovers', () => {
  assert.match(prepareFilePreview('/data.json', '{bad}').reason, /could not be parsed as JSON/);
  assert.equal(prepareFilePreview('/data.json', '{"ok":true}').kind, 'json');
  assert.match(prepareFilePreview('/data.csv', '"unfinished').reason, /could not be rendered/);
  assert.match(
    prepareFilePreview('/wide.csv', Array(51).fill('cell').join(',')).reason,
    /50-column/,
  );
  assert.equal(prepareFilePreview('/data.csv', 'name\nAda').kind, 'csv');
  const csv = prepareFilePreview('/rows.csv', 'row\n'.repeat(300));
  assert.equal(csv.kind, 'csv');
  assert.equal(csv.rows.length, 200);
  assert.equal(csv.truncated, true);
});

test('small deeply nested or expanded JSON cannot cause unbounded formatted output', () => {
  const nested = (depth) => '['.repeat(depth) + '0' + ']'.repeat(depth);
  assert.equal(prepareFilePreview('/deep.json', nested(64)).kind, 'json');
  assert.match(prepareFilePreview('/deep.json', nested(65)).reason, /64-level nesting/);
  assert.match(prepareFilePreview('/deep.json', nested(4000)).reason, /64-level nesting/);
  const expanded = '['.repeat(64) + Array(1000).fill('0').join(',') + ']'.repeat(64);
  assert.match(prepareFilePreview('/expanded.json', expanded).reason, /formatted JSON exceeds/);
  assert.throws(() => formatJson(expanded), /formatted JSON exceeds/);
});

test('Markdown renders headings, emphasis, code, tables and task lists', () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownPreview, {
      content:
        '# Context\n\n**Memory** and `SELECT 1`\n\n| Name | Type |\n| --- | --- |\n| db | SQL |\n\n- [x] Saved\n- [ ] Next\n\n```sql\nSELECT 1;\n```',
    }),
  );
  assert.match(html, /<h1>Context<\/h1>/);
  assert.match(html, /<strong>Memory<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /aria-label="Completed task"/);
  assert.match(html, /<pre><code class="language-sql">SELECT 1;/);
});

test('Markdown cannot execute raw HTML or unsafe URLs, and does not fetch embedded images', () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownPreview, {
      content:
        '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29)\n\n[relative](/api/owner/state)\n\n![Tracker](https://example.com/tracker.png)\n\n[safe](https://example.com/docs)',
    }),
  );
  assert.doesNotMatch(html, /<script|<img|onerror|javascript:|src=|href="\/api/);
  assert.match(html, /Image: Tracker/);
  assert.match(
    html,
    /href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer"/,
  );
});

test('Markdown bounds the number of Mermaid diagrams without losing source', () => {
  const nodes = Array.from({ length: 9 }, (_, index) => ({
    type: 'code',
    lang: index === 0 ? 'MERMAID' : 'mermaid',
    value: `graph ${index}`,
  }));
  limitMermaidDiagrams()({ type: 'root', children: nodes });
  assert.equal(nodes.filter((node) => node.lang === 'mermaid-over-limit').length, 1);
  assert.equal(nodes[8].value, 'graph 8');
  let deep = { type: 'code', lang: 'mermaid', value: 'graph LR' };
  for (let index = 0; index < 10000; index++) deep = { type: 'blockquote', children: [deep] };
  assert.doesNotThrow(() => limitMermaidDiagrams()({ type: 'root', children: [deep] }));
});
