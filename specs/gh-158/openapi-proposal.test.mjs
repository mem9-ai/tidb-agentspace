import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const spec = parse(await readFile(new URL('./openapi-proposal.yaml', import.meta.url), 'utf8'), {
  uniqueKeys: true,
});
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const schema = (name) =>
  ajv.compile({ ...spec.components.schemas[name], components: spec.components });

test('pairing grants require explicit confirmation and reject wildcard or extra authority', () => {
  const valid = schema('Approval');
  const approval = {
    confirmed: true,
    grants: {
      resourceIds: ['fs_sales'],
      scopes: ['resources:read', 'files:read', 'files:analyze', 'files:write'],
      expiresAt: '2026-11-04T00:00:00Z',
    },
  };
  assert.equal(valid(approval), true, JSON.stringify(valid.errors));
  for (const changed of [
    { ...approval, confirmed: false },
    { ...approval, grants: { ...approval.grants, resourceIds: ['*'] } },
    { ...approval, grants: { ...approval.grants, scopes: ['resources:write'] } },
    { ...approval, grants: { ...approval.grants, scopes: ['files:read', 'keys:write'] } },
    { ...approval, grants: { ...approval.grants, resourceIds: [] } },
    { ...approval, grants: { ...approval.grants, secret: 'not-allowed' } },
  ])
    assert.equal(valid(changed), false, JSON.stringify(changed));
});

test('pairing and connection receipts do not accept untrusted actor or content fields', () => {
  const start = schema('Start');
  assert.equal(start({ workspaceId: 'ws_guest', verifierChallenge: 'a'.repeat(43) }), true);
  assert.equal(start({ workspaceId: '../other', verifierChallenge: 'a'.repeat(43) }), false);
  assert.equal(start({ workspaceId: 'ws_guest', verifierChallenge: 'short' }), false);
  const receipt = schema('Receipt');
  const value = {
    workspaceId: 'ws_guest',
    keyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceId: 'fs_sales',
    regionId: 'region:test',
    observedAt: '2026-11-03T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
  };
  assert.equal(receipt(value), true, JSON.stringify(receipt.errors));
  for (const extra of [{ actor: 'claimed-agent' }, { sql: 'SELECT 1' }, { secret: 'secret' }])
    assert.equal(receipt({ ...value, ...extra }), false);
  const token = spec.paths['/api/v1/workspaces/{workspaceId}/agent-connection-receipts'].post;
  assert.deepEqual(token.security, [{ regionalAccess: [] }]);
  const owner =
    spec.paths['/api/portal/v1/workspaces/{workspaceId}/agent-connection-receipts/{keyId}'].get;
  assert.deepEqual(owner.security, [
    { regionalLocalOwner: [] },
    { regionalAccountOwner: [] },
    { guestOwner: [] },
  ]);
});
