import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileFormat, formatJson, previewCsv } from './file-preview.ts';
import { MarkdownPreview } from './MarkdownPreview.ts';

test('file preview selects text formats case-insensitively and treats active formats as code', () => {
  assert.equal(fileFormat('/docs/README.MD').kind, 'markdown');
  assert.equal(fileFormat('/context.markdown').kind, 'markdown');
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
