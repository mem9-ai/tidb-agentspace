import assert from 'node:assert/strict';
import test from 'node:test';
import {
  databaseEditorHash,
  databaseTablesHash,
  tableSelectSql,
  parseWorkspaceRoute,
  tutorialHash,
} from './workspace-route.ts';

test('tutorial links resume the exact resource through reload and history', () => {
  for (const resourceId of ['db_memory', 'fs_shared', 'missing', 'resource / with % and #']) {
    assert.deepEqual(parseWorkspaceRoute(tutorialHash(resourceId)), {
      page: 'tutorials',
      tutorialResourceId: resourceId,
    });
  }
  assert.deepEqual(parseWorkspaceRoute('#connect'), { page: 'connect' });
  assert.deepEqual(parseWorkspaceRoute('#activity'), { page: 'overview' });
  assert.deepEqual(parseWorkspaceRoute('#monitoring'), { page: 'overview' });
  assert.deepEqual(parseWorkspaceRoute('#tutorials?resourceId='), { page: 'tutorials' });
  assert.deepEqual(parseWorkspaceRoute('#tutorials?kind=filesystem'), {
    page: 'tutorials',
    tutorialKind: 'filesystem',
  });
});

test('database editor links retain the exact resource identity for reload and history', () => {
  for (const databaseId of ['db_memory', 'db_vectors', 'database / with % and #']) {
    assert.deepEqual(parseWorkspaceRoute(databaseEditorHash(databaseId)), {
      page: 'databases',
      databaseId,
      databaseView: 'sql',
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
    databaseView: 'sql',
  });
  assert.deepEqual(parseWorkspaceRoute('#files'), { page: 'files' });
  assert.deepEqual(parseWorkspaceRoute('#constructor'), { page: 'overview' });
});

test('table links preserve reserved characters across browse, editor, reload and history', () => {
  for (const name of [
    'workspace_notes',
    'a/b?c#d%&e',
    '订单 `detail`',
    "x'; DROP TABLE users; --",
  ]) {
    for (const [build, view] of [
      [databaseEditorHash, 'sql'],
      [databaseTablesHash, 'tables'],
    ]) {
      assert.deepEqual(parseWorkspaceRoute(build('db_memory', name)), {
        page: 'databases',
        databaseId: 'db_memory',
        databaseView: view,
        tableName: name,
      });
    }
  }
  assert.equal(tableSelectSql('a`b'), 'SELECT * FROM `a``b` LIMIT 100;');
  assert.equal(tableSelectSql('a"b', 'postgresql'), 'SELECT * FROM "workspace"."a""b" LIMIT 100;');
  assert.equal(tableSelectSql('a"b', 'duckdb'), 'SELECT * FROM "main"."a""b" LIMIT 100;');
  for (const tail of ['%ZZ', '', 'a%00b', 'a'.repeat(65)])
    assert.deepEqual(parseWorkspaceRoute('#databases/db_memory/tables?table=' + tail), {
      page: 'databases',
    });
});
