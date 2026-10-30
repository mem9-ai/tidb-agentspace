import assert from 'node:assert/strict';
import test from 'node:test';
import { firstWorkspaceId } from './workspace-selection.ts';

test('Workspace discovery selects the first authenticated result without a fixed ID', () => {
  assert.equal(firstWorkspaceId({ data: [{ id: 'ws_agentlab' }] }), 'ws_agentlab');
  assert.equal(
    firstWorkspaceId({ data: [{ id: '11111111-1111-4111-8111-111111111111' }] }),
    '11111111-1111-4111-8111-111111111111',
  );
  for (const value of [
    null,
    {},
    { data: [] },
    { data: [{ id: '../other' }] },
    { data: [{ id: '..' }] },
    { data: [{ id: '' }] },
  ])
    assert.throws(() => firstWorkspaceId(value));
});
