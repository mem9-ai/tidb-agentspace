import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createApp } from './index.mjs';
import { seed } from './store.mjs';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';
import { metadataCertificates } from './test-support/meta-tls.mjs';
import { migrateLegacy } from './meta/migrate.mjs';
import { createMetaClient } from './meta/client.mjs';
import { documentScope, decodeDocument } from './meta/document-store.mjs';

const base = '/api/v1/workspaces/ws_agentlab';
const suffixes = ['', '.providers.json', '.databases.json', '.duckdb.json', '.db9.json'];
const originalToken = 'original-key-before-rust-migration';
const unsupportedScopeToken = 'original-file-only-key';
const expiredToken = 'original-expired-key';
const revokedToken = 'original-revoked-key';
const privateNativeToken = 'provider-native-credential-preserved';
const privateWrite = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function launch(directory, services) {
  const id = randomUUID();
  const path = resolve(directory, id + '.json');
  await privateWrite(path, { format: 1, services });
  const log = createWriteStream(resolve(directory, id + '.log'), { mode: 0o600 });
  const child = spawn(
    resolve('meta-service/target/debug/workspace-backend'),
    ['serve', '--config', path],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise((done) =>
    child.once('exit', (code, signal) => done({ code, signal })),
  );
  return {
    child,
    exited,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
async function connect(origin) {
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  return async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = headers.Host
      ? await new Promise((done, reject) => {
          const request = http.request(origin + path, options, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () =>
              done(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode,
                  headers: response.headers,
                }),
              ),
            );
          });
          request.on('error', reject);
          request.end(options.body);
        })
      : await fetch(origin + path, options);
    const value = response.status === 204 ? null : await response.json();
    return { status: response.status, body: value, headers: response.headers };
  };
}
async function parityCases(request) {
  const traces = [];
  const record = async (path, options) => {
    const r = await request(path, options);
    traces.push({ status: r.status, ...(r.body?.error ? { error: r.body.error.code } : {}) });
    return r;
  };
  assert.equal((await record(base, { token: originalToken })).status, 200);
  assert.equal((await record(base, { token: unsupportedScopeToken })).status, 403);
  assert.equal((await record(base, { token: expiredToken })).status, 401);
  assert.equal((await record(base, { token: revokedToken })).status, 401);
  assert.equal((await record(base, { headers: { Cookie: '' } })).status, 401);
  assert.equal((await record(base, { token: 'not-an-original-key' })).status, 401);
  assert.equal((await record(base + '/keys', { token: originalToken })).status, 403);
  assert.equal((await record('/api/v1/workspaces/other', { token: originalToken })).status, 404);
  assert.equal(
    (await record(base, { headers: { Origin: 'https://untrusted.example' } })).status,
    403,
  );
  assert.equal((await record(base, { headers: { Host: 'untrusted.example' } })).status, 403);
  const preflight = await record(base, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.equal(
    (
      await record(base, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'private-service-token',
        },
      })
    ).body.error.code,
    'PREFLIGHT_DENIED',
  );
  assert.equal(
    (await record(base + '/settings', { method: 'PATCH', body: [] })).body.error.code,
    'INVALID_BODY',
  );
  assert.equal(
    (
      await record(base + '/settings', {
        method: 'PATCH',
        body: {},
        headers: { 'Content-Type': 'text/plain' },
      })
    ).body.error.code,
    'JSON_REQUIRED',
  );
  assert.equal(
    (
      await record(base + '/settings', {
        method: 'PATCH',
        body: { workspaceName: 'Rust migration', name: 'Owner', description: 'Preserved' },
      })
    ).status,
    200,
  );
  const workspace = await record(base);
  assert.equal(workspace.body.data.name, 'Rust migration');
  const input = {
    name: 'Migrated scoped key',
    scopes: ['resources:read', 'resources:read'],
    resourceIds: ['db_memory', 'db_memory'],
    expiresInDays: 7,
  };
  for (const change of [
    { name: '中' },
    { scopes: ['admin:*'] },
    { expiresInDays: 1 },
    { resourceIds: ['internal-duckdb-store'] },
    { resourceIds: ['retired-pg'] },
    { resourceIds: ['*', 'db_memory'] },
    { resourceIds: [] },
  ])
    assert.equal(
      (await record(base + '/keys', { method: 'POST', body: { ...input, ...change } })).status,
      400,
    );
  const created = await record(base + '/keys', { method: 'POST', body: input });
  assert.equal(created.status, 201);
  assert.match(created.body.secret, /^aw_demo_[a-f0-9]{48}$/);
  assert.equal(created.body.data.digest, undefined);
  assert.deepEqual(created.body.data.resourceIds, ['db_memory']);
  assert.deepEqual(created.body.data.scopes, ['resources:read']);
  assert.equal((await record(base, { token: created.body.secret })).status, 200);
  const events = await record(base + '/events', { token: originalToken });
  assert.deepEqual(
    events.body.data.map((e) => e.id),
    ['visible-event'],
  );
  const ownerEvents = await record(base + '/events');
  assert.equal(
    ownerEvents.body.data.some((e) => e.id === 'retired-event'),
    false,
  );
  assert.equal(
    (await record(base + `/keys/${created.body.data.id}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal(
    (await record(base + `/keys/${created.body.data.id}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal((await record(base, { token: created.body.secret })).status, 401);
  const keys = await record(base + '/keys');
  assert.equal(keys.body.data.length, 5);
  assert.equal(JSON.stringify(keys.body).includes('digest'), false);
  assert.equal(JSON.stringify(keys.body).includes(created.body.secret), false);
  assert.equal(JSON.stringify(keys.body).includes(privateNativeToken), false);
  return traces;
}

for (const mode of ['inProcess', 'remote']) {
  test(
    `Rust Workspace/Key matches Node through ${mode} metadata and survives language handoff`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180_000 },
    async (t) => {
      const fixture = await metaFixture();
      const children = [];
      t.after(async () => {
        for (const child of children.toReversed()) await child.stop();
        await fixture.close();
      });
      const global = await fixture.service('global');
      const region = await fixture.service('rust-region');
      const secondary = await fixture.service('rust-secondary');
      const state = seed();
      state.opaque = { keep: ['unknown', { value: 42 }] };
      state.resources.push({
        id: 'retired-pg',
        kind: 'postgresql',
        provider: 'simulated',
        region: 'automatic',
      });
      state.events = [
        { id: 'visible-event', resourceId: 'db_memory', action: 'query.executed' },
        { id: 'retired-event', resourceId: 'retired-pg', action: 'query.executed' },
        { id: 'other-event', resourceId: 'fs_shared', action: 'file.read' },
      ];
      state.keys = [originalToken, unsupportedScopeToken, expiredToken, revokedToken].map(
        (token, index) => ({
          id: `preserved-key-${index}`,
          name: 'original key',
          prefix: 'original',
          digest: createHash('sha256').update(token).digest('hex'),
          scopes: [index === 1 ? 'files:read' : 'resources:read'],
          resourceIds: ['db_memory'],
          expiresAt: new Date(Date.now() + (index === 2 ? -1 : 1) * 86400000).toISOString(),
          revokedAt: index === 3 ? new Date().toISOString() : null,
        }),
      );
      const raw = [
        JSON.stringify(state),
        JSON.stringify({ bindings: { orphan: { apiKey: privateNativeToken } } }),
        '{"bindings":{}}',
        '{"bindings":{}}',
        JSON.stringify({ bindings: {}, account: { refreshToken: 'original-private-account' } }),
      ];
      const source = resolve(fixture.directory, 'workspace.json');
      const baseline = resolve(fixture.directory, 'baseline', 'workspace.json');
      await mkdir(resolve(fixture.directory, 'baseline'), { mode: 0o700 });
      for (let i = 0; i < raw.length; i++) {
        await writeFile(source + suffixes[i], raw[i], { mode: 0o600 });
        await writeFile(baseline + suffixes[i], raw[i], { mode: 0o600 });
      }
      const node = await createApp({ dataFile: baseline });
      await new Promise((r) => node.listen(0, '127.0.0.1', r));
      let expected;
      try {
        expected = await parityCases(await connect(`http://127.0.0.1:${node.address().port}`));
      } finally {
        await new Promise((r) => node.close(r));
      }
      const bridge = resolve(fixture.directory, 'bridge.json');
      const importId = 'original-import';
      await privateWrite(bridge, {
        format: 1,
        workspaceId: state.workspace.id,
        importId,
        global: global.clientConfig,
        region: region.clientConfig,
        regionStorage: { bucket: region.server.s3.bucket, prefix: 'metadata', engine: 'slatedb' },
      });
      assert.equal(
        (
          await migrateLegacy({
            sourceFile: source,
            configFile: bridge,
            backupDirectory: resolve(fixture.directory, 'backup'),
            sourceFrozen: true,
          })
        ).verified,
        true,
      );
      await global.stop();
      await region.stop();
      await secondary.stop();
      let server = region.server,
        clientConfig = region.clientConfig;
      if (mode === 'remote') {
        const certificates = await metadataCertificates(fixture.directory);
        server = {
          ...server,
          insecureLoopback: false,
          tls: certificates.server,
          s3: { ...server.s3, allowLoopbackHttp: true },
        };
        clientConfig = {
          ...clientConfig,
          insecureLoopback: false,
          origin: clientConfig.origin.replace('http:', 'https:'),
          tls: certificates.client,
        };
      }
      const serverFile = resolve(fixture.directory, 'region-server.json');
      await privateWrite(serverFile, server);
      const globalFile = resolve(fixture.directory, 'global-server.json');
      await privateWrite(globalFile, global.server);
      const secondaryFile = resolve(fixture.directory, 'secondary-server.json');
      await privateWrite(secondaryFile, secondary.server);
      const listen = await port(),
        origin = `http://127.0.0.1:${listen}`;
      const workspaceFile = resolve(fixture.directory, 'workspace-service.json');
      const workspaceConfig = {
        bind: `127.0.0.1:${listen}`,
        workspaceId: state.workspace.id,
        authorityId: server.authorityId,
        importId,
        insecureLoopback: true,
        consoleOrigins: ['http://127.0.0.1:5173'],
        metadata:
          mode === 'inProcess'
            ? { transport: 'inProcess', authorityId: server.authorityId }
            : { transport: 'remote', client: clientConfig },
      };
      await privateWrite(workspaceFile, workspaceConfig);
      const metadataRoles = [{ kind: 'metadata', configFile: serverFile }];
      let metadataHost;
      if (mode === 'remote') {
        metadataHost = await launch(fixture.directory, metadataRoles);
        children.push(metadataHost);
        await until(async () => {
          const c = await createMetaClient(clientConfig);
          c.close();
        });
        const wrongToken = resolve(fixture.directory, 'wrong-client-token');
        await writeFile(wrongToken, randomUUID() + randomUUID(), { mode: 0o600 });
        for (const broken of [
          { ...clientConfig, tokenFile: wrongToken },
          { ...clientConfig, installationId: 'another-installation' },
          {
            ...clientConfig,
            tls: {
              ...clientConfig.tls,
              certificateFile: server.tls.certificateFile,
              privateKeyFile: server.tls.privateKeyFile,
            },
          },
        ]) {
          const brokenFile = resolve(fixture.directory, randomUUID() + '.json');
          await privateWrite(brokenFile, {
            ...workspaceConfig,
            bind: `127.0.0.1:${await port()}`,
            metadata: { transport: 'remote', client: broken },
          });
          const denied = await launch(fixture.directory, [
            { kind: 'workspace', configFile: brokenFile },
          ]);
          children.push(denied);
          assert.notEqual((await denied.exited).code, 0);
        }
      } else
        metadataRoles.push(
          { kind: 'metadata', configFile: globalFile },
          { kind: 'metadata', configFile: secondaryFile },
        );
      const rust = await launch(fixture.directory, [
        ...(mode === 'inProcess' ? metadataRoles : []),
        { kind: 'workspace', configFile: workspaceFile },
      ]);
      children.push(rust);
      const request = await until(() => connect(origin));
      assert.deepEqual(await parityCases(request), expected);
      assert.equal(
        (
          await request(base + '/queries', {
            method: 'POST',
            body: { resourceId: 'db_memory', sql: 'SELECT 1' },
          })
        ).status,
        404,
      );
      const client = await createMetaClient(clientConfig);
      t.after(() => client.close());
      await assert.rejects(
        client.call({
          op: 'snapshot',
          scope: documentScope('global', state.workspace.id, 'workspace'),
        }),
        { code: 'META_AUTHORITY_MISMATCH' },
      );
      const duplicateFile = resolve(fixture.directory, 'duplicate-workspace.json');
      await privateWrite(duplicateFile, {
        ...workspaceConfig,
        bind: `127.0.0.1:${await port()}`,
        metadata: { transport: 'remote', client: clientConfig },
      });
      const duplicate = await launch(fixture.directory, [
        { kind: 'workspace', configFile: duplicateFile },
      ]);
      children.push(duplicate);
      assert.notEqual((await duplicate.exited).code, 0);
      const gateScope = {
        authorityId: server.authorityId,
        ownerKind: 'system',
        ownerId: 'compatibility',
        family: 'legacy-gateway',
        partitionId: state.workspace.id,
      };
      const owner = (await client.call({ op: 'snapshot', scope: gateScope })).records.ownerId;
      assert.ok(owner);
      await assert.rejects(
        client.call({
          op: 'snapshot',
          scope: documentScope(server.authorityId, state.workspace.id, 'workspace'),
        }),
        { code: 'META_GATEWAY_REQUIRED' },
      );
      await privateWrite(bridge, {
        format: 1,
        workspaceId: state.workspace.id,
        importId,
        region: clientConfig,
      });
      await assert.rejects(createApp({ dataFile: source, metaConfig: bridge }), {
        code: 'META_GATEWAY_ACTIVE',
      });
      const recoverFile = resolve(fixture.directory, 'recover-workspace.json');
      const recoverPort = await port();
      await privateWrite(recoverFile, {
        ...workspaceConfig,
        bind: `127.0.0.1:${recoverPort}`,
        recoverGatewayOwner: owner,
        metadata: { transport: 'remote', client: clientConfig },
      });
      const replacement = await launch(fixture.directory, [
        { kind: 'workspace', configFile: recoverFile },
      ]);
      children.push(replacement);
      const replacementRequest = await until(() => connect(`http://127.0.0.1:${recoverPort}`));
      assert.equal((await request(base)).body.error.code, 'META_GATEWAY_FENCED');
      if (mode === 'remote') {
        await rust.stop();
        assert.equal((await replacementRequest(base)).status, 200);
      }
      await replacement.stop();
      await rust.stop();
      client.close();
      if (metadataHost) await metadataHost.stop();
      const restored = await fixture.service('handoff', {
        previous: { server },
        clientTls: clientConfig.tls,
      });
      const workspace = JSON.parse(
        decodeDocument(
          await restored.client.call({
            op: 'snapshot',
            scope: documentScope(server.authorityId, state.workspace.id, 'workspace'),
          }),
        ),
      );
      assert.equal(workspace.workspace.name, 'Rust migration');
      assert.deepEqual(workspace.opaque, state.opaque);
      assert.deepEqual(workspace.files, state.files);
      assert.deepEqual(workspace.resources, state.resources);
      for (let i = 0; i < state.keys.length; i++) {
        for (const key of ['digest', 'scopes', 'resourceIds', 'expiresAt', 'revokedAt'])
          assert.deepEqual(workspace.keys[i][key], state.keys[i][key]);
      }
      for (let i = 1; i < raw.length; i++)
        assert.equal(
          decodeDocument(
            await restored.client.call({
              op: 'snapshot',
              scope: documentScope(
                server.authorityId,
                state.workspace.id,
                ['workspace', 'drive9', 'zero', 'duckdb', 'db9'][i],
              ),
            }),
          ).toString(),
          raw[i],
        );
      for (let i = 0; i < raw.length; i++)
        assert.equal(await readFile(source + suffixes[i], 'utf8'), raw[i]);
      await privateWrite(bridge, {
        format: 1,
        workspaceId: state.workspace.id,
        importId,
        region: restored.clientConfig,
      });
      const returned = await createApp({ dataFile: source, metaConfig: bridge });
      await new Promise((r) => returned.listen(0, '127.0.0.1', r));
      try {
        const request = await connect(`http://127.0.0.1:${returned.address().port}`);
        assert.equal(
          (await request(base, { token: originalToken })).body.data.name,
          'Rust migration',
        );
        assert.equal(
          (
            await request(base + '/settings', {
              method: 'PATCH',
              body: { workspaceName: 'Returned through Node', name: 'Owner' },
            })
          ).status,
          200,
        );
      } finally {
        await new Promise((r) => returned.close(r));
      }
      await privateWrite(workspaceFile, {
        ...workspaceConfig,
        metadata: { transport: 'remote', client: restored.clientConfig },
      });
      const restart = await launch(fixture.directory, [
        { kind: 'workspace', configFile: workspaceFile },
      ]);
      children.push(restart);
      const requestAgain = await until(() => connect(origin));
      assert.equal(
        (await requestAgain(base, { token: originalToken })).body.data.name,
        'Returned through Node',
      );
      assert.equal((await requestAgain('/api/health')).status, 200);
    },
  );
}

test(
  'Rust host rejects shared metadata authority and storage before opening a writer',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 60_000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const a = await fixture.service('a');
    await a.stop();
    const first = resolve(fixture.directory, 'first.json');
    await privateWrite(first, a.server);
    for (const change of [
      { authorityId: a.server.authorityId },
      { s3: { ...a.server.s3, prefix: a.server.s3.prefix + '/overlap' } },
    ]) {
      const tokenFile = resolve(fixture.directory, randomUUID() + '-token');
      const encryptionKeyFile = resolve(fixture.directory, randomUUID() + '-key');
      await writeFile(tokenFile, randomUUID() + randomUUID(), { mode: 0o600 });
      await writeFile(encryptionKeyFile, createHash('sha256').update(randomUUID()).digest('hex'), {
        mode: 0o600,
      });
      const second = resolve(fixture.directory, randomUUID() + '.json');
      await privateWrite(second, {
        ...a.server,
        authorityId: 'region:other',
        installationId: 'other-installation',
        bind: `127.0.0.1:${await port()}`,
        tokenFile,
        encryptionKeyFile,
        ...change,
      });
      const child = await launch(fixture.directory, [
        { kind: 'metadata', configFile: first },
        { kind: 'metadata', configFile: second },
      ]);
      assert.notEqual((await child.exited).code, 0);
    }
    const reopened = await fixture.service('unchanged', { previous: a });
    assert.equal((await reopened.client.health()).authorityId, a.server.authorityId);
  },
);

test(
  'a failed Global role does not stop an embedded Region or seed the missing Global root',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 60_000 },
  async (t) => {
    const fixture = await metaFixture();
    const children = [];
    t.after(async () => {
      for (const child of children.toReversed()) await child.stop();
      await fixture.close();
    });
    const global = await fixture.service('global');
    const region = await fixture.service('surviving-region');
    await global.stop();
    await region.stop();
    const globalFile = resolve(fixture.directory, 'failed-global.json');
    await privateWrite(globalFile, {
      ...global.server,
      s3: { ...global.server.s3, prefix: 'missing-global-root' },
    });
    const regionFile = resolve(fixture.directory, 'surviving-region.json');
    await privateWrite(regionFile, region.server);
    const host = await launch(fixture.directory, [
      { kind: 'metadata', configFile: globalFile },
      { kind: 'metadata', configFile: regionFile },
    ]);
    children.push(host);
    const client = await until(() => createMetaClient(region.clientConfig));
    try {
      const scope = {
        authorityId: region.server.authorityId,
        ownerKind: 'system',
        ownerId: 'continuity',
        family: 'probe',
        partitionId: 'one',
      };
      await client.call({
        op: 'commit',
        scope,
        expectedRevision: null,
        mutationId: randomUUID(),
        changes: [{ key: 'survives', value: true }],
      });
      assert.equal((await client.call({ op: 'snapshot', scope })).records.survives, true);
      const root = await fixture.s3(
        'GET',
        `/${global.server.s3.bucket}/missing-global-root/control/installation.json`,
      );
      assert.equal(root.status, 404);
      await root.body?.cancel();
    } finally {
      client.close();
    }
    await host.stop();
    const restored = await fixture.service('restart-region', { previous: region });
    assert.equal((await restored.client.health()).authorityId, region.server.authorityId);
  },
);
