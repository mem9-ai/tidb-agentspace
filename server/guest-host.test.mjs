import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createMetaClient } from './meta/client.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';
import { providerFixture } from './test-support/provider-fixture.mjs';
import { assertSessionContract } from './test-support/assert-session-contract.mjs';

test(
  'hosted Guest survives restart and Global outage with isolated regional Workspaces',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120_000 },
  async (t) => {
    const exec = promisify(execFile);
    await exec('cargo', [
      'build',
      '--locked',
      '-p',
      'workspace-identity',
      '--example',
      'identity_probe',
    ]);
    const fixture = await metaFixture();
    const provider = await providerFixture({ isolatedTenants: true });
    let child;
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
      assert.equal(child.exitCode, 0, 'host shutdown');
    };
    t.after(async () => {
      await stop();
      await provider.close();
      await fixture.close();
    });
    const global = await fixture.service('global');
    const region = await fixture.service('guest-host');
    const regionClientFile = resolve(fixture.directory, 'host-region-client.json');
    await writeFile(regionClientFile, JSON.stringify(region.clientConfig), { mode: 0o600 });
    const probe = resolve('meta-service/target/debug/examples/identity_probe');
    const expired = JSON.parse(
      (await exec(probe, [regionClientFile, '--expired-guest-check', '-', '-'])).stdout,
    );
    assert.equal(expired.expiredGuestRejected, true);
    await global.stop();
    await region.stop();
    global.client.close();
    region.client.close();
    const globalFile = resolve(fixture.directory, 'host-global.json');
    const regionFile = resolve(fixture.directory, 'host-region.json');
    const apiFile = resolve(fixture.directory, 'host-api.json');
    const planFile = resolve(fixture.directory, 'host-plan.json');
    const apiPort = await port();
    const globalConfig = { ...global.server, bind: `127.0.0.1:${await port()}` };
    const regionConfig = { ...region.server, bind: `127.0.0.1:${await port()}` };
    const apiConfig = {
      bind: `127.0.0.1:${apiPort}`,
      workspaceId: 'ws_guest_host_fixture',
      authorityId: regionConfig.authorityId,
      initializeWorkspace: true,
      metadata: { transport: 'inProcess', authorityId: regionConfig.authorityId },
      insecureLoopback: true,
      publicOrigins: ['https://studio.example.test'],
      publicPath: '/studio',
      consoleOrigins: [],
      sso: {
        issuer: 'https://issuer.example.test',
        clientId: 'fixture',
        redirectUri: 'https://studio.example.test/studio/api/auth/tidbcloud/callback',
      },
      product: {
        providers: {
          filesProvider: 'drive9-anonymous',
          mysqlProvider: 'tidb-cloud-zero',
          postgresProvider: 'db9-anonymous',
          testMode: true,
          drive9Endpoint: provider.origin,
          zeroEndpoint: provider.origin + '/zero',
          db9Endpoint: provider.origin + '/customer',
          sqlFixture: provider.origin + '/sql',
        },
      },
    };
    const write = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await write(globalFile, globalConfig);
    await write(regionFile, regionConfig);
    await write(apiFile, apiConfig);
    await write(planFile, {
      format: 1,
      services: [
        { kind: 'metadata', configFile: globalFile },
        { kind: 'metadata', configFile: regionFile },
        { kind: 'workspace', configFile: apiFile },
      ],
    });
    const origin = `http://127.0.0.1:${apiPort}/studio`;
    const request = (path, { cookie, method = 'GET', ...options } = {}) =>
      fetch(origin + path, {
        method,
        ...options,
        headers: {
          Host: 'studio.example.test',
          Origin: 'https://studio.example.test',
          ...(cookie ? { Cookie: cookie } : {}),
          ...options.headers,
        },
      });
    let diagnostics = '';
    const start = async () => {
      child = spawn(
        resolve('meta-service/target/debug/workspace-backend'),
        ['serve', '--config', planFile],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, WORKSPACE_GUEST_ENABLED: 'true' },
        },
      );
      child.stderr.on('data', (chunk) => {
        diagnostics += chunk.toString();
      });
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`host exited: ${diagnostics}`);
        const response = await request('/api/health');
        assert.equal(response.status, 200);
      });
    };
    await start();
    const regionalClient = await createMetaClient({
      ...region.clientConfig,
      origin: `http://${regionConfig.bind}`,
    });
    t.after(() => regionalClient.close());
    await until(async () => {
      const page = await regionalClient.call({
        op: 'list',
        scope: {
          authorityId: regionConfig.authorityId,
          ownerKind: 'system',
          ownerId: 'guest-cleanup',
          family: 'guest-cleanup',
          partitionId: 'shard-00',
        },
        prefix: 'job/',
        limit: 128,
      });
      const job = page.records.find((record) => record.value.workspaceId === expired.workspaceId);
      assert.equal(job?.value.status.state, 'complete');
    });
    regionalClient.close();
    const create = async () => {
      const response = await request('/api/auth/guest', { method: 'POST' });
      assert.equal(response.status, 200, diagnostics);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      assertSessionContract(cookie);
      return {
        cookie,
        ...(await response.json()),
      };
    };
    const first = await create();
    const second = await create();
    const provision = async (guest, kind) => {
      const response = await request(`/api/v1/workspaces/${guest.workspaceId}/resources`, {
        cookie: guest.cookie,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `guest-${kind}` },
        body: JSON.stringify({
          kind,
          name: `guest-${kind}`,
          region: kind === 'filesystem' ? 'aws-ap-southeast-1' : 'automatic',
        }),
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).data.status, 'active');
    };
    await provision(first, 'postgresql');
    await provision(first, 'filesystem');
    await provision(first, 'mysql');
    await provision(second, 'postgresql');
    await provision(second, 'filesystem');
    const authConfig = await request('/api/auth/config', { cookie: first.cookie });
    assert.equal((await authConfig.json()).sessionKind, 'guest');
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.equal(
      (await request(`/api/v1/workspaces/${second.workspaceId}`, { cookie: first.cookie })).status,
      404,
    );
    assert.equal(
      (await (await request('/api/v1/workspaces', { cookie: first.cookie })).json()).data[0].id,
      first.workspaceId,
    );
    // Guest cookies cannot create regional Keys; only Global Owner identity may create new Keys.
    assert.equal(
      (
        await request(`/api/v1/workspaces/${first.workspaceId}/keys`, {
          cookie: first.cookie,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/v1/workspaces/${first.workspaceId}/resources`, {
          headers: { Authorization: 'Bearer retired-guest-key' },
        })
      ).status,
      401,
    );
    await stop();
    await write(apiFile, { ...apiConfig, initializeWorkspace: false });
    await write(globalFile, {
      ...globalConfig,
      s3: { ...globalConfig.s3, prefix: 'intentionally-offline-root' },
    });
    await start();
    const resumed = await request('/api/auth/guest', { method: 'POST', cookie: first.cookie });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).workspaceId, first.workspaceId);
    const listed = await request('/api/v1/workspaces', { cookie: first.cookie });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).data[0].id, first.workspaceId);
    assert.equal((await request('/api/auth/guest', { method: 'POST' })).status, 503);
    assert.equal((await request('/api/auth/guest/logout', { method: 'POST' })).status, 401);
    assert.equal(
      (
        await request('/api/auth/guest/logout', {
          cookie: first.cookie.replace(first.workspaceId, second.workspaceId),
          method: 'POST',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request('/api/auth/guest/logout', {
          cookie: first.cookie,
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    assert.deepEqual(provider.deleted, []);
    assert.equal(
      (await request('/api/auth/tidbcloud/logout', { cookie: first.cookie, method: 'GET' })).status,
      405,
    );
    const logout = await request('/api/auth/guest/logout', {
      cookie: first.cookie,
      method: 'POST',
    });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).cleanup, 'scheduled');
    assert.ok(
      logout.headers
        .getSetCookie()
        .some((header) => header.startsWith('aw_guest=;') && header.includes('Max-Age=0')),
    );
    assert.ok(
      [401, 403].includes((await request('/api/v1/workspaces', { cookie: first.cookie })).status),
    );
    assert.ok(
      [401, 403].includes(
        (
          await request(`/api/v1/workspaces/${first.workspaceId}/resources`, {
            headers: { Authorization: 'Bearer retired-guest-key' },
          })
        ).status,
      ),
    );
    assert.equal((await request('/api/v1/workspaces', { cookie: second.cookie })).status, 200);
    await until(() => {
      assert.deepEqual(provider.deleted.map((entry) => `${entry.kind}:${entry.id}`).sort(), [
        'db9:pg0',
        'drive9:created-tenant-1',
      ]);
    });
    const cleanupClient = await createMetaClient({
      ...region.clientConfig,
      origin: `http://${regionConfig.bind}`,
    });
    t.after(() => cleanupClient.close());
    const shard = createHash('sha256').update(first.workspaceId).digest()[0] % 64;
    const scope = {
      authorityId: regionConfig.authorityId,
      ownerKind: 'system',
      ownerId: 'guest-cleanup',
      family: 'guest-cleanup',
      partitionId: `shard-${String(shard).padStart(2, '0')}`,
    };
    await until(async () => {
      const page = await cleanupClient.call({ op: 'list', scope, prefix: 'job/', limit: 128 });
      const job = page.records.find((record) => record.value.workspaceId === first.workspaceId);
      assert.equal(job?.value.status.state, 'deferred');
      assert.equal(job?.value.status.reason, 'providerOutcomeUncertain');
      const marker = await cleanupClient.call({
        op: 'get',
        scope,
        keys: [`logout/${first.workspaceId}`],
      });
      assert.equal(marker.records[`logout/${first.workspaceId}`], null);
    });
    const remaining = await request(`/api/v1/workspaces/${second.workspaceId}/resources`, {
      cookie: second.cookie,
    });
    assert.equal(remaining.status, 200);
    assert.equal((await remaining.json()).data.length, 2);
  },
);
