import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { connectWorkspace } from '../../src/generated/workspace-agent.mjs';
import { connectAgent } from '../../src/api/agent-client.ts';

// These are tests of the distributed JS and Python clients. The fixture owns all storage,
// keys and native processes and releases them on EOF, including failed client assertions.
const native = spawn(
  'cargo',
  ['run', '--quiet', '--locked', '-p', 'workspace-test-support', '--bin', 'client-fixture'],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
const exited = once(native, 'exit');
const lines = createInterface({ input: native.stdout })[Symbol.asyncIterator]();
async function read() {
  const { value, done } = await lines.next();
  assert.ok(!done, 'native client fixture exited');
  return JSON.parse(value);
}
async function action(name) {
  native.stdin.write(name + '\n');
  return read();
}
try {
  const config = await read();
  const seen = [];
  const client = await connectWorkspace({
    endpoint: config.endpoint,
    apiKey: config.key,
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, authorization: req.headers.get('authorization') });
      return fetch(req);
    },
  });
  const { data } = await client.listResources();
  for (const id of ['db_live', 'fs_live']) assert.ok(data.some((r) => r.id === id));
  const issuance = config.endpoint + '/v1/token-issuances';
  assert.ok(seen.some((r) => r.url === issuance));
  assert.ok(seen.some((r) => r.url.startsWith(config.region) && r.url.endsWith('/resources')));
  assert.ok(seen.every((r) => !r.url.includes('/api/global')));
  assert.ok(
    seen.filter((r) => r.url !== issuance).every((r) => !r.authorization?.includes(config.key)),
  );
  let saved;
  let globalCalls = 0;
  let renewals = 0;
  let offline = false;
  const options = {
    endpoint: config.endpoint,
    key: config.sdkKey,
    proofKey: await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']),
    secrets: {
      load: async () => saved && structuredClone(saved),
      save: async (v) => {
        saved = structuredClone(v);
      },
    },
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      if (req.url === issuance) {
        globalCalls++;
        assert.equal(offline, false, 'cached client contacted Global');
      } else {
        assert.equal(new URL(req.url).origin, new URL(config.region).origin);
        if (req.url.endsWith('/token-issuances')) renewals++;
        assert.equal(req.credentials, 'omit');
        for (const key of [config.sdkKey, config.key])
          assert.ok(!req.headers.get('authorization')?.includes(key));
      }
      return fetch(req);
    },
  };
  const agent = await connectAgent(options);
  const before = renewals;
  await Promise.all([agent.renew(), agent.renew(), agent.renew()]);
  assert.equal(renewals - before, 1);
  assert.equal(saved.state, 'ready');
  async function dataAccess(connection) {
    const params = { path: { workspaceId: config.workspace } };
    const query = await connection.client.POST('/workspaces/{workspaceId}/queries', {
      params,
      body: { resourceId: 'db_pg', sql: 'SELECT 1 AS value' },
    });
    assert.deepEqual(query.data.rows, [{ value: 1 }]);
    const file = await connection.client.PUT('/workspaces/{workspaceId}/files', {
      params,
      body: { resourceId: 'fs_shared', path: '/sdk.txt', type: 'file', content: 'SDK continuity' },
    });
    assert.equal(file.response.status, 200);
  }
  await dataAccess(agent);
  const extended = await action('extend');
  assert.equal(extended.regionalStatus, 'applied');
  assert.equal(extended.regionalContinuity, 'eligible');
  assert.equal(extended.data.keyVersion, 2);
  const calls = globalCalls;
  await action('offline');
  offline = true;
  await delay(Math.max(0, (config.expiresAt + 1) * 1000 - Date.now()));
  await dataAccess(agent);
  assert.equal(saved.expiresAt, extended.data.expiresAt);
  await action('restart');
  await dataAccess(await connectAgent(options));
  assert.equal(globalCalls, calls);
  if (process.env.WORKSPACE_TRIAL_PYTHON) {
    for (const [file, ...args] of [
      ['private_csv_helper.py'],
      ['agent_trial_client.py', config.region],
    ])
      execFileSync(
        process.env.WORKSPACE_TRIAL_PYTHON,
        ['-IB', 'tools/agent-client-tests/' + file, ...args],
        { timeout: 90_000, stdio: 'inherit' },
      );
  }
  console.log('Public client discovery, scoped access, renewal and restart passed.');
} finally {
  native.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, 'native fixture exited unsuccessfully');
}
