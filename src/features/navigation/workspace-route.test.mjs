import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseEditorHash, parseWorkspaceRoute } from './workspace-route.ts';

test('database editor links retain the exact resource identity for reload and history', () => {
  for (const databaseId of ['db_memory', 'db_vectors', 'database / with % and #']) {
    assert.deepEqual(parseWorkspaceRoute(databaseEditorHash(databaseId)), {
      page: 'databases',
      databaseId,
    });
  }
});

test('legacy and malformed editor links require database selection instead of choosing one', () => {
  for (const hash of [
    '#sql',
    '#databases',
    '#databases//sql',
    '#databases/%ZZ/sql',
    '#databases/db_memory/unknown',
  ]) {
    assert.deepEqual(parseWorkspaceRoute(hash), { page: 'databases' });
  }
});

test('unknown database IDs are preserved for availability checks, never replaced with another database', () => {
  assert.deepEqual(parseWorkspaceRoute('#databases/missing/sql'), {
    page: 'databases',
    databaseId: 'missing',
  });
  assert.deepEqual(parseWorkspaceRoute('#files'), { page: 'files' });
  assert.deepEqual(parseWorkspaceRoute('#constructor'), { page: 'overview' });
});
