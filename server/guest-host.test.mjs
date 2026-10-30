import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createMetaClient } from './meta/client.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';

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
      await fixture.close();
    });
    const global = await fixture.service('global');
    const region = await fixture.service('guest-host');
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
      product: {},
      guest: { globalAuthorityId: 'global', workspaceLimit: 4 },
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
        { stdio: ['ignore', 'pipe', 'pipe'] },
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
    const create = async () => {
      const response = await request('/api/auth/guest', { method: 'POST' });
      assert.equal(response.status, 200, diagnostics);
      return {
        cookie: response.headers.get('set-cookie').split(';')[0],
        ...(await response.json()),
      };
    };
    const first = await create();
    const second = await create();
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.equal(
      (await request(`/api/v1/workspaces/${second.workspaceId}`, { cookie: first.cookie })).status,
      404,
    );
    assert.equal(
      (await (await request('/api/v1/workspaces', { cookie: first.cookie })).json()).data[0].id,
      first.workspaceId,
    );
    const keyResponse = await request(`/api/v1/workspaces/${first.workspaceId}/keys`, {
      cookie: first.cookie,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Guest test key',
        scopes: ['resources:read'],
        resourceIds: ['*'],
        expiresInDays: 7,
      }),
    });
    assert.equal(keyResponse.status, 201);
    const key = await keyResponse.json();
    const authorization = { Authorization: `Bearer ${key.secret}` };
    assert.equal(
      (
        await request(`/api/v1/workspaces/${first.workspaceId}/resources`, {
          headers: authorization,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/v1/workspaces/${second.workspaceId}/resources`, {
          headers: authorization,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(`/api/v1/workspaces/${first.workspaceId}/keys/${key.data.id}`, {
          cookie: first.cookie,
          method: 'DELETE',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/v1/workspaces/${first.workspaceId}/resources`, {
          headers: authorization,
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
  },
);
