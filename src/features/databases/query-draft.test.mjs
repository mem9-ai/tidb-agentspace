import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueryDraft, queryDraftReducer } from './query-draft.ts';

test('generated table queries replace only untouched or blank drafts without confirmation', () => {
  const initial = createQueryDraft('SELECT 1;');
  const query = { type: 'queryTable', sql: 'SELECT * FROM `notes` LIMIT 100;' };
  assert.deepEqual(queryDraftReducer(initial, query), createQueryDraft(query.sql));
  assert.deepEqual(
    queryDraftReducer({ ...initial, sql: ' \n ' }, query),
    createQueryDraft(query.sql),
  );
  const existing = createQueryDraft(query.sql);
  assert.equal(queryDraftReducer(existing, query), existing);
});

test('edited SQL survives generated-query requests and cancellation; explicit replacement is required', () => {
  const initial = createQueryDraft('SELECT 1;');
  const edited = queryDraftReducer(initial, {
    type: 'edit',
    sql: 'SELECT note FROM workspace_notes WHERE id = 2;',
  });
  const pending = queryDraftReducer(edited, {
    type: 'queryTable',
    sql: 'SELECT * FROM `other` LIMIT 100;',
  });
  assert.equal(pending.sql, edited.sql);
  assert.equal(pending.pendingSql, 'SELECT * FROM `other` LIMIT 100;');
  assert.deepEqual(queryDraftReducer(pending, { type: 'cancel' }), edited);
  const replaced = queryDraftReducer(pending, { type: 'replace' });
  assert.equal(replaced.sql, pending.pendingSql);
  assert.equal(replaced.generatedSql, pending.pendingSql);
  assert.equal(replaced.pendingSql, null);
  assert.equal(queryDraftReducer(edited, { type: 'replace' }), edited);
});
