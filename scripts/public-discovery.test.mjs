import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { discoveryFiles, publicPages } from './public-discovery.mjs';

test('public discovery has readable initial HTML, correct canonical paths, private exclusions and preview noindex', () => {
  const files = discoveryFiles({
    base: '/studio/',
    origin: 'https://example.test/studio/',
    script: 'assets/discovery.js',
  });
  for (const page of publicPages) {
    const html = files[page.path + 'index.html'];
    assert.ok(parse(html));
    assert.ok(html.includes(page.heading));
    assert.match(html, /<h1\b/);
    assert.match(html, /:root\[data-mantine-color-scheme=dark\]\{--mantine-color-/);
    assert.ok(html.includes(`rel="canonical" href="https://example.test/studio/${page.path}"`));
    assert.match(html, /name="description"/);
    assert.match(html, /property="og:title"/);
    assert.ok(html.includes('src="/studio/assets/discovery.js"'));
    assert.ok(files['sitemap.xml'].includes('https://example.test/studio/' + page.path));
    assert.ok(!html.includes('workspace-key') && !html.includes('SELECT secret'));
  }
  assert.ok(!files['sitemap.xml'].includes('/admin'));
  assert.ok(!files['sitemap.xml'].includes('/api/global'));
  assert.ok(!files['robots.txt'].includes('Disallow: /studio/admin'));
  const preview = discoveryFiles({ base: '/studio/' });
  assert.match(preview['discover/index.html'], /noindex,follow/);
  assert.ok(!preview['sitemap.xml'].includes('<loc>'));
  assert.throws(() => discoveryFiles({ base: '/studio/', origin: 'https://example.test/other/' }));
});
