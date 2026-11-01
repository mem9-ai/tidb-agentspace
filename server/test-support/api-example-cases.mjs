import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apiExamples } from '../../src/features/api/api-examples.ts';
import { productApiFixture } from './product-api-fixture.mjs';

// Execute the same strings shown in Console against real Global + Region HTTP, not a mock.
export async function apiExampleCases(t) {
  const f = await productApiFixture(t, 'remote');
  const issued = await f.issueKey({
    name: 'documented-examples',
    scopes: ['resources:read', 'queries:execute', 'files:read', 'files:write', 'files:analyze'],
    resourceIds: ['db_live', 'fs_live'],
    expiresInDays: 7,
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const endpoints = f.endpoints;
  const examples = apiExamples(
    endpoints.global,
    endpoints.region,
    endpoints.workspaceId,
    endpoints.regionId,
    'db_live',
    'fs_live',
  );
  const upload = await f.request('/files/content?resourceId=fs_live&path=%2Fdata.csv', {
    method: 'PUT',
    token: issued.body.secret,
    headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' },
    raw: Buffer.from('id,name\n1,Example\n'),
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const run = promisify(execFile);
  const env = {
    ...process.env,
    GLOBAL_API: endpoints.global,
    REGION_API: endpoints.region,
    REGION_ID: endpoints.regionId,
    WORKSPACE_API_KEY: issued.body.workspaceKey,
  };
  const shell = await run(
    'bash',
    [
      '-euo',
      'pipefail',
      '-c',
      [
        examples.setup,
        examples.exchange,
        examples.sql,
        examples.files,
        examples.imports,
        examples.exports,
      ].join('\n'),
    ],
    { env, maxBuffer: 1024 * 1024 },
  );
  assert.match(shell.stdout, /Updated safely|agent_import/);
  const saved = await f.request('/files/content?resourceId=fs_live&path=%2Fhello.txt', {
    token: issued.body.secret,
  });
  assert.equal(saved.body.toString(), 'Updated safely');
  const js = await run(process.execPath, ['--input-type=module', '-e', examples.javascript], {
    env,
  });
  assert.match(js.stdout, /db_live/);
  const python = await run('python3', ['-c', examples.python], { env });
  assert.match(python.stdout, /fs_live/);
  assert.equal(
    (await f.request('/resources', { token: issued.body.workspaceKey })).body.error.code,
    'EXCHANGE_KEY_AT_GLOBAL',
  );
  // A Token and an untrusted Console Origin cannot become a Global Owner.
  const ownerDenied = await fetch(
    endpoints.global + '/api/v1/workspaces/' + endpoints.workspaceId + '/keys',
    { headers: { Authorization: 'Bearer ' + issued.body.secret } },
  );
  assert.equal(ownerDenied.status, 403);
  await ownerDenied.body.cancel();
  const localDenied = await fetch(endpoints.global + '/api/session', {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(localDenied.status, 403);
  await localDenied.body.cancel();
}
