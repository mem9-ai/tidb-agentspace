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
import { connectAgentWorkspace } from '../../src/api/agent-client.ts';
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
    controlPort = await port();
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
    consoleOrigins: [],
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
      clockDirectory: resolve(fixture.directory, 'regional-security-clock'),
      initializeClock: true,
      accessTokenTtl: 3,
      control: {
        bind: `127.0.0.1:${controlPort}`,
        ...certificates.server,
        globalClientCertificates: [certificates.client.certificateFile],
      },
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
  const base = `/api/v1/workspaces/${workspace}`;
  const covered = new Set();
  const request = async (route, { method = 'GET', body, token, proof, raw } = {}) => {
    const r = await fetch(origin + base + route, {
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
  const mysql = await request('/resources', {
    method: 'POST',
    body: { kind: 'mysql', name: 'continuity-db', region: 'automatic' },
  });
  assert.equal(mysql.status, 201, JSON.stringify(mysql.body));
  assert.equal(mysql.body.data.status, 'active');
  const fs = await request('/resources', {
    method: 'POST',
    body: { kind: 'filesystem', name: 'continuity-fs', region: 'aws-ap-southeast-1' },
  });
  assert.equal(fs.status, 201, JSON.stringify(fs.body));
  assert.equal(fs.body.data.status, 'active');
  const resources = [mysql.body.data.id, fs.body.data.id];
  const oldKey = await request('/keys', {
    method: 'POST',
    body: {
      name: 'before-global-security',
      scopes: ['resources:read', 'queries:execute', 'files:read', 'files:write'],
      resourceIds: resources,
      expiresInDays: 7,
    },
  });
  assert.equal(oldKey.status, 201);
  const data = async (token) => {
    const insert = await request('/queries', {
      method: 'POST',
      token,
      body: { resourceId: resources[0], sql: 'INSERT INTO continuity VALUES (7)' },
    });
    assert.equal(insert.status, 200, JSON.stringify(insert.body));
    const rows = await request('/queries', {
      method: 'POST',
      token,
      body: { resourceId: resources[0], sql: 'SELECT value FROM continuity' },
    });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    assert.deepEqual(rows.body.rows, [{ value: 7 }]);
    const path =
      '/files/content?' +
      new URLSearchParams({ resourceId: resources[1], path: '/continuity.bin' });
    const put = await request(path, { method: 'PUT', token, raw: Buffer.from([0, 255, 7]) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await request(path, { token });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, Buffer.from([0, 255, 7]));
  };
  await data('Bearer ' + oldKey.body.secret);
  const creates = { ...provider.nativeCreates };
  const fileCreates = provider.creates;
  const credentialCount = credentials.size;
  await global.configure(origin, `https://127.0.0.1:${controlPort}`, certificates.client);
  const globalRequest = global.request;
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
  const proof = async (route, nonce) =>
    new SignJWT({
      jti: randomUUID(),
      htm: 'POST',
      htu: origin + base + route,
      nonce,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
      .sign(client.privateKey);
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
  let saved;
  let globalCalls = 0;
  let refreshCalls = 0;
  let globalDown = false;
  const sdkOptions = {
    globalOrigin: global.origin,
    trustedGlobalOrigins: [global.origin],
    trustedRegionOrigins: [origin],
    workspaceId: workspace,
    regionId: metadata.server.authorityId,
    workspaceKey: created.body.secret,
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
      }
      return fetch(r);
    },
  };
  const agent = await connectAgentWorkspace(sdkOptions);
  const beforeConcurrentRefresh = refreshCalls;
  await Promise.all([agent.renew(), agent.renew(), agent.renew()]);
  assert.equal(refreshCalls - beforeConcurrentRefresh, 1);
  assert.equal(saved.state, 'ready');
  assert.equal(JSON.stringify(saved).includes(created.body.secret), false);
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
  const beforeOutageCalls = globalCalls;
  await global.crash();
  globalDown = true;
  await delay(4000);
  const expired = await request('/resources', { token: 'Bearer ' + token });
  assert.equal(expired.status, 401);
  token = await renew();
  await data('Bearer ' + token);
  await sdkData(agent);
  assert.equal(globalCalls, beforeOutageCalls);
  await stop();
  config.security.initializeClock = false;
  await start();
  token = await renew();
  await data('Bearer ' + token);
  await data('Bearer ' + oldKey.body.secret);
  const resumed = await connectAgentWorkspace({ ...sdkOptions, workspaceKey: undefined });
  await sdkData(resumed);
  assert.equal(globalCalls, beforeOutageCalls);
  assert.deepEqual(provider.nativeCreates, creates);
  assert.equal(provider.creates, fileCreates);
  assert.equal(credentials.size, credentialCount);
  await stop();
  return {
    keyId: created.body.data.keyId,
    secret: created.body.secret,
    grantRef: created.body.data.grantRef,
  };
}
