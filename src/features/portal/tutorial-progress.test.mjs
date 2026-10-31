import assert from 'node:assert/strict';
import test from 'node:test';
import { createTutorialStore } from './tutorial-progress.ts';

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
const progress = { id: 'a'.repeat(32), attempted: true, ready: true, completed: true };

test('tutorial sample and completion survive closing a tab without recreating data', () => {
  const persistent = storage();
  const first = createTutorialStore('ws_agentlab', { persistent, session: storage() });
  first.saveSample('db_first', progress);
  first.saveSelection('database', 'db_first');
  first.saveSample('fs_shared', { ...progress, id: 'b'.repeat(32), completed: false });
  const reopened = createTutorialStore('ws_agentlab', { persistent, session: storage() });
  assert.deepEqual(reopened.readSample('db_first'), progress);
  assert.equal(reopened.readSelection('database'), 'db_first');
  assert.equal(reopened.readSample('fs_shared').id, 'b'.repeat(32));
  assert.equal(reopened.readSample('fs_shared').completed, false);
  assert.equal(reopened.readSample('db_missing'), null);
  assert.equal(createTutorialStore('ws_other', { persistent }).readSample('db_first'), null);
});

test('session-only progress migrates without discarding an uncertain write or inferring completion', () => {
  const persistent = storage();
  const session = storage();
  const pending = { id: 'c'.repeat(32), attempted: true, ready: false };
  session.setItem('tutorial:db_pending', JSON.stringify(pending));
  session.setItem('tutorial-selection:database', 'db_pending');
  const migrated = createTutorialStore('ws_agentlab', { persistent, session });
  assert.deepEqual(migrated.readSample('db_pending'), { ...pending, completed: false });
  assert.equal(migrated.readSelection('database'), 'db_pending');
  const reopened = createTutorialStore('ws_agentlab', { persistent });
  assert.deepEqual(reopened.readSample('db_pending'), { ...pending, completed: false });
  assert.equal(reopened.readSelection('database'), 'db_pending');
  assert.equal(createTutorialStore('ws_other', { session }).readSample('db_pending'), null);
});

test('storage failures retain current progress and malformed saved state is ignored', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const store = createTutorialStore('ws_agentlab', { persistent: blocked, session: blocked });
  store.saveSample('db_first', progress);
  store.saveSelection('database', 'db_first');
  assert.deepEqual(store.readSample('db_first'), progress);
  assert.equal(store.readSelection('database'), 'db_first');
  const persistent = storage();
  const session = storage();
  persistent.setItem('workspace-tutorial:v1:ws_agentlab:db_bad', '{invalid');
  session.setItem('workspace-tutorial:v1:ws_agentlab:db_bad', JSON.stringify(progress));
  assert.deepEqual(
    createTutorialStore('ws_agentlab', { persistent, session }).readSample('db_bad'),
    progress,
  );
  persistent.setItem(
    'workspace-tutorial:v1:ws_agentlab:db_injection',
    JSON.stringify({ ...progress, id: '../other' }),
  );
  assert.equal(createTutorialStore('ws_agentlab', { persistent }).readSample('db_injection'), null);
});
