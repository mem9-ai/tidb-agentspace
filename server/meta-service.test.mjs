import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { metaFixture } from './test-support/meta-fixture.mjs';
import { createDocumentStore, documentScope, decodeDocument } from './meta/document-store.mjs';
import { migrateLegacy } from './meta/migrate.mjs';
import { exportLegacy } from './meta/export-legacy.mjs';
import { createApp } from './index.mjs';
import { seed, createStore } from './store.mjs';
import { createMetaClient } from './meta/client.mjs';
import { metadataCertificates } from './test-support/meta-tls.mjs';
import { walGate } from './test-support/meta-wal-gate.mjs';
import { until } from './test-support/meta-fixture.mjs';
import https from 'node:https';
import { initializeLocalRuntime } from './meta/local-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { privateJson } from './meta/client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test(
  'real S3 SlateDB services preserve atomicity, isolation, crash recovery and legacy credentials',
  { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 120_000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const global = await fixture.service('global');
    let a = await fixture.service('a');
    const b = await fixture.service('b');
    await assert.rejects(
      createMetaClient({ ...a.clientConfig, tokenFile: b.clientConfig.tokenFile }),
      { code: 'META_UNAUTHORIZED' },
    );
    await assert.rejects(
      createMetaClient({ ...a.clientConfig, installationId: 'wrong-installation' }),
      { code: 'META_INSTALLATION_MISMATCH' },
    );
    const scope = {
      authorityId: 'region:a',
      ownerKind: 'workspace',
      ownerId: 'ws_agentlab',
      family: 'resource',
      partitionId: 'one',
    };
    const initial = {
      op: 'commit',
      scope,
      expectedRevision: null,
      mutationId: randomUUID(),
      changes: [
        { key: 'value', value: 0 },
        { key: 'nullable', value: null },
      ],
    };
    const first = await a.client.call(initial);
    assert.equal((await a.client.call(initial)).replayed, true);
    await assert.rejects(a.client.call({ ...initial, changes: [{ key: 'value', value: 99 }] }), {
      code: 'META_MUTATION_MISMATCH',
    });
    const race = await Promise.allSettled(
      [1, 2].map((value) =>
        a.client.call({
          ...initial,
          expectedRevision: first.revision,
          mutationId: randomUUID(),
          changes: [{ key: 'value', value }],
        }),
      ),
    );
    assert.equal(race.filter((v) => v.status === 'fulfilled').length, 1);
    assert.equal(race.find((v) => v.status === 'rejected').reason.code, 'META_CONFLICT');
    await assert.rejects(b.client.call({ op: 'snapshot', scope }), {
      code: 'META_AUTHORITY_MISMATCH',
    });
    const other = await b.client.call({
      op: 'snapshot',
      scope: { ...scope, authorityId: 'region:b' },
    });
    assert.equal(other.revision, null);
    const before = await a.client.call({ op: 'snapshot', scope });
    const oldOwner = (await a.client.health()).ownerId;
    await global.stop();
    await a.stop('SIGKILL');
    a.client.close();
    a = await fixture.service('a', { previous: a, recoverOwner: oldOwner });
    assert.deepEqual(await a.client.call({ op: 'snapshot', scope }), before);
    assert.equal(
      (await a.client.call({ op: 'resolve', scope, mutationId: initial.mutationId })).outcome,
      'committed',
    );
    const stale = a;
    a = await fixture.service('a', {
      previous: stale,
      recoverOwner: (await stale.client.health()).ownerId,
    });
    await assert.rejects(stale.client.call({ op: 'snapshot', scope }), {
      code: 'META_OWNER_FENCED',
    });
    await assert.rejects(stale.client.call({ ...initial, mutationId: randomUUID() }), {
      code: 'META_OWNER_FENCED',
    });
    await stale.stop();
    stale.client.close();
    assert.deepEqual(await a.client.call({ op: 'snapshot', scope }), before);
    const g = await fixture.service('global', { previous: global });
    const sourceFile = resolve(fixture.directory, 'workspace.json');
    const configFile = resolve(fixture.directory, 'bridge.json');
    const state = seed();
    const token = 'fixture-original-workspace-key';
    state.keys = [
      {
        id: 'original-key',
        prefix: 'original',
        digest: createHash('sha256').update(token).digest('hex'),
        scopes: ['resources:read', 'files:read'],
        resourceIds: ['db_memory'],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        name: 'original',
      },
    ];
    state.unknown = { preserve: 'opaque legacy metadata' };
    const raw = [
      JSON.stringify(state),
      JSON.stringify({ bindings: { orphan: { apiKey: 'native-secret-preserve-exactly' } } }),
      '{"bindings":{}}',
      '{"bindings":{}}',
      JSON.stringify({
        bindings: {},
        account: { refreshToken: 'keep-original-account', state: 'received' },
      }),
    ];
    const suffixes = ['', '.providers.json', '.databases.json', '.duckdb.json', '.db9.json'];
    for (let i = 0; i < raw.length; i++)
      await writeFile(sourceFile + suffixes[i], raw[i], { mode: 0o600 });
    const config = {
      format: 1,
      importId: 'original-import',
      workspaceId: state.workspace.id,
      global: g.clientConfig,
      region: a.clientConfig,
      regionStorage: {
        engine: 'slatedb',
        bucket: a.server.s3.bucket,
        prefix: a.server.s3.prefix,
        installationId: a.server.installationId,
      },
    };
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const backupDirectory = resolve(fixture.directory, 'backup');
    const result = await migrateLegacy({
      sourceFile,
      backupDirectory,
      configFile,
      sourceFrozen: true,
    });
    assert.equal(result.verified, true);
    const names = ['workspace', 'drive9', 'zero', 'duckdb', 'db9'];
    for (let i = 0; i < names.length; i++) {
      const snapshot = await a.client.call({
        op: 'snapshot',
        scope: documentScope('region:a', state.workspace.id, names[i]),
      });
      assert.equal(decodeDocument(snapshot).toString(), raw[i]);
      assert.equal(await readFile(resolve(backupDirectory, names[i] + '.json'), 'utf8'), raw[i]);
    }
    await assert.rejects(createStore(sourceFile), /frozen/);
    assert.equal(
      (await migrateLegacy({ sourceFile, backupDirectory, configFile, sourceFrozen: true }))
        .replayed,
      true,
    );
    const documents = await createDocumentStore(
      a.client,
      documentScope('region:a', state.workspace.id, 'workspace'),
    );
    await documents.mutate((draft) => {
      draft.workspace.name = 'Persisted name';
    });
    await g.stop();
    const app = await createApp({ dataFile: sourceFile, metaConfig: configFile });
    await assert.rejects(createApp({ dataFile: sourceFile, metaConfig: configFile }), {
      code: 'META_GATEWAY_ACTIVE',
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      if (app.listening) await new Promise((r) => app.close(r));
    });
    const response = await fetch(
      `http://127.0.0.1:${app.address().port}/api/v1/workspaces/ws_agentlab/resources`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).data.map((r) => r.id),
      ['db_memory'],
    );
    const denied = await fetch(
      `http://127.0.0.1:${app.address().port}/api/v1/workspaces/ws_agentlab/files?resourceId=fs_shared`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(denied.status, 403);
    const listing = await fixture.s3('GET', `/${a.server.s3.bucket}?list-type=2`);
    const keys = [...(await listing.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    assert.ok(keys.some((k) => k.includes('/wal/')));
    for (const key of keys) {
      const bytes = Buffer.from(
        await (await fixture.s3('GET', `/${a.server.s3.bucket}/${key}`)).arrayBuffer(),
      );
      assert.equal(bytes.includes(Buffer.from('native-secret-preserve-exactly')), false);
      assert.equal(bytes.includes(Buffer.from('keep-original-account')), false);
    }
    await new Promise((r) => app.close(r));
    const exported = resolve(fixture.directory, 'rollback');
    await exportLegacy({ configFile, directory: exported, targetFrozen: true });
    const restored = JSON.parse(await readFile(resolve(exported, 'workspace.json')));
    assert.equal(restored.workspace.name, 'Persisted name');
    const latest = await a.client.call({
      op: 'snapshot',
      scope: documentScope('region:a', state.workspace.id, 'workspace'),
    });
    assert.deepEqual(restored, JSON.parse(decodeDocument(latest)));
    assert.equal(restored.keys[0].digest, state.keys[0].digest);
    for (let i = 1; i < raw.length; i++)
      assert.equal(
        await readFile(resolve(exported, 'workspace.json' + suffixes[i]), 'utf8'),
        raw[i],
      );
    const offline = await createApp({ dataFile: sourceFile, metaConfig: configFile });
    await new Promise((r) => offline.listen(0, '127.0.0.1', r));
    try {
      await a.stop();
      const health = await fetch(`http://127.0.0.1:${offline.address().port}/api/health`);
      assert.equal(health.status, 503);
      const schema = await fetch(`http://127.0.0.1:${offline.address().port}/openapi.json`);
      assert.equal(schema.status, 200);
    } finally {
      await new Promise((r) => offline.close(r));
    }
    await mkdir(resolve(fixture.directory, 'complete'), { mode: 0o700 });
  },
);

test(
  'mTLS rejects missing/wrong-purpose certificates, wrong hostname and TLS downgrade',
  { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 60_000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const certs = await metadataCertificates(fixture.directory);
    const local = await fixture.service('tls-local');
    await local.stop();
    local.client.close();
    const secure = await fixture.service('tls', {
      previous: local,
      tls: {
        insecureLoopback: false,
        tls: certs.server,
        s3: { ...local.server.s3, allowLoopbackHttp: true },
      },
      clientTls: certs.client,
    });
    assert.equal((await secure.client.health()).authorityId, local.server.authorityId);
    const credentials = {
      ca: await readFile(certs.client.caFile),
      cert: await readFile(certs.client.certificateFile),
      key: await readFile(certs.client.privateKeyFile),
    };
    const connect = (options) =>
      new Promise((resolve, reject) => {
        const req = https.request(
          secure.clientConfig.origin + '/health',
          { ...credentials, ...options },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end();
      });
    await assert.rejects(connect({ cert: undefined, key: undefined }));
    await assert.rejects(
      connect({
        cert: await readFile(certs.server.certificateFile),
        key: await readFile(certs.server.privateKeyFile),
      }),
    );
    await assert.rejects(connect({ servername: 'wrong.example' }));
    await assert.rejects(connect({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }));
    await assert.rejects(
      createMetaClient({
        ...secure.clientConfig,
        tokenFile: resolve(fixture.directory, 'not-present'),
      }),
    );
  },
);

test(
  'independent metadata requests progress while another ownership read is stalled',
  { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 60_000 },
  async (t) => {
    const fixture = await metaFixture();
    let gate;
    t.after(async () => {
      gate?.resume();
      gate?.resumeOwnerReads();
      await fixture.close();
      await gate?.close();
    });
    const original = await fixture.service('concurrent');
    await original.stop();
    original.client.close();
    gate = await walGate(original.server.s3.endpoint);
    const service = await fixture.service('concurrent', {
      previous: original,
      tls: { s3: { ...original.server.s3, endpoint: gate.origin } },
    });
    const scope = {
      authorityId: service.server.authorityId,
      ownerKind: 'workspace',
      ownerId: 'ws_test',
      family: 'resource',
      partitionId: 'slow',
    };
    const first = await service.client.call({
      op: 'commit',
      scope,
      expectedRevision: null,
      mutationId: randomUUID(),
      changes: [{ key: 'kept', value: true }],
    });
    gate.pauseNextOwnerRead();
    let finished = false;
    const slow = service.client.call({ op: 'snapshot', scope }).finally(() => {
      finished = true;
    });
    slow.catch(() => {});
    await until(async () => {
      if (gate.waitingOwnerReads !== 1) throw new Error('Waiting for the stalled owner read.');
    });
    const other = { ...scope, partitionId: 'independent' };
    const fast = service.client.call({
      op: 'commit',
      scope: other,
      expectedRevision: null,
      mutationId: randomUUID(),
      changes: [{ key: 'progress', value: true }],
    });
    const deadline = new AbortController();
    const timedOut = delay(5000, undefined, { signal: deadline.signal }).then(() => {
      assert.fail('An independent commit was blocked by the stalled metadata request.');
    });
    try {
      const result = await Promise.race([fast, timedOut]);
      const snapshot = await service.client.call({ op: 'snapshot', scope: other });
      assert.equal(snapshot.revision, result.revision);
      assert.equal(snapshot.records.progress, true);
      assert.equal(finished, false);
      assert.equal(gate.waitingOwnerReads, 1);
    } finally {
      deadline.abort();
      gate.resumeOwnerReads();
    }
    assert.equal((await slow).revision, first.revision);
    service.client.close();
  },
);

test(
  'native metadata transactions preserve revision races, duplicate receipts and coherent snapshots',
  { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 60_000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const service = await fixture.service('transactions');
    const scope = {
      authorityId: service.server.authorityId,
      ownerKind: 'workspace',
      ownerId: 'ws_test',
      family: 'resource',
      partitionId: 'one',
    };
    const commit = (partitionId, value, expectedRevision = null, mutationId = randomUUID()) => ({
      op: 'commit',
      scope: { ...scope, partitionId },
      expectedRevision,
      mutationId,
      changes: [
        { key: 'left', value },
        { key: 'right', value },
      ],
    });
    const initialized = await Promise.all(
      ['one', 'two', 'three', 'four'].map((id) => service.client.call(commit(id, 0))),
    );
    const duplicate = commit('one', 1, initialized[0].revision);
    const receipts = await Promise.all([0, 1, 2].map(() => service.client.call(duplicate)));
    assert.equal(new Set(receipts.map((r) => r.revision)).size, 1);
    assert.equal(receipts.filter((r) => r.replayed === false).length, 1);
    await assert.rejects(
      service.client.call({ ...duplicate, changes: [{ key: 'left', value: 999 }] }),
      { code: 'META_MUTATION_MISMATCH' },
    );
    const race = await Promise.allSettled(
      [2, 3, 4].map((v) => service.client.call(commit('one', v, receipts[0].revision))),
    );
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    for (const result of race.filter((r) => r.status === 'rejected'))
      assert.equal(result.reason.code, 'META_CONFLICT');
    let current = await service.client.call({ op: 'snapshot', scope });
    assert.equal(current.records.left, current.records.right);
    for (let version = 5; version < 10; version++) {
      const [result, ...reads] = await Promise.all([
        service.client.call(commit('one', version, current.revision)),
        ...[0, 1, 2].map(() => service.client.call({ op: 'snapshot', scope })),
      ]);
      for (const read of reads) {
        assert.equal(read.records.left, read.records.right);
        assert.ok([current.revision, result.revision].includes(read.revision));
        assert.equal(
          read.records.left,
          read.revision === result.revision ? version : current.records.left,
        );
      }
      current = await service.client.call({ op: 'snapshot', scope });
      assert.equal(current.revision, result.revision);
      assert.equal(current.records.left, version);
    }
    // Known native conflicts must leave the service usable for unrelated groups.
    await service.client.call(commit('after-conflict', true));
    assert.equal((await service.client.health()).authorityId, scope.authorityId);
    service.client.close();
  },
);

test(
  'metadata ACK and visibility wait for an object-durable WAL',
  { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 60_000 },
  async (t) => {
    const fixture = await metaFixture();
    let gate;
    t.after(async () => {
      gate?.resume();
      await fixture.close();
      await gate?.close();
    });
    const local = await fixture.service('durability');
    await local.stop();
    local.client.close();
    gate = await walGate(local.server.s3.endpoint);
    const service = await fixture.service('durability', {
      previous: local,
      tls: { s3: { ...local.server.s3, endpoint: gate.origin } },
    });
    gate.pause();
    const scope = {
      authorityId: service.server.authorityId,
      ownerKind: 'workspace',
      ownerId: 'ws_test',
      family: 'policy',
      partitionId: 'one',
    };
    const mutationId = randomUUID();
    let completed = false;
    const write = service.client
      .call({
        op: 'commit',
        scope,
        expectedRevision: null,
        mutationId,
        changes: [{ key: 'granted', value: true }],
      })
      .then((v) => {
        completed = true;
        return v;
      });
    await until(async () => {
      if (!gate.waiting) throw new Error('Waiting for WAL upload.');
    });
    assert.equal(completed, false);
    const ownerReadsBefore = gate.ownerReadCount;
    let readDone = false;
    let resolveDone = false;
    const read = service.client.call({ op: 'snapshot', scope }).finally(() => {
      readDone = true;
    });
    const receipt = service.client.call({ op: 'resolve', scope, mutationId }).finally(() => {
      resolveDone = true;
    });
    read.catch(() => {});
    receipt.catch(() => {});
    // Health can progress concurrently, but a pending memory grant/receipt cannot become truth.
    await service.client.health();
    await until(async () => {
      if (gate.ownerReadCount < ownerReadsBefore + 3)
        throw new Error('Waiting for snapshot, receipt and health admission.');
    });
    assert.equal(readDone, false);
    assert.equal(resolveDone, false);
    const stopping = service.stop();
    gate.resume();
    const [result, snapshot, resolved] = await Promise.all([write, read, receipt, stopping]);
    assert.equal(snapshot.revision, result.revision);
    assert.equal(snapshot.records.granted, true);
    assert.deepEqual(resolved, { outcome: 'committed', revision: result.revision });
    assert.equal(service.child.exitCode, 0);
    service.client.close();
    const reopened = await fixture.service('durability', { previous: service });
    assert.deepEqual(await reopened.client.call({ op: 'snapshot', scope }), snapshot);
    assert.deepEqual(await reopened.client.call({ op: 'resolve', scope, mutationId }), resolved);
    reopened.client.close();
  },
);

test(
  'local bootstrap retains independent installations and recovers after a clean supervisor restart',
  { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'metadata-bootstrap-'));
    const sourceFile = resolve(directory, 'workspace.json');
    await writeFile(sourceFile, JSON.stringify(seed()), { mode: 0o600 });
    const runtimeDirectory = resolve(directory, 'runtime');
    await initializeLocalRuntime({ directory: runtimeDirectory, sourceFile });
    let child;
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await exited;
      clearTimeout(timer);
    };
    t.after(async () => {
      await stop();
      await rm(directory, { recursive: true, force: true });
    });
    const start = async () => {
      const logPath = resolve(directory, 'supervisor-' + randomUUID() + '.log');
      const log = createWriteStream(logPath, { mode: 0o600 });
      child = spawn(
        process.execPath,
        ['server/meta/local-runtime.mjs', 'serve', '--directory', runtimeDirectory],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      await until(async () => {
        if (!(await readFile(logPath, 'utf8')).includes('Local metadata runtime ready.'))
          throw new Error('Waiting for supervisor.');
      });
    };
    await start();
    let topology = await privateJson(resolve(runtimeDirectory, 'topology.json'));
    assert.equal(new Set(topology.services.map((s) => s.client.installationId)).size, 3);
    const config = topology.services[2].client;
    let client = await createMetaClient(config);
    const scope = {
      authorityId: config.authorityId,
      ownerKind: 'workspace',
      ownerId: 'ws_test',
      family: 'resource',
      partitionId: 'one',
    };
    const revision = await client.call({
      op: 'commit',
      scope,
      expectedRevision: null,
      mutationId: randomUUID(),
      changes: [{ key: 'kept', value: true }],
    });
    client.close();
    await stop();
    await start();
    topology = await privateJson(resolve(runtimeDirectory, 'topology.json'));
    assert.ok(topology.services.every((s) => s.initialized));
    client = await createMetaClient(config);
    assert.equal((await client.call({ op: 'snapshot', scope })).revision, revision.revision);
    client.close();
  },
);
