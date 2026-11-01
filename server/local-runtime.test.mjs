import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initializeLocalRuntime } from './meta/local-runtime.mjs';
import { createMetaClient, privateJson } from './meta/client.mjs';
import { port, until } from './test-support/meta-fixture.mjs';
import { workspaceScope } from './test-support/record-fixture.mjs';
test(
  'fresh local supervision persists bootstrap, restarts all independent native roles and keeps empty resources',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const parent = await mkdtemp(resolve(tmpdir(), 'workspace-fresh-runtime-'));
    const directory = resolve(parent, 'runtime');
    const apiPort = await port();
    let child;
    const stop = async () => {
      if (!child || child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
      assert.equal(child.exitCode, 0);
    };
    t.after(async () => {
      await stop();
      await rm(parent, { recursive: true, force: true });
    });
    await initializeLocalRuntime({ directory, apiPort });
    const start = async () => {
      const log = await open(resolve(parent, 'supervisor.log'), 'a', 0o600);
      child = spawn(
        process.execPath,
        ['server/meta/local-runtime.mjs', 'serve', '--directory', directory],
        { stdio: ['ignore', log.fd, log.fd] },
      );
      await log.close();
      await until(async () => {
        const r = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
        assert.equal(r.status, 200);
      });
    };
    await start();
    let topology = await until(async () => {
      const value = await privateJson(resolve(directory, 'topology.json'));
      assert.equal(value.workspaceInitialized, true);
      assert.ok(value.services.every((s) => s.initialized));
      return value;
    });
    for (const service of topology.services) {
      assert.equal((await privateJson(service.planFile)).services[0].initialize ?? false, false);
    }
    const ownerIds = [];
    for (const s of topology.services) {
      const c = await createMetaClient(s.client);
      try {
        ownerIds.push((await c.health()).ownerId);
      } finally {
        c.close();
      }
    }
    const client = await createMetaClient(topology.services[1].client);
    const scope = workspaceScope(topology.services[1].authorityId);
    const owner = await client.call({ op: 'get', scope, keys: ['system/writer'] });
    const guard = { ownerId: owner.records['system/writer'].value.ownerId };
    const before = await client.call({ op: 'get', scope, keys: ['state/workspace'], guard });
    client.close();
    await stop();
    await assert.rejects(readFile(resolve(directory, 'runtime.lock/owner.json')), {
      code: 'ENOENT',
    });
    await start();
    topology = await privateJson(resolve(directory, 'topology.json'));
    for (let i = 0; i < topology.services.length; i++) {
      const c = await createMetaClient(topology.services[i].client);
      try {
        assert.notEqual((await c.health()).ownerId, ownerIds[i]);
      } finally {
        c.close();
      }
    }
    const c = await createMetaClient(topology.services[1].client);
    try {
      const writer = await c.call({ op: 'get', scope, keys: ['system/writer'] });
      assert.deepEqual(
        await c.call({
          op: 'get',
          scope,
          keys: ['state/workspace'],
          guard: { ownerId: writer.records['system/writer'].value.ownerId },
        }),
        before,
      );
    } finally {
      c.close();
    }
    const session = await fetch(`http://127.0.0.1:${apiPort}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const boot = await fetch(
      `http://127.0.0.1:${apiPort}/api/portal/v1/workspaces/ws_agentlab/bootstrap`,
      { headers: { Cookie: cookie } },
    ).then((r) => r.json());
    assert.deepEqual(boot.resources, []);
    assert.deepEqual(boot.keys, []);
    assert.deepEqual(boot.files, []);
    assert.equal((await privateJson(topology.apiConfigFile)).initializeWorkspace, false);
  },
);
