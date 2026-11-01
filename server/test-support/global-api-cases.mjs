import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { port, until } from './meta-fixture.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { regionSecurityCases } from './region-security-cases.mjs';
import {
  createGlobalApiClient,
  exchangeGlobalKey,
  discoverAuthorizedRegions,
} from '../../src/api/global-client.ts';
const contract = JSON.parse(
  await readFile(new URL('../../public/global-openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });

// Uses an Owner session issued by the real verified OIDC fixture, not a local-owner bypass.
export async function globalApiCases(
  t,
  fixture,
  metadata,
  alice,
  bob,
  ownerFile,
  ssoSettings,
  regionMetadata,
) {
  const listen = await port();
  const origin = `http://127.0.0.1:${listen}`;
  const configFile = resolve(fixture.directory, 'global-api.json');
  const keyFile = resolve(fixture.directory, 'global-signing.der');
  const publicFile = resolve(fixture.directory, 'global-signing.pub');
  await writeFile(
    keyFile,
    Buffer.from('MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g', 'base64url'),
    { mode: 0o600 },
  );
  await writeFile(
    publicFile,
    Buffer.from('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', 'base64url').toString('hex'),
    { mode: 0o600 },
  );
  const config = {
    bind: `127.0.0.1:${listen}`,
    metadata: { transport: 'remote', client: metadata.clientConfig },
    publicOrigin: origin,
    environment: 'test',
    signerId: 'global-fixture',
    signingKeyFile: keyFile,
    verificationKeyFile: publicFile,
    clockDirectory: resolve(fixture.directory, 'global-clock'),
    initializeClock: true,
    regions: [
      { regionId: 'region:other', apiOrigin: 'https://region.example.test', apiPathPrefix: '' },
    ],
    sso: { ...ssoSettings, redirectUri: origin + '/api/auth/tidbcloud/callback' },
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const plan = resolve(fixture.directory, 'global-api-plan.json');
  await writeFile(plan, JSON.stringify({ format: 1, services: [{ kind: 'global', configFile }] }), {
    mode: 0o600,
  });
  let child;
  let exited;
  const start = async () => {
    const log = createWriteStream(resolve(fixture.directory, 'global-api.log'), {
      flags: 'a',
      mode: 0o600,
    });
    child = spawn(
      resolve('meta-service/target/debug/workspace-backend'),
      ['serve', '--config', plan],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.once('close', () => log.end());
    exited = new Promise((done) => child.once('exit', done));
    await until(async () => {
      const r = await fetch(origin + '/api/health');
      assert.equal(r.status, 200);
      await r.body.cancel();
    });
  };
  const stop = async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      await exited;
    }
  };
  t.after(stop);
  await start();
  const login = await fetch(origin + '/api/auth/tidbcloud/login?workspaceId=' + bob.workspaceId, {
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const authorize = new URL(login.headers.get('location'));
  const code = await fetch(authorize).then((r) => r.json());
  const callback =
    origin +
    '/api/auth/tidbcloud/callback?' +
    new URLSearchParams({ code: code.code, state: authorize.searchParams.get('state') });
  const flowCookie = login.headers.get('set-cookie').split(';')[0];
  const logged = await fetch(callback, { headers: { Cookie: flowCookie } });
  assert.equal(logged.status, 200, await logged.clone().text());
  const bobCookie = logged.headers
    .getSetCookie()
    .find((c) => c.startsWith('aw_global_owner='))
    .split(';')[0];
  await logged.body.cancel();
  const own = await fetch(origin + '/api/v1/workspaces/' + bob.workspaceId + '/keys', {
    headers: { Cookie: bobCookie },
  });
  assert.equal(own.status, 200);
  await own.body.cancel();
  const replay = await fetch(callback, { headers: { Cookie: flowCookie } });
  assert.equal(replay.status, 401);
  await replay.body.cancel();
  const logout = await fetch(origin + '/api/auth/tidbcloud/logout?workspaceId=' + bob.workspaceId, {
    method: 'POST',
    headers: { Cookie: bobCookie, Origin: origin },
  });
  assert.equal(logout.status, 204);
  const denied = await fetch(origin + '/api/v1/workspaces/' + bob.workspaceId + '/keys', {
    headers: { Cookie: bobCookie },
  });
  assert.equal(denied.status, 401);
  await denied.body.cancel();
  const cookie = `aw_global_owner=${await readFile(ownerFile, 'utf8')}`;
  const base = `/api/v1/workspaces/${alice.workspaceId}`;
  const request = async (
    route,
    { method = 'GET', body, token, headers = {}, workspace = alice.workspaceId } = {},
  ) => {
    const r = await fetch(origin + `/api/v1/workspaces/${workspace}` + route, {
      method,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bodyResult = await r.json();
    const pathname = new URL(r.url).pathname;
    const entry = Object.entries(contract.paths).find(([path]) =>
      new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(pathname),
    )?.[1]?.[method.toLowerCase()];
    assert.ok(entry, method + ' ' + pathname + ' must be documented');
    const schema = (entry.responses[r.status] ?? entry.responses.default).content[
      'application/json'
    ].schema;
    const validate = ajv.compile({ ...schema, components: contract.components });
    assert.ok(validate(bodyResult), ajv.errorsText(validate.errors));
    return { status: r.status, body: bodyResult, headers: r.headers };
  };
  const input = {
    scopes: ['resources:read', 'files:read'],
    resourceIds: ['fs_existing'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const operation = randomUUID();
  const created = await request('/keys', {
    method: 'POST',
    body: input,
    headers: { 'Idempotency-Key': operation },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.secret, /^awk_/);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(
    new URL(created.headers.get('location'), origin + base + '/keys').pathname,
    base + '/keys/' + created.body.data.keyId,
  );
  const client = createGlobalApiClient(origin, [origin]);
  const clientToken = await exchangeGlobalKey(client, alice.workspaceId, created.body.secret, [
    'resources:read',
  ]);
  assert.equal(
    (await discoverAuthorizedRegions(client, alice.workspaceId, clientToken.accessToken))[0]
      .regionId,
    'region:other',
  );
  const key = created.body.data.keyId;
  let secret = created.body.secret;
  assert.equal(
    (
      await request('/keys', {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': operation },
      })
    ).status,
    409,
  );
  assert.equal((await request('/keys', { workspace: bob.workspaceId })).status, 401);
  assert.equal(
    (
      await request('/keys', {
        method: 'POST',
        body: input,
        headers: { Origin: 'https://hostile.example', 'Idempotency-Key': randomUUID() },
      })
    ).status,
    403,
  );
  assert.equal((await request('/keys', { token: secret })).status, 403);
  const detail = await request(`/keys/${key}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.verifier, undefined);
  assert.deepEqual(detail.body.grants.resourceIds, ['fs_existing']);
  assert.equal((await request('/keys?limit=1')).body.data.length, 1);
  const issue = await request('/token-issuances', {
    method: 'POST',
    token: secret,
    body: { audience: 'global', scopes: ['resources:read'] },
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  assert.equal(issue.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await request('/regions', { token: issue.body.accessToken })).body.data[0].regionId,
    'region:other',
  );
  assert.equal(
    (await request(`/token-issuances/${issue.body.id}`, { token: issue.body.accessToken })).body
      .data.accessToken,
    undefined,
  );
  assert.equal(
    (
      await request('/token-issuances', {
        method: 'POST',
        token: secret,
        body: { audience: 'global', scopes: ['queries:execute'] },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/token-issuances', {
        method: 'POST',
        token: secret,
        body: { audience: 'region:other' },
      })
    ).status,
    409,
  );
  await stop();
  config.initializeClock = false;
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await start();
  assert.equal((await request('/regions', { token: issue.body.accessToken })).status, 200);
  assert.equal((await request(`/keys/${key}`)).body.data.keyVersion, 1);
  const rotated = await request(`/keys/${key}/versions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(rotated.status, 201);
  assert.notEqual(rotated.body.secret, secret);
  assert.equal(
    (
      await request('/token-issuances', {
        method: 'POST',
        token: secret,
        body: { audience: 'global' },
      })
    ).status,
    401,
  );
  secret = rotated.body.secret;
  assert.equal((await request(`/keys/${key}/versions/1`)).body.data.keyVersion, 1);
  const beforeRenewal = await exchangeGlobalKey(client, alice.workspaceId, secret, [
    'resources:read',
  ]);
  const renewed = await request(`/keys/${key}`, {
    method: 'PATCH',
    body: { expiresAt: input.expiresAt + 3600 },
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' },
  });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal((await request('/regions', { token: beforeRenewal.accessToken })).status, 401);
  assert.equal((await request('/regions', { token: issue.body.accessToken })).status, 401);
  assert.equal(
    (
      await request('/token-issuances', {
        method: 'POST',
        token: secret,
        body: { audience: 'global' },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(`/keys/${key}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' },
      })
    ).status,
    412,
  );
  const revoked = await request(`/keys/${key}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"3"' },
  });
  assert.equal(revoked.status, 202);
  assert.equal(
    (
      await request('/token-issuances', {
        method: 'POST',
        token: secret,
        body: { audience: 'global' },
      })
    ).status,
    401,
  );
  let metadataOwner;
  const preserved = await regionSecurityCases(t, fixture, regionMetadata, alice.workspaceId, {
    origin,
    publicFile,
    request,
    configure: async (regionOrigin, controlOrigin, tls) => {
      await stop();
      config.regions[0].apiOrigin = regionOrigin;
      config.regionControls = [
        { regionId: regionMetadata.server.authorityId, origin: controlOrigin, tls },
      ];
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      await start();
    },
    crash: async () => {
      child.kill('SIGKILL');
      await exited;
      assert.equal(child.signalCode, 'SIGKILL');
      metadataOwner = (await metadata.client.health()).ownerId;
      await metadata.stop('SIGKILL');
      metadata.client.close();
    },
  });
  metadata = await fixture.service('restored-global', {
    previous: metadata,
    recoverOwner: metadataOwner,
  });
  config.metadata.client = metadata.clientConfig;
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await start();
  const recovered = await request('/token-issuances', {
    method: 'POST',
    token: preserved.secret,
    body: { audience: 'global' },
  });
  assert.equal(recovered.status, 201);
  assert.equal((await request('/keys/' + preserved.keyId)).body.data.grantRef, preserved.grantRef);
  await stop();
  return metadata;
}
