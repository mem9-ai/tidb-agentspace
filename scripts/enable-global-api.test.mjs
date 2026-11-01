import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareGlobalCutover } from './enable-global-api.mjs';

test('Global cutover prepares independent identities while retaining all active Meta and provider configuration', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'global-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = (name, value) =>
    writeFile(resolve(root, name), JSON.stringify(value), { mode: 0o600 });
  const api = {
    bind: '127.0.0.1:4318',
    workspaceId: 'ws_existing',
    authorityId: 'region:existing',
    publicOrigins: ['http://127.0.0.1:4318'],
    publicPath: '',
    insecureLoopback: true,
    consoleOrigins: ['http://127.0.0.1:5173'],
    initializeWorkspace: false,
    metadata: { transport: 'inProcess', authorityId: 'region:existing' },
    product: { providers: { filesProvider: 'local' } },
  };
  await save('api.json', api);
  await save('global.json', {
    authorityId: 'global',
    s3: { prefix: 'retained/global' },
    encryptionKeyFile: '/retained/global-key',
  });
  const plan = {
    format: 1,
    services: [
      { kind: 'metadata', configFile: resolve(root, 'global.json') },
      { kind: 'workspace', configFile: resolve(root, 'api.json') },
    ],
  };
  await save('plan.json', plan);
  const sourceBefore = await readFile(resolve(root, 'plan.json'), 'utf8');
  const args = {
    sourcePlan: resolve(root, 'plan.json'),
    directory: resolve(root, 'prepared'),
    mountDirectory: '/run/workspace/prepared',
    clockDirectory: '/var/lib/workspace/security',
  };
  const result = await prepareGlobalCutover(args);
  assert.equal(result.globalBase, 'http://127.0.0.1:4318/api/global');
  const next = JSON.parse(await readFile(resolve(args.directory, 'api.json')));
  assert.deepEqual(next.product, api.product);
  assert.deepEqual(next.metadata, api.metadata);
  assert.equal(next.initializeWorkspace, false);
  const global = JSON.parse(await readFile(resolve(args.directory, 'global-api.json')));
  assert.equal(global.sharedListener, true);
  assert.equal(global.localWorkspace.workspaceId, api.workspaceId);
  assert.equal(next.security.globalIssuer, result.globalBase);
  assert.notEqual(
    await readFile(resolve(args.directory, 'security/global-signing.pub'), 'utf8'),
    await readFile(resolve(args.directory, 'security/region-signing.pub'), 'utf8'),
  );
  assert.equal(
    (await stat(resolve(args.directory, 'security/global-signing.der'))).mode & 0o077,
    0,
  );
  const prepared = JSON.parse(await readFile(result.plan));
  assert.deepEqual(prepared.services[0], plan.services[0]);
  assert.equal(await readFile(resolve(root, 'plan.json'), 'utf8'), sourceBefore);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, 'api.json'))), api);
  await assert.rejects(prepareGlobalCutover(args));
});
