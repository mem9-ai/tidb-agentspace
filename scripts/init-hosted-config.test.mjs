import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initializeHostedConfig } from './init-hosted-config.mjs';

test('fresh hosted plans isolate S3 roots and keys, use native SSO and refuse overwrite', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'native-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    s3: { endpoint: 'https://s3.example.test', region: 'example', bucket: 'existing-bucket' },
    publicOrigin: 'https://studio.example.test',
    sso: {
      issuer: 'https://identity.example.test/',
      clientId: 'public-client',
      ownerSubjects: ['subject'],
    },
  };
  const directory = resolve(root, 'configuration');
  const args = { directory, mountDirectory: '/run/workspace', input };
  const result = await initializeHostedConfig(args);
  const global = JSON.parse(await readFile(resolve(directory, 'global.json')));
  const region = JSON.parse(await readFile(resolve(directory, 'region.json')));
  const api = JSON.parse(await readFile(resolve(directory, 'api.json')));
  assert.notEqual(global.s3.prefix, region.s3.prefix);
  assert.ok(global.s3.prefix.includes(result.installation));
  assert.notEqual(
    await readFile(resolve(directory, 'global-key'), 'utf8'),
    await readFile(resolve(directory, 'region-key'), 'utf8'),
  );
  assert.equal(api.insecureLoopback, false);
  const publicGlobal = JSON.parse(await readFile(resolve(directory, 'global-api.json')));
  assert.equal(publicGlobal.sharedListener, true);
  assert.equal(publicGlobal.publicPath, '/studio/api/global');
  assert.equal(publicGlobal.sso, undefined, 'bundled Portal retains one OIDC callback');
  assert.equal(publicGlobal.localWorkspace, undefined);
  assert.equal(api.security.globalIssuer, input.publicOrigin + '/studio/api/global');
  assert.equal(api.security.initializeClock, false);
  assert.equal(
    api.sso.redirectUri,
    'https://studio.example.test/studio/api/auth/tidbcloud/callback',
  );
  assert.equal((await stat(resolve(directory, 'region-key'))).mode & 0o077, 0);
  await assert.rejects(initializeHostedConfig(args));
  const second = await initializeHostedConfig({ ...args, directory: resolve(root, 'second') });
  assert.notEqual(second.installation, result.installation);
  await assert.rejects(
    initializeHostedConfig({
      ...args,
      directory: resolve(root, 'invalid'),
      input: { ...input, publicOrigin: 'http://public.example' },
    }),
  );
});
