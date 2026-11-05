import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { metaFixture, reservePorts, until } from './meta-fixture.mjs';
import { seedRecords, workspaceScope } from './record-fixture.mjs';
import { providerFixture, nativeSecret } from './provider-fixture.mjs';
import { globalOwnerFixture } from './global-owner-fixture.mjs';
import { workspaceFixture } from './workspace-fixture.mjs';

// Two actual Workspace APIs share a Meta authority. Resource IDs and paths deliberately
// collide, so isolation cannot pass merely because an unrelated ID was not found.
export async function productApiFixture(
  t,
  transport,
  onSql,
  {
    missingBinding = false,
    mysqlProvider = 'tidb-cloud-zero',
    fresh = false,
    filesProvider = 'drive9-anonymous',
  } = {},
) {
  const meta = await metaFixture();
  let provider, region;
  const children = [];
  t.after(async () => {
    for (const child of children.toReversed()) await meta.stop(child);
    if (provider) await provider.close();
    await meta.close();
  });
  provider = await providerFixture({ onSql, requireFileAuth: true });
  provider.bindFileTenant(nativeSecret, 'coverage-tenant');
  region = await meta.service('api-coverage');
  const states = ['ws_agentlab', 'ws_other'].map((id) => {
    const state = workspaceFixture();
    state.workspace.id = id;
    state.keys = ['expired-coverage-key', 'revoked-coverage-key'].map((token, index) => ({
      id: `unavailable-key-${index}`,
      name: token,
      prefix: 'synthetic',
      digest: createHash('sha256').update(token).digest('hex'),
      scopes: ['resources:read', 'files:read', 'files:write', 'files:analyze', 'queries:execute'],
      resourceIds: ['*'],
      expiresAt: index === 0 ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
      revokedAt: index === 1 ? state.workspace.createdAt : null,
    }));
    state.files = [
      {
        id: 'same-file-id',
        resourceId: 'fs_shared',
        path: '/identity.txt',
        type: 'file',
        content: id,
      },
    ];
    for (const [resourceId, kind, upstream] of [
      ['fs_live', 'filesystem', 'drive9-anonymous'],
      ['db_live', 'postgresql', 'db9-anonymous'],
      ['db_retired_mysql', 'mysql', 'tidb-cloud-zero'],
      ['db_pg', 'postgresql', 'db9-anonymous'],
      ['db_duck', 'duckdb', 'duckdb-drive9'],
    ])
      state.resources.push({
        id: resourceId,
        kind,
        provider: upstream,
        name: resourceId.replaceAll('_', '-'),
        status: 'active',
        region: kind === 'filesystem' ? 'aws-ap-southeast-1' : 'automatic',
        createdAt: state.workspace.createdAt,
      });
    state.resources.push({
      id: 'db_legacy_local',
      kind: 'mysql',
      provider: 'local',
      name: 'legacy-local',
      status: 'active',
      region: 'aws-us-east-1',
      createdAt: state.workspace.createdAt,
    });
    if (missingBinding)
      state.resources.push({
        id: 'db_missing',
        name: 'missing-binding',
        kind: 'postgresql',
        provider: 'db9-anonymous',
        region: 'automatic',
        status: 'failed',
        createdAt: state.workspace.createdAt,
      });
    if (fresh) {
      state.resources = [];
      state.files = [];
    }
    return state;
  });
  for (const state of states) {
    const connection = (kind) => ({
      kind,
      region: 'automatic',
      host: kind === 'mysql' ? 'unit.fixture.tidbcloud.com' : 'pg.db9.io',
      port: kind === 'mysql' ? 4000 : 5432,
      user: kind === 'mysql' ? 'w_original' : 'tenant.wabcdef123456',
      password: nativeSecret,
      database: kind === 'mysql' ? 'workspace' : 'postgres',
    });
    await seedRecords(region.client, region.server.authorityId, state, {
      drive9: {
        bindings: {
          fs_live: { state: 'bound', apiKey: nativeSecret, tenantId: state.workspace.id },
          'hidden-storage': { state: 'bound', apiKey: nativeSecret, tenantId: 'hidden-tenant' },
        },
      },
      zero: {
        bindings: {
          db_retired_mysql: {
            state: 'ready',
            instanceId: state.workspace.id,
            expiresAt: '2099-01-01T00:00:00.000Z',
            connection: connection('mysql'),
          },
        },
      },
      duckdb: { bindings: { db_duck: { state: 'ready', storageId: 'hidden-storage' } } },
      db9: {
        account: {
          state: 'ready',
          anonymousId: 'retained-account',
          anonymousSecret: nativeSecret,
          token: 'account-token',
          expiresAt: 4070908800000,
        },
        bindings: {
          db_live: {
            state: 'ready',
            instanceId: state.workspace.id,
            connection: connection('postgresql'),
          },
          db_memory: {
            state: 'ready',
            instanceId: state.workspace.id,
            connection: connection('postgresql'),
          },
          db_pg: {
            state: 'ready',
            instanceId: state.workspace.id,
            connection: connection('postgresql'),
          },
        },
      },
    });
  }
  const globalMeta = await meta.service('global');
  const reserved = await reservePorts(states.length * 2);
  t.after(async () => Promise.all(reserved.map((entry) => entry.release())));
  const origins = states.map((_, index) => `http://127.0.0.1:${reserved[index].port}`);
  if (transport === 'inProcess') await region.stop();
  const globals = await Promise.all(
    states.map((state, index) =>
      globalOwnerFixture(
        meta,
        globalMeta,
        region,
        state.workspace.id,
        origins[index],
        index,
        reserved[states.length + index].port,
      ),
    ),
  );
  const cookies = [];
  let writerRecovery = [],
    metadataRecovery;
  async function start() {
    const metadataServices = [];
    if (transport === 'inProcess') {
      const configFile = resolve(meta.directory, 'embedded-meta.json');
      await writeFile(configFile, JSON.stringify(region.server), { mode: 0o600 });
      metadataServices.push({ kind: 'metadata', configFile, recoverOwner: metadataRecovery });
    }
    for (const [index, state] of states.entries()) {
      const configFile = resolve(meta.directory, `workspace-${index}.json`);
      await writeFile(
        configFile,
        JSON.stringify({
          bind: new URL(origins[index]).host,
          workspaceId: state.workspace.id,
          authorityId: region.server.authorityId,
          recoverWriterOwner: writerRecovery[index],
          insecureLoopback: true,
          publicOrigins: [origins[index]],
          consoleOrigins: ['http://127.0.0.1:5173'],
          metadata:
            transport === 'remote' || index > 0
              ? { transport: 'remote', client: region.clientConfig }
              : { transport, authorityId: region.server.authorityId },
          security: globals[index].security,
          product: {
            providers: {
              filesProvider,
              mysqlProvider,
              postgresProvider: 'db9-anonymous',
              testMode: true,
              drive9Endpoint: provider.origin,
              zeroEndpoint: provider.origin + '/zero',
              db9Endpoint: provider.origin + '/customer',
              sqlFixture: provider.origin + '/sql',
            },
          },
        }),
        { mode: 0o600 },
      );
      const services = [
        ...(index === 0 ? metadataServices : []),
        { kind: 'workspace', configFile },
        globals[index].service,
      ];
      const plan = resolve(meta.directory, `plan-${index}.json`);
      await writeFile(plan, JSON.stringify({ format: 1, services }), { mode: 0o600 });
      const log = createWriteStream(resolve(meta.directory, 'api-coverage.log'), {
        flags: 'a',
        mode: 0o600,
      });
      await Promise.all([reserved[index].release(), reserved[states.length + index].release()]);
      const child = spawn(
        resolve('meta-service/target/debug/workspace-backend'),
        ['serve', '--config', plan],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      child.once('close', () => log.end());
      children.push(child);
      await until(async () => {
        const response = await fetch(origins[index] + '/api/health', {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        assert.equal(response.status, 200);
      });
    }
  }
  await start();
  async function request(route, options = {}, workspace = 0) {
    const { method = 'GET', body, raw, headers = {} } = options;
    const origin = origins[workspace];
    const auth = {};
    if (Object.hasOwn(options, 'token')) {
      if (options.token !== null) auth.Authorization = `Bearer ${options.token}`;
    } else {
      if (!cookies[workspace]) {
        const response = await fetch(origin + '/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 200);
        cookies[workspace] = response.headers.get('set-cookie').split(';')[0];
        await response.body?.cancel();
      }
      auth.Cookie = cookies[workspace];
    }
    const path = route.startsWith('/api/')
      ? route
      : `${Object.hasOwn(options, 'token') ? '/api/v1' : '/api/portal/v1'}/workspaces/${states[workspace].workspace.id}${route}`;
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: origin, ...auth, ...headers },
      ...(raw !== undefined
        ? { body: raw }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    });
    const value = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: value, headers: response.headers, url: response.url };
  }
  return {
    provider,
    controlProbe: globals[0].controlProbe,
    globalRequest: globals[0].request,
    request,
    endpoints: {
      global: globals[0].origin,
      region: origins[0],
      workspaceId: states[0].workspace.id,
      regionId: region.server.authorityId,
    },
    async expireTrial(publicKey) {
      const scope = {
        authorityId: region.server.authorityId,
        ownerKind: 'system',
        ownerId: 'agent-trials',
        family: 'sample-reports',
        partitionId: 'v1',
      };
      const key = 'reports/' + createHash('sha256').update(publicKey).digest('hex').slice(0, 2);
      const { records } = await region.client.call({ op: 'get', scope, keys: [key] });
      const { value, version } = records[key];
      value[publicKey].expiresAt = Math.floor(Date.now() / 1000) - 1;
      await region.client.call({
        op: 'commit',
        scope,
        mutationId: randomUUID(),
        changes: [{ key, value, expectedVersion: version }],
      });
    },
    async storedResource(id) {
      const scope = workspaceScope(region.server.authorityId, states[0].workspace.id);
      const key = `state/resources/${id}`;
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      const guard = { ownerId: writer.records['system/writer'].value.ownerId };
      const result = await region.client.call({ op: 'get', scope, guard, keys: [key] });
      return result.records[key]?.value.record;
    },
    async binding(providerName, id) {
      const scope = workspaceScope(region.server.authorityId, states[0].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      const guard = { ownerId: writer.records['system/writer'].value.ownerId };
      const keys = [`bindings/${providerName}/${id}`, `credentials/${providerName}/${id}`];
      const result = await region.client.call({ op: 'get', scope, guard, keys });
      return keys.map((key) => result.records[key]?.value);
    },
    issueKey: (input, workspace = 0) => globals[workspace].issueKey(input),
    revokeKey: (id, workspace = 0) => globals[workspace].revokeKey(id),
    listKeys: (workspace = 0) => globals[workspace].listKeys(),
    deliver: (keyId, keyVersion) => globals[0].deliver(keyId, keyVersion),
    async stopRegionMetadata() {
      region.client.close();
      await region.stop('SIGKILL');
    },
    startIndependentGlobalMeta: async () => globalMeta,
    async seedResources(count, onProgress = () => {}) {
      const scope = workspaceScope(region.server.authorityId, states[0].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      const guard = { ownerId: writer.records['system/writer'].value.ownerId };
      for (let offset = 0; offset < count; offset += 1000) {
        const changes = Array.from({ length: Math.min(1000, count - offset) }, (_, index) => {
          const n = offset + index;
          const id = `fs_scale_${String(n).padStart(8, '0')}`;
          return {
            key: `state/resources/${id}`,
            expectedVersion: null,
            value: {
              position: n + 100,
              record: {
                id,
                name: `scale-${n}`,
                kind: 'filesystem',
                region: 'aws-ap-southeast-1',
                provider: 'local',
                status: 'active',
                createdAt: states[0].workspace.createdAt,
              },
            },
          };
        });
        await region.client.call({ op: 'commit', scope, guard, mutationId: randomUUID(), changes });
        onProgress(Math.min(offset + changes.length, count));
      }
    },
    async seedKeys(count) {
      const scope = workspaceScope(region.server.authorityId, states[0].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      const guard = { ownerId: writer.records['system/writer'].value.ownerId };
      for (let offset = 0; offset < count; offset += 1000) {
        const changes = Array.from({ length: Math.min(1000, count - offset) }, (_, index) => {
          const id = `key_scale_${String(offset + index).padStart(8, '0')}`;
          return {
            key: `state/keys/${id}`,
            expectedVersion: null,
            value: {
              position: offset + index + 100,
              record: {
                id,
                name: id,
                digest: createHash('sha256').update(id).digest('hex'),
                scopes: ['resources:read'],
                resourceIds: ['*'],
                expiresAt: '2099-01-01T00:00:00.000Z',
                revokedAt: null,
              },
            },
          };
        });
        await region.client.call({ op: 'commit', scope, guard, mutationId: randomUUID(), changes });
      }
    },
    async seedFiles(count, resourceId) {
      const scope = workspaceScope(region.server.authorityId, states[0].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      const guard = { ownerId: writer.records['system/writer'].value.ownerId };
      for (let offset = 0; offset < count; offset += 1000) {
        const changes = Array.from({ length: Math.min(1000, count - offset) }, (_, index) => {
          const n = offset + index;
          const id = `file_scale_${String(n).padStart(8, '0')}`;
          return {
            key: `state/files/${id}`,
            expectedVersion: null,
            value: {
              position: n + 100,
              record: {
                id,
                resourceId: resourceId || `fs_cold_${n}`,
                path: resourceId ? `/synthetic-${String(n).padStart(8, '0')}.txt` : '/cold.txt',
                type: 'file',
                content: 'synthetic',
              },
            },
          };
        });
        await region.client.call({ op: 'commit', scope, guard, mutationId: randomUUID(), changes });
      }
    },
    async seedLocalFileSystem(id) {
      const scope = workspaceScope(region.server.authorityId, states[0].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      await region.client.call({
        op: 'commit',
        scope,
        guard: { ownerId: writer.records['system/writer'].value.ownerId },
        mutationId: randomUUID(),
        changes: [
          {
            key: `state/resources/${id}`,
            expectedVersion: null,
            value: {
              position: 50,
              record: {
                id,
                name: id,
                kind: 'filesystem',
                region: 'aws-us-east-1',
                provider: 'local',
                status: 'active',
                createdAt: states[0].workspace.createdAt,
              },
            },
          },
        ],
      });
    },
    async records(keys, workspace = 0) {
      const scope = workspaceScope(region.server.authorityId, states[workspace].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      const response = await region.client.call({
        op: 'get',
        scope,
        guard: { ownerId: writer.records['system/writer'].value.ownerId },
        keys,
      });
      return response.records;
    },
    async events(workspace = 0) {
      const scope = workspaceScope(region.server.authorityId, states[workspace].workspace.id);
      const writer = await region.client.call({ op: 'get', scope, keys: ['system/writer'] });
      return (
        await region.client.call({
          op: 'list',
          scope,
          guard: { ownerId: writer.records['system/writer'].value.ownerId },
          prefix: 'state/events/',
          after: null,
          limit: 512,
        })
      ).records.map((entry) => entry.value.record);
    },
    async restart({ crash = false } = {}) {
      writerRecovery = [];
      metadataRecovery = undefined;
      if (crash) {
        // Recovery names only the writers that this isolated fixture is about to stop.
        // It never uses initialization or an unconditional ownership/storage reset.
        for (const state of states) {
          const result = await region.client.call({
            op: 'get',
            scope: workspaceScope(region.server.authorityId, state.workspace.id),
            keys: ['system/writer'],
          });
          writerRecovery.push(result.records['system/writer'].value.ownerId);
        }
        if (transport === 'inProcess') metadataRecovery = (await region.client.health()).ownerId;
      }
      for (const child of children.toReversed())
        await meta.stop(child, crash ? 'SIGKILL' : 'SIGTERM');
      children.length = 0;
      cookies.length = 0;
      if (transport === 'remote') {
        region.client.close();
        await region.stop();
        region = await meta.service('reopened', { previous: region });
      }
      for (const global of globals) await global.restart();
      await start();
    },
  };
}
