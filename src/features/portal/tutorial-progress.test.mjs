import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceApiError } from '../../api/transport.ts';
import { createTutorialStore } from './tutorial-progress.ts';

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
function fixture() {
  const records = new Map();
  const writes = [];
  let revision = 0;
  const api = {
    async listTutorials(workspaceId) {
      return {
        data: [...records.values()]
          .filter((record) => record.workspaceId === workspaceId)
          .map(({ workspaceId: _workspace, ...record }) => structuredClone(record)),
        nextCursor: null,
      };
    },
    async replaceTutorial(workspaceId, resourceId, input, version) {
      writes.push({ workspaceId, resourceId, input, version });
      const key = workspaceId + ':' + resourceId;
      const prior = records.get(key);
      if (version ? prior?.version !== version : prior) throw new WorkspaceApiError('Changed', 412);
      const record = {
        ...input,
        resourceId,
        version: '"tutorial-' + (++revision).toString(16).padStart(32, '0') + '"',
        updatedAt: '2026-10-31T00:00:00Z',
      };
      records.set(key, { workspaceId, ...record });
      return { data: structuredClone(record) };
    },
  };
  return { api, writes, records };
}
const started = { id: 'a'.repeat(32), attempted: true, ready: false, completed: false };

test('Workspace progress survives a fresh browser with empty storage and stays isolated by Workspace/resource', async () => {
  const { api } = fixture();
  const first = createTutorialStore('one', api);
  await first.refresh();
  const pending = await first.saveSample('db_one', started);
  await first.saveSample('db_one', { ...pending, ready: true, completed: true });
  await first.saveSample('fs_one', { ...started, id: 'b'.repeat(32) });
  const freshBrowser = createTutorialStore('one', api);
  await freshBrowser.refresh();
  assert.equal(freshBrowser.readSample('db_one').id, started.id);
  assert.equal(freshBrowser.readSample('db_one').completed, true);
  assert.equal(freshBrowser.readSample('fs_one').ready, false);
  assert.equal(freshBrowser.readSample('missing'), null);
  const foreign = createTutorialStore('other', api);
  await foreign.refresh();
  assert.equal(foreign.readSample('db_one'), null);
});

test('stale browsers cannot overwrite a new sample or treat a conflict as permission to write data', async () => {
  const { api, writes } = fixture();
  const first = createTutorialStore('one', api);
  const second = createTutorialStore('one', api);
  await Promise.all([first.refresh(), second.refresh()]);
  const saved = await first.saveSample('db_one', started);
  await assert.rejects(
    second.saveSample('db_one', { ...started, id: 'b'.repeat(32) }),
    /changed in this Workspace/,
  );
  assert.equal(second.readSample('db_one').id, started.id);
  assert.equal(second.readSample('db_one').ready, false);
  const changed = await first.saveSample('db_one', {
    ...saved,
    id: 'c'.repeat(32),
    attempted: false,
  });
  await assert.rejects(
    second.saveSample('db_one', { ...saved, ready: true }),
    /changed in this Workspace/,
  );
  assert.deepEqual(second.readSample('db_one'), changed);
  assert.equal(writes.length, 4, 'one request per explicit save; no replay');
});

test('legacy migration preserves exact uncertain/completed samples, never overwrites Workspace state and cannot cross a Workspace', async () => {
  const { api, writes } = fixture();
  const persistent = storage();
  const session = storage();
  persistent.setItem(
    'workspace-tutorial:v1:one:db_old',
    JSON.stringify({ ...started, ready: true, completed: true }),
  );
  session.setItem('workspace-tutorial:v1:one:fs_old', JSON.stringify(started));
  session.setItem('tutorial:db_legacy', JSON.stringify(started));
  persistent.setItem(
    'workspace-tutorial:v1:one:db_bad',
    JSON.stringify({ ...started, id: '../other' }),
  );
  const migrated = createTutorialStore('one', api, { persistent, session });
  await migrated.refresh(['db_old', 'fs_old', 'db_bad', 'db_legacy']);
  assert.equal(migrated.readSample('db_old').completed, true);
  assert.equal(migrated.readSample('fs_old').id, started.id);
  assert.equal(migrated.readSample('fs_old').ready, false);
  assert.equal(migrated.readSample('db_bad'), null);
  assert.equal(migrated.readSample('db_legacy'), null);
  const current = migrated.readSample('db_old');
  await migrated.saveSample('db_old', {
    ...current,
    id: 'c'.repeat(32),
    ready: false,
    completed: false,
  });
  const reopened = createTutorialStore('one', api, { persistent, session });
  await reopened.refresh(['db_old', 'fs_old']);
  assert.equal(reopened.readSample('db_old').id, 'c'.repeat(32));
  assert.equal(writes.length, 3, 'existing Workspace records always win over old browser copies');
  const original = createTutorialStore('ws_agentlab', api, { session });
  await original.refresh(['db_legacy']);
  assert.equal(original.readSample('db_legacy').id, started.id);
});

test('unknown save acknowledgement is observed without retry; unavailable API never falls back to browser authority', async () => {
  const { api, writes } = fixture();
  const persistent = storage();
  persistent.setItem('workspace-tutorial:v1:one:db_old', JSON.stringify(started));
  const unavailable = createTutorialStore(
    'one',
    {
      ...api,
      listTutorials: async () => {
        throw new Error('offline');
      },
    },
    { persistent },
  );
  await unavailable.refresh(['db_old']);
  assert.ok(unavailable.getSnapshot().error);
  assert.equal(unavailable.readSample('db_old'), null);
  await assert.rejects(unavailable.saveSample('db_old', started), /Load Workspace/);
  const lost = createTutorialStore('one', {
    ...api,
    replaceTutorial: async (...args) => {
      await api.replaceTutorial(...args);
      throw new Error('response lost');
    },
  });
  await lost.refresh();
  await assert.rejects(lost.saveSample('db_old', started), /No sample action was retried/);
  assert.equal(lost.readSample('db_old').attempted, true);
  assert.equal(writes.length, 1);
  const blocked = {
    getItem() {
      throw new Error('storage blocked');
    },
  };
  const browser = createTutorialStore('one', api, { persistent: blocked, session: blocked });
  await browser.refresh(['db_old']);
  assert.equal(browser.readSample('db_old').id, started.id);
});
