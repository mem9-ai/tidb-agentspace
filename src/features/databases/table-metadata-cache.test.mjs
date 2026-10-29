import assert from 'node:assert/strict';
import test from 'node:test';
import { TableMetadataCache } from './table-metadata-cache.ts';

const detail = (name) => ({
  name,
  columns: [],
  indexes: [],
  type: 'VIEW',
  mode: 'live',
  query: '',
});

test('returning to a table reuses its metadata without extending its freshness window', () => {
  let now = 0;
  const cache = new TableMetadataCache(() => now);
  cache.set('resource-a:revision-0', 'first', detail('first'));
  cache.set('resource-a:revision-0', 'second', detail('second'));
  now = 29_999;
  assert.equal(cache.get('resource-a:revision-0', 'first').name, 'first');
  assert.equal(cache.get('resource-a:revision-0', 'second').name, 'second');
  now = 30_000;
  assert.equal(cache.get('resource-a:revision-0', 'first'), undefined);
});

test('resource changes and explicit refresh/retry discard all previous metadata', () => {
  const cache = new TableMetadataCache();
  cache.set('resource-a:revision-0', 'same-name', detail('old'));
  assert.equal(cache.get('resource-b:revision-0', 'same-name'), undefined);
  assert.equal(cache.get('resource-a:revision-0', 'same-name'), undefined);
  cache.set('resource-a:revision-0', 'same-name', detail('old'));
  assert.equal(cache.get('resource-a:revision-1', 'same-name'), undefined);
  cache.set('resource-a:revision-1', 'same-name', detail('new'));
  assert.equal(cache.get('resource-a:revision-1', 'same-name').name, 'new');
});

test('metadata retention is bounded and evicts the least recently used table', () => {
  const cache = new TableMetadataCache();
  for (let i = 0; i < 16; i++) cache.set('database', `table-${i}`, detail(`table-${i}`));
  cache.get('database', 'table-0');
  cache.set('database', 'table-16', detail('table-16'));
  assert.equal(cache.get('database', 'table-1'), undefined);
  assert.equal(cache.get('database', 'table-0').name, 'table-0');
  assert.equal(cache.get('database', 'table-16').name, 'table-16');
});
