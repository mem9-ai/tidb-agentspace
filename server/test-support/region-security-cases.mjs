import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose';
import { metadataCertificates } from './meta-tls.mjs';
import { providerFixture } from './provider-fixture.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { connectAgent } from '../../src/api/agent-client.ts';
const contract = JSON.parse(
  await readFile(new URL('../../public/openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const securityOperations = new Set([
  'enrollRegionalRefreshFamily',
  'issueRegionalToken',
  'getRegionalRefreshFamily',
  'revokeRegionalRefreshFamily',
  'getRegionalTokenIssuance',
  'revokeRegionalAccessToken',
]);
import { port, until } from './meta-fixture.mjs';

export async function regionSecurityCases(t, fixture, metadata, workspace, global) {
  const stored = new Map();
  const credentials = new Map();
  const provider = await providerFixture({
    requireFileAuth: true,
    onSql: ({ binding, sql }) => {
      const identity = binding.kind + ':' + binding.user;
      if (credentials.has(identity)) assert.equal(binding.password, credentials.get(identity));
      else credentials.set(identity, binding.password);
      if (sql === 'INSERT INTO continuity VALUES (7)') {
        stored.set(binding.kind, 7);
        return { body: { columns: [], rows: [], rowCount: 0, affectedRows: 1 } };
      }
      if (sql === 'SELECT value FROM continuity')
        return {
          body: {
            columns: ['value'],
            rows: stored.has(binding.kind) ? [{ value: stored.get(binding.kind) }] : [],
            rowCount: stored.has(binding.kind) ? 1 : 0,
            affectedRows: 0,
          },
        };
    },
  });
  let child, exited;
  const stop = async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      await exited;
    }
  };
  t.after(async () => {
    await stop();
    await provider.close();
  });
  const listen = await port(),
    controlPort = await port(),
    unusedLegacyControlPort = await port();
  const origin = `http://127.0.0.1:${listen}`;
  const certificates = await metadataCertificates(fixture.directory);
  const keys = generateKeyPairSync('ed25519');
  const signing = resolve(fixture.directory, 'region-token.der'),
    publicFile = resolve(fixture.directory, 'region-token.pub');
  await writeFile(signing, keys.privateKey.export({ format: 'der', type: 'pkcs8' }), {
    mode: 0o600,
  });
  await writeFile(
    publicFile,
    Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'),
    { mode: 0o600 },
  );
  const config = {
    bind: `127.0.0.1:${listen}`,
    workspaceId: workspace,
    authorityId: metadata.server.authorityId,
    insecureLoopback: true,
    consoleOrigins: [global.origin],
    publicOrigins: [origin],
    metadata: { transport: 'remote', client: metadata.clientConfig },
    product: {
      providers: {
        filesProvider: 'drive9-anonymous',
        mysqlProvider: 'tidb-cloud-zero',
        postgresProvider: 'local',
        testMode: true,
        drive9Endpoint: provider.origin,
        zeroEndpoint: provider.origin + '/zero',
        sqlFixture: provider.origin + '/sql',
      },
    },
    security: {
      publicOrigin: origin,
      environment: 'test',
      globalIssuer: global.origin,
      globalSignerId: 'global-fixture',
      globalPublicKeyFile: global.publicFile,
      regionalSignerId: 'region-fixture',
      regionalSigningKeyFile: signing,
      regionalPublicKeyFile: publicFile,
      metadataSecurityState: true,
      initializeClock: true,
      accessTokenTtl: 3,
      control: {
        bind: `127.0.0.1:${unusedLegacyControlPort}`,
        ...certificates.server,
        globalClientCertificates: [certificates.client.certificateFile],
      },
      regionConnection: { origin: `https://127.0.0.1:${controlPort}`, tls: certificates.client },
    },
  };
  const configFile = resolve(fixture.directory, 'regional-security.json'),
    plan = resolve(fixture.directory, 'regional-security-plan.json');
  await writeFile(
    plan,
    JSON.stringify({ format: 1, services: [{ kind: 'workspace', configFile }] }),
    { mode: 0o600 },
  );
  const start = async () => {
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const log = createWriteStream(resolve(fixture.directory, 'regional-security.log'), {
      mode: 0o600,
      flags: 'a',
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
    try {
      await until(async () => {
        const r = await fetch(origin + '/api/health');
        assert.equal(r.status, 200);
        await r.body.cancel();
      });
    } catch (error) {
      t.diagnostic(await readFile(resolve(fixture.directory, 'regional-security.log'), 'utf8'));
      throw error;
    }
  };
  await start();
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  await session.body.cancel();
  const covered = new Set();
  const request = async (
    route,
    { method = 'GET', body, token, proof, raw, workspaceId = workspace } = {},
  ) => {
    const securityRoute = ['/refresh-families', '/token-issuances', '/access-tokens'].some(
      (prefix) => route.startsWith(prefix),
    );
    const api = token || securityRoute ? '/api/v1' : '/api/portal/v1';
    const r = await fetch(origin + `${api}/workspaces/${workspaceId}` + route, {
      method,
      redirect: 'error',
      headers: {
        'Content-Type': raw ? 'application/octet-stream' : 'application/json',
        Origin: origin,
        ...(token ? { Authorization: token } : { Cookie: cookie }),
        ...(proof ? { DPoP: proof } : {}),
      },
      ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = r.headers.get('content-type')?.includes('application/json')
      ? await r.json()
      : Buffer.from(await r.arrayBuffer());
    if (
      ['/refresh-families', '/token-issuances', '/access-tokens'].some((prefix) =>
        route.startsWith(prefix),
      )
    ) {
      const pathname = '/workspaces/' + workspace + route.split('?')[0];
      const operation = Object.entries(contract.paths).find(([path]) =>
        new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(pathname),
      )?.[1]?.[method.toLowerCase()];
      assert.ok(
        operation && securityOperations.has(operation.operationId),
        'Security operation must be documented',
      );
      if (r.status === 204) assert.equal(value.length, 0);
      else {
        const schema = (operation.responses[r.status] ?? operation.responses.default).content[
          'application/json'
        ].schema;
        const validate = ajv.compile({ ...schema, components: contract.components });
        assert.ok(validate(value), ajv.errorsText(validate.errors));
      }
      if (r.ok) covered.add(operation.operationId);
    }
    return { status: r.status, body: value };
  };
  await global.configure(
    origin,
    `https://127.0.0.1:${controlPort}`,
    certificates.client,
    certificates.server,
  );
  const onboarded = await global.firstLogin();
  const setupKey = await global.request('/keys', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: {
      scopes: ['resources:read', 'resources:write'],
      resourceIds: ['*'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  assert.equal(setupKey.status, 201, JSON.stringify(setupKey.body));
  const setupAccess = await global.request('/token-issuances', {
    method: 'POST',
    token: setupKey.body.secret,
    body: {
      audience: metadata.server.authorityId,
      clientThumbprint: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
    },
  });
  assert.equal(setupAccess.status, 201, JSON.stringify(setupAccess.body));
  const mysql = await request('/resources', {
    method: 'POST',
    token: 'Bearer ' + setupAccess.body.accessToken,
    body: { kind: 'mysql', name: 'continuity-db', region: 'automatic' },
  });
  assert.equal(mysql.status, 201, JSON.stringify(mysql.body));
  assert.equal(mysql.body.data.status, 'active');
  assert.equal(mysql.body.data.regionId, metadata.server.authorityId);
  const fs = await request('/resources', {
    method: 'POST',
    token: 'Bearer ' + setupAccess.body.accessToken,
    body: { kind: 'filesystem', name: 'continuity-fs', region: 'aws-ap-southeast-1' },
  });
  assert.equal(fs.status, 201, JSON.stringify(fs.body));
  assert.equal(fs.body.data.status, 'active');
  assert.equal(fs.body.data.regionId, metadata.server.authorityId);
  assert.equal(
    (await request('', { token: 'Bearer ' + setupAccess.body.accessToken })).body.data
      .defaultRegionId,
    metadata.server.authorityId,
  );
  const misplaced = await request('/resources', {
    method: 'POST',
    token: 'Bearer ' + setupAccess.body.accessToken,
    body: {
      kind: 'mysql',
      name: 'wrong-region',
      region: 'automatic',
      regionId: 'region:elsewhere',
    },
  });
  assert.equal(misplaced.status, 400);
  const resources = [mysql.body.data.id, fs.body.data.id];
  assert.equal((await request('/keys', { method: 'POST', body: {} })).status, 404);
  assert.equal(
    (await request('/resources', { token: 'Bearer retired-workspace-key' })).status,
    401,
  );
  const data = async (token, renewAccess) => {
    // The deliberately short-lived access token is used to test expiry. During the
    // longer outage/restart journey, renew before each operation rather than
    // assuming four real storage operations finish inside that three-second TTL.
    const access = async () => (renewAccess ? 'Bearer ' + (await renewAccess()) : token);
    const insert = await request('/queries', {
      method: 'POST',
      token: await access(),
      body: { resourceId: resources[0], sql: 'INSERT INTO continuity VALUES (7)' },
    });
    assert.equal(insert.status, 200, JSON.stringify(insert.body));
    const rows = await request('/queries', {
      method: 'POST',
      token: await access(),
      body: { resourceId: resources[0], sql: 'SELECT value FROM continuity' },
    });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    assert.deepEqual(rows.body.rows, [{ value: 7 }]);
    const path =
      '/files/content?' +
      new URLSearchParams({ resourceId: resources[1], path: '/continuity.bin' });
    const put = await request(path, {
      method: 'PUT',
      token: await access(),
      raw: Buffer.from([0, 255, 7]),
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await request(path, { token: await access() });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, Buffer.from([0, 255, 7]));
  };
  const creates = { ...provider.nativeCreates };
  const fileCreates = provider.creates;
  const credentialCount = credentials.size;
  await stop();
  config.managedWorkspaceLimit = 16;
  config.security.initializeClock = false;
  await start();
  await global.verifyPortalSession(onboarded, origin);
  assert.equal(
    (await request('/resources', { token: 'Bearer retired-workspace-key' })).status,
    401,
  );
  const globalRequest = global.request;
  await global.setDelivery(false);
  const pendingKey = await globalRequest('/keys', {
    method: 'POST',
    body: {
      scopes: ['resources:read'],
      resourceIds: resources,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(pendingKey.status, 201);
  assert.equal(pendingKey.body.regionalStatus, 'pending');
  const revokedPending = await globalRequest('/keys/' + pendingKey.body.data.keyId, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(revokedPending.status, 202);
  assert.equal(revokedPending.body.regionalStatus, 'pending');
  const deliveryId = randomUUID();
  const deliver = () =>
    globalRequest('/key-policy-deliveries', {
      method: 'POST',
      body: { keyId: pendingKey.body.data.keyId, keyVersion: 2 },
      headers: { 'Idempotency-Key': deliveryId },
    });
  assert.equal((await deliver()).body.data.regionalStatus, 'pending');
  assert.equal(
    (await globalRequest('/key-policy-deliveries/' + deliveryId, { token: pendingKey.body.secret }))
      .status,
    403,
  );
  await global.configure(
    origin,
    `https://127.0.0.1:${controlPort}`,
    certificates.client,
    certificates.server,
  );
  assert.equal((await deliver()).body.data.regionalStatus, 'applied');
  assert.equal(
    (await globalRequest('/key-policy-deliveries/' + deliveryId)).body.data.regionalStatus,
    'applied',
  );
  assert.equal(
    (await globalRequest('/key-revocations/' + revokedPending.body.id)).body.data.regionalStatus,
    'applied',
  );
  const reconnectKey = await globalRequest('/keys', {
    method: 'POST',
    body: {
      scopes: ['resources:read'],
      resourceIds: resources,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(reconnectKey.status, 201, JSON.stringify(reconnectKey.body));
  assert.equal(reconnectKey.body.regionalStatus, 'applied');
  await stop();
  const disconnectedRevoke = await globalRequest('/keys/' + reconnectKey.body.data.keyId, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(disconnectedRevoke.status, 202);
  assert.equal(disconnectedRevoke.body.regionalStatus, 'pending');
  // The reconciliation intent must survive Global process restart while Region is offline.
  await global.configure(
    origin,
    `https://127.0.0.1:${controlPort}`,
    certificates.client,
    certificates.server,
  );
  await start();
  await until(async () => {
    const state = await globalRequest('/keys/' + reconnectKey.body.data.keyId);
    assert.equal(state.body.regionalStatus, 'applied');
  });
  assert.equal(
    (
      await globalRequest('/token-issuances', {
        method: 'POST',
        token: reconnectKey.body.secret,
        body: { audience: metadata.server.authorityId },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await globalRequest('/token-issuances', {
        method: 'POST',
        token: pendingKey.body.secret,
        body: { audience: 'global' },
      })
    ).status,
    401,
  );
  const created = await globalRequest('/keys', {
    method: 'POST',
    body: {
      scopes: ['resources:read', 'queries:execute', 'files:read', 'files:write'],
      resourceIds: resources,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.regionalStatus, 'applied', JSON.stringify(created.body));
  const client = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(client.publicKey);
  const thumbprint = await calculateJwkThumbprint(jwk);
  const issue = await globalRequest('/token-issuances', {
    method: 'POST',
    token: created.body.secret,
    body: { audience: metadata.server.authorityId, clientThumbprint: thumbprint },
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));
  await data('Bearer ' + issue.body.accessToken);
  const proof = async (route, nonce, workspaceId = workspace) =>
    new SignJWT({
      jti: randomUUID(),
      htm: 'POST',
      htu: origin + `/api/v1/workspaces/${workspaceId}` + route,
      nonce,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
      .sign(client.privateKey);
  const otherIssued = await globalRequest('/token-issuances', {
    method: 'POST',
    workspace: global.otherWorkspace,
    token: global.otherKey,
    body: { audience: metadata.server.authorityId, clientThumbprint: thumbprint },
  });
  assert.equal(otherIssued.status, 201, JSON.stringify(otherIssued.body));
  const otherVisible = await request('/resources', {
    workspaceId: global.otherWorkspace,
    token: 'Bearer ' + otherIssued.body.accessToken,
  });
  assert.equal(otherVisible.status, 200, JSON.stringify(otherVisible.body));
  const otherWorkspaces = await fetch(origin + '/api/v1/workspaces', {
    headers: { Authorization: 'Bearer ' + otherIssued.body.accessToken },
  });
  assert.equal(otherWorkspaces.status, 200);
  assert.deepEqual(
    (await otherWorkspaces.json()).data.map((item) => item.id),
    [global.otherWorkspace],
  );
  assert.equal(
    otherVisible.body.data.some((item) => resources.includes(item.id)),
    false,
  );
  assert.equal(
    (
      await request('/resources', {
        workspaceId: global.otherWorkspace,
        token: 'Bearer ' + issue.body.accessToken,
      })
    ).status,
    401,
  );
  assert.equal(
    (await request('/resources', { token: 'Bearer ' + otherIssued.body.accessToken })).status,
    401,
  );
  const otherEnrollment = await request('/refresh-families', {
    workspaceId: global.otherWorkspace,
    method: 'POST',
    body: { ticket: otherIssued.body.enrollmentTicket },
    proof: await proof('/refresh-families', otherIssued.body.nonce, global.otherWorkspace),
  });
  assert.equal(otherEnrollment.status, 201, JSON.stringify(otherEnrollment.body));
  const crossFamily = await request('/token-issuances', {
    method: 'POST',
    body: { keyId: otherEnrollment.body.keyId },
    token: 'Refresh ' + otherEnrollment.body.refreshCredential,
    proof: await proof('/token-issuances', otherEnrollment.body.nonce),
  });
  assert.ok([401, 404].includes(crossFamily.status));
  let otherRefresh = otherEnrollment.body;
  const renewOther = async () => {
    const response = await request('/token-issuances', {
      workspaceId: global.otherWorkspace,
      method: 'POST',
      body: { keyId: otherRefresh.keyId },
      token: 'Refresh ' + otherRefresh.refreshCredential,
      proof: await proof('/token-issuances', otherRefresh.nonce, global.otherWorkspace),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    otherRefresh = response.body;
    assert.equal(
      (
        await request('/resources', {
          workspaceId: global.otherWorkspace,
          token: 'Bearer ' + response.body.accessToken,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request('/resources', { token: 'Bearer ' + response.body.accessToken })).status,
      401,
    );
  };
  await renewOther();
  const enrolled = await request('/refresh-families', {
    method: 'POST',
    body: { ticket: issue.body.enrollmentTicket },
    proof: await proof('/refresh-families', issue.body.nonce),
  });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  let refresh = enrolled.body;
  const renew = async () => {
    const result = await request('/token-issuances', {
      method: 'POST',
      token: 'Refresh ' + refresh.refreshCredential,
      proof: await proof('/token-issuances', refresh.nonce),
      body: { keyId: created.body.data.keyId },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    refresh = result.body;
    return result.body.accessToken;
  };
  let token = await renew();
  await data('Bearer ' + token);
  const familyStatus = await request('/refresh-families/' + refresh.familyId, {
    token: 'Bearer ' + token,
  });
  assert.equal(familyStatus.status, 200);
  assert.equal(familyStatus.body.data.verifier, undefined);
  const issuanceStatus = await request('/token-issuances/' + refresh.id, {
    token: 'Bearer ' + token,
  });
  assert.equal(issuanceStatus.status, 200);
  assert.equal(issuanceStatus.body.data.accessToken, undefined);
  const denial = await request('/access-tokens/' + refresh.id.split('.')[1], {
    method: 'DELETE',
    token: 'Bearer ' + token,
  });
  assert.equal(denial.status, 204);
  assert.equal((await request('/resources', { token: 'Bearer ' + token })).status, 401);
  await renew();
  const otherTicket = await globalRequest('/token-issuances', {
    method: 'POST',
    token: created.body.secret,
    body: { audience: metadata.server.authorityId, clientThumbprint: thumbprint },
  });
  assert.equal(otherTicket.status, 201);
  const otherFamily = await request('/refresh-families', {
    method: 'POST',
    body: { ticket: otherTicket.body.enrollmentTicket },
    proof: await proof('/refresh-families', otherTicket.body.nonce),
  });
  assert.equal(otherFamily.status, 201);
  const otherToken = await request('/token-issuances', {
    method: 'POST',
    token: 'Refresh ' + otherFamily.body.refreshCredential,
    proof: await proof('/token-issuances', otherFamily.body.nonce),
    body: { keyId: created.body.data.keyId },
  });
  assert.equal(otherToken.status, 201);
  assert.equal(
    (
      await request('/refresh-families/' + otherFamily.body.familyId, {
        method: 'DELETE',
        token: 'Bearer ' + otherToken.body.accessToken,
      })
    ).status,
    204,
  );
  assert.equal(
    (await request('/resources', { token: 'Bearer ' + otherToken.body.accessToken })).status,
    401,
  );
  token = await renew();
  await data('Bearer ' + token);
  assert.deepEqual([...covered].sort(), [...securityOperations].sort());
  const shortExpiry = Math.floor(Date.now() / 1000) + 15;
  const shortKey = async () => {
    const result = await globalRequest('/keys', {
      method: 'POST',
      body: { scopes: ['resources:read'], resourceIds: resources, expiresAt: shortExpiry },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const issued = await globalRequest('/token-issuances', {
      method: 'POST',
      token: result.body.secret,
      body: { audience: metadata.server.authorityId, clientThumbprint: thumbprint },
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const family = await request('/refresh-families', {
      method: 'POST',
      body: { ticket: issued.body.enrollmentTicket },
      proof: await proof('/refresh-families', issued.body.nonce),
    });
    assert.equal(family.status, 201, JSON.stringify(family.body));
    return { key: result.body, family: family.body };
  };
  const fixed = await shortKey();
  const late = await shortKey();
  const tryRefresh = async (item, clientProof = true) =>
    request('/token-issuances', {
      method: 'POST',
      token: 'Refresh ' + item.family.refreshCredential,
      proof: clientProof ? await proof('/token-issuances', item.family.nonce) : undefined,
      body: { keyId: item.key.data.keyId },
    });
  assert.equal((await tryRefresh(late, false)).status, 401);
  await global.setDelivery(false);
  const undelivered = await globalRequest('/keys/' + late.key.data.keyId, {
    method: 'PATCH',
    body: { expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(undelivered.status, 200, JSON.stringify(undelivered.body));
  assert.equal(undelivered.body.regionalStatus, 'pending');
  await delay(Math.max(0, (shortExpiry + 1) * 1000 - Date.now()));
  assert.equal((await tryRefresh(fixed)).status, 401, 'Actual Key expiry denies local refresh');
  assert.equal((await tryRefresh(late)).status, 401, 'Undelivered renewal cannot be inferred');
  await global.setDelivery(true);
  const lateAttempt = await globalRequest('/key-policy-deliveries', {
    method: 'POST',
    body: { keyId: late.key.data.keyId, keyVersion: 2 },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(lateAttempt.status, 201, JSON.stringify(lateAttempt.body));
  assert.equal(lateAttempt.body.data.regionalStatus, 'applied');
  assert.equal(lateAttempt.body.data.regionalContinuity, 'unavailable');
  assert.equal(
    (await tryRefresh(late)).status,
    401,
    'Late delivery never reinstates the expired transition proof',
  );
  let saved;
  let globalCalls = 0;
  let refreshCalls = 0;
  let globalDown = false;
  const sdkExpiry = Math.floor(Date.now() / 1000) + 30;
  const sdkKey = await globalRequest('/keys', {
    method: 'POST',
    body: {
      scopes: ['resources:read', 'queries:execute', 'files:read', 'files:write'],
      resourceIds: resources,
      expiresAt: sdkExpiry,
    },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(sdkKey.status, 201, JSON.stringify(sdkKey.body));
  assert.equal(sdkKey.body.regionalStatus, 'applied');
  const sdkOptions = {
    endpoint: global.origin + '/api',
    key: sdkKey.body.secret,
    proofKey: client,
    secrets: {
      load: async () => saved && structuredClone(saved),
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
    fetcher: async (input, init) => {
      const r = new Request(input, init);
      const target = new URL(r.url);
      if (target.origin === global.origin) {
        globalCalls++;
        assert.equal(globalDown, false, 'Cached client must never contact Global');
      } else {
        assert.equal(target.origin, origin);
        if (target.pathname.endsWith('/token-issuances')) refreshCalls++;
        assert.equal(r.credentials, 'omit');
        assert.equal((r.headers.get('authorization') ?? '').includes(created.body.secret), false);
        assert.equal((r.headers.get('authorization') ?? '').includes(sdkKey.body.secret), false);
      }
      return fetch(r);
    },
  };
  const agent = await connectAgent(sdkOptions);
  const beforeConcurrentRefresh = refreshCalls;
  await Promise.all([agent.renew(), agent.renew(), agent.renew()]);
  assert.equal(refreshCalls - beforeConcurrentRefresh, 1);
  assert.equal(saved.state, 'ready');
  assert.equal(JSON.stringify(saved).includes(created.body.secret), false);
  assert.equal(JSON.stringify(saved).includes(sdkKey.body.secret), false);
  const sdkData = async (connection) => {
    const result = await connection.client.POST('/workspaces/{workspaceId}/queries', {
      params: { path: { workspaceId: workspace } },
      body: { resourceId: resources[0], sql: 'SELECT value FROM continuity' },
    });
    assert.deepEqual(result.data.rows, [{ value: 7 }]);
    const write = await connection.client.PUT('/workspaces/{workspaceId}/files', {
      params: { path: { workspaceId: workspace } },
      body: { resourceId: resources[1], path: '/sdk.txt', type: 'file', content: 'SDK continuity' },
    });
    assert.equal(write.response.status, 200);
  };
  await sdkData(agent);
  const extended = await globalRequest('/keys/' + sdkKey.body.data.keyId, {
    method: 'PATCH',
    body: { expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    headers: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(extended.status, 200, JSON.stringify(extended.body));
  assert.equal(extended.body.regionalStatus, 'applied');
  assert.equal(extended.body.regionalContinuity, 'eligible');
  assert.equal(extended.body.data.keyVersion, 2);
  const beforeOutageCalls = globalCalls;
  await global.crash();
  globalDown = true;
  await delay(Math.max(4000, (sdkExpiry + 1) * 1000 - Date.now()));
  const expired = await request('/resources', { token: 'Bearer ' + token });
  assert.equal(expired.status, 401);
  token = await renew();
  assert.equal(
    (await request('', { token: 'Bearer ' + token })).body.data.defaultRegionId,
    metadata.server.authorityId,
  );
  const regionResources = await request('/resources', { token: 'Bearer ' + token });
  assert.equal(regionResources.status, 200);
  assert.ok(
    regionResources.body.data.every((item) => item.regionId === metadata.server.authorityId),
  );
  await data('Bearer ' + token, renew);
  await renewOther();
  await sdkData(agent);
  assert.equal(saved.expiresAt, extended.body.data.expiresAt);
  assert.equal(globalCalls, beforeOutageCalls);
  await stop();
  config.security.initializeClock = false;
  await start();
  token = await renew();
  await data('Bearer ' + token, renew);
  assert.equal(
    (await request('/resources', { token: 'Bearer retired-workspace-key' })).status,
    401,
  );
  await renewOther();
  const resumed = await connectAgent(sdkOptions);
  await sdkData(resumed);
  assert.equal(globalCalls, beforeOutageCalls);
  assert.deepEqual(provider.nativeCreates, creates);
  assert.equal(provider.creates, fileCreates);
  assert.equal(credentials.size, credentialCount);
  await stop();
  return {
    keyId: sdkKey.body.data.keyId,
    secret: sdkKey.body.secret,
    grantRef: sdkKey.body.data.grantRef,
  };
}
