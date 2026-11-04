import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import https from 'node:https';
import { metadataCertificates } from './test-support/meta-tls.mjs';
import { randomUUID } from 'node:crypto';
import { metaFixture, until } from './test-support/meta-fixture.mjs';
import { walGate } from './test-support/meta-wal-gate.mjs';
import { createMetaClient } from './meta/client.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const options = { skip: process.env.WORKSPACE_META_TEST !== '1', timeout: 120000 };
const execFileAsync = promisify(execFile);
const scope = (authorityId) => ({
  authorityId,
  ownerKind: 'workspace',
  ownerId: 'ws_test',
  family: 'workspace',
  partitionId: 'primary',
});
const change = (key, value, expectedVersion = null) => ({ key, value, expectedVersion });
const commit = (s, changes, mutationId = randomUUID()) => ({
  op: 'commit',
  scope: s,
  mutationId,
  changes,
});
const get = (s, keys) => ({ op: 'get', scope: s, keys });
test(
  'embedded workspace snapshot preserves isolation, revocation and writer fencing',
  options,
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const service = await fixture.service('snapshot');
    const configuration = resolve(fixture.directory, 'snapshot-in-process.json');
    await writeFile(configuration, JSON.stringify(service.server), { mode: 0o600 });
    await service.stop();
    service.client.close();
    await execFileAsync(
      'cargo',
      [
        'run',
        '--quiet',
        '--locked',
        '-p',
        'workspace-meta-service',
        '--example',
        'workspace_read_snapshot',
        '--',
        configuration,
      ],
      { timeout: 90000 },
    );
  },
);
test('inactive history is isolated and survives a real metadata restart', options, async (t) => {
  const fixture = await metaFixture();
  t.after(() => fixture.close());
  let service = await fixture.service('history');
  const configuration = resolve(fixture.directory, 'history-client.json');
  const run = async (stage) => {
    await writeFile(configuration, JSON.stringify(service.clientConfig), { mode: 0o600 });
    await execFileAsync(
      'cargo',
      [
        'run',
        '--quiet',
        '--locked',
        '-p',
        'workspace-domain',
        '--example',
        'history_fixture',
        '--',
        configuration,
        stage,
      ],
      { timeout: 90000 },
    );
  };
  await run('write');
  await service.stop();
  service.client.close();
  service = await fixture.service('history', { previous: service });
  await run('verify');
});
test(
  'record metadata preserves atomicity, per-record conflicts, receipts, scope isolation and crash recovery',
  options,
  async (t) => {
    const f = await metaFixture();
    t.after(() => f.close());
    const global = await f.service('global');
    let a = await f.service('a');
    const b = await f.service('b');
    const s = scope('region:a');
    const system = {
      authorityId: 'region:a',
      ownerKind: 'system',
      ownerId: 'control-plane',
      family: 'runtime-state',
      partitionId: 'security-clock',
    };
    const key = 'time-floor';
    await a.client.call(commit(system, [change(key, { floor: 123 })]));
    assert.equal((await a.client.call(get(s, [key]))).records[key], null);
    await assert.rejects(b.client.call(get(system, [key])), { code: 'META_AUTHORITY_MISMATCH' });
    await assert.rejects(
      createMetaClient({ ...a.clientConfig, tokenFile: b.clientConfig.tokenFile }),
      { code: 'META_UNAUTHORIZED' },
    );
    await assert.rejects(createMetaClient({ ...a.clientConfig, installationId: 'wrong' }), {
      code: 'META_INSTALLATION_MISMATCH',
    });
    const input = commit(s, [change('resources/one', { n: 1 }), change('resources/two', null)]);
    const first = await a.client.call(input);
    assert.equal((await a.client.call(input)).replayed, true);
    await assert.rejects(a.client.call({ ...input, changes: [change('resources/one', 99)] }), {
      code: 'META_MUTATION_MISMATCH',
    });
    const race = await Promise.allSettled(
      [2, 3].map((n) => a.client.call(commit(s, [change('resources/one', { n }, first.version)]))),
    );
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'META_CONFLICT');
    const independent = await Promise.all([
      a.client.call(commit(s, [change('resources/independent-a', 1)])),
      a.client.call(commit(s, [change('resources/independent-b', 2)])),
    ]);
    assert.equal(independent.length, 2);
    await assert.rejects(b.client.call(get(s, ['resources/one'])), {
      code: 'META_AUTHORITY_MISMATCH',
    });
    assert.equal(
      (await a.client.call(get({ ...s, ownerId: 'ws_other' }, ['resources/one']))).records[
        'resources/one'
      ],
      null,
    );
    const before = await a.client.call(get(s, ['resources/one', 'resources/two']));
    const owner = (await a.client.health()).ownerId;
    await global.stop();
    await a.stop('SIGKILL');
    a.client.close();
    a = await f.service('a', { previous: a, recoverOwner: owner });
    assert.deepEqual(await a.client.call(get(s, ['resources/one', 'resources/two'])), before);
    assert.deepEqual((await a.client.call(get(system, [key]))).records[key].value, { floor: 123 });
    assert.equal(
      (await a.client.call({ op: 'resolve', scope: s, mutationId: input.mutationId })).outcome,
      'committed',
    );
    const stale = a;
    a = await f.service('a', {
      previous: stale,
      recoverOwner: (await stale.client.health()).ownerId,
    });
    await assert.rejects(stale.client.call(get(s, ['resources/one'])), {
      code: 'META_OWNER_FENCED',
    });
    await stale.stop();
    stale.client.close();
    assert.deepEqual(await a.client.call(get(s, ['resources/one', 'resources/two'])), before);
  },
);
test(
  'record pagination stays ordered and bounded beyond the old snapshot group limit',
  options,
  async (t) => {
    const f = await metaFixture();
    t.after(() => f.close());
    const a = await f.service('paging');
    const s = scope(a.server.authorityId);
    for (let i = 0; i < 600; i += 100)
      await a.client.call(
        commit(
          s,
          Array.from({ length: 100 }, (_, j) =>
            change(`resources/${String(i + j).padStart(5, '0')}`, { n: i + j }),
          ),
        ),
      );
    await a.client.call(
      commit(s, [
        change('credentials/private', { password: 'private-test-credential' }),
        change('resource-other', true),
      ]),
    );
    let after = null;
    const keys = [];
    do {
      const page = await a.client.call({
        op: 'list',
        scope: s,
        prefix: 'resources/',
        after,
        limit: 17,
      });
      assert.ok(page.records.length <= 17);
      keys.push(...page.records.map((r) => r.key));
      after = page.nextCursor;
    } while (after);
    assert.equal(keys.length, 600);
    assert.deepEqual([...keys].sort(), keys);
    assert.equal(new Set(keys).size, 600);
    for (const limit of [0, 513])
      await assert.rejects(
        a.client.call({ op: 'list', scope: s, prefix: 'resources/', after: null, limit }),
        { code: 'META_INVALID_REQUEST' },
      );
    await assert.rejects(
      a.client.call({
        op: 'list',
        scope: s,
        prefix: 'resources/',
        after: 'credentials/private',
        limit: 17,
      }),
      { code: 'META_INVALID_REQUEST' },
    );
    const unchanged = (await a.client.call(get(s, ['resources/00000']))).records['resources/00000'];
    const target = (await a.client.call(get(s, ['resources/00599']))).records['resources/00599'];
    await a.client.call(commit(s, [change('resources/00599', { n: 999 }, target.version)]));
    assert.deepEqual(
      (await a.client.call(get(s, ['resources/00000']))).records['resources/00000'],
      unchanged,
    );
    const listing = await f.s3('GET', `/${a.server.s3.bucket}?list-type=2`);
    const objects = [...(await listing.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    for (const key of objects) {
      const bytes = Buffer.from(
        await (await f.s3('GET', `/${a.server.s3.bucket}/${key}`)).arrayBuffer(),
      );
      assert.equal(bytes.includes(Buffer.from('private-test-credential')), false);
    }
  },
);
test(
  'independent metadata requests progress during a stalled ownership read',
  options,
  async (t) => {
    const f = await metaFixture();
    let gate;
    t.after(async () => {
      gate?.resumeOwnerReads();
      await f.close();
      await gate?.close();
    });
    const old = await f.service('progress');
    await old.stop();
    old.client.close();
    gate = await walGate(old.server.s3.endpoint);
    const a = await f.service('progress', {
      previous: old,
      tls: { s3: { ...old.server.s3, endpoint: gate.origin } },
    });
    const s = scope(a.server.authorityId);
    gate.pauseNextOwnerRead();
    let done = false;
    const slow = a.client.call(get(s, ['slow'])).finally(() => {
      done = true;
    });
    slow.catch(() => {});
    await until(async () => assert.equal(gate.waitingOwnerReads, 1));
    const abort = new AbortController();
    try {
      await Promise.race([
        a.client.call(commit(s, [change('independent', true)])),
        delay(5000, undefined, { signal: abort.signal }).then(() =>
          assert.fail('An unrelated request was serialized.'),
        ),
      ]);
      assert.equal(done, false);
    } finally {
      abort.abort();
      gate.resumeOwnerReads();
    }
    await slow;
  },
);
test(
  'record ACK, coherent reads and receipts await object durability and drain before shutdown',
  options,
  async (t) => {
    const f = await metaFixture();
    let gate;
    t.after(async () => {
      gate?.resume();
      await f.close();
      await gate?.close();
    });
    const old = await f.service('durable');
    await old.stop();
    old.client.close();
    gate = await walGate(old.server.s3.endpoint);
    const a = await f.service('durable', {
      previous: old,
      tls: { s3: { ...old.server.s3, endpoint: gate.origin } },
    });
    const s = scope(a.server.authorityId);
    const input = commit(s, [change('grant', true), change('matching', true)]);
    gate.pause();
    let acknowledged = false;
    const write = a.client.call(input).then((r) => {
      acknowledged = true;
      return r;
    });
    await until(async () => assert.ok(gate.waiting));
    assert.equal(acknowledged, false);
    const count = gate.ownerReadCount;
    let readDone = false;
    let receiptDone = false;
    const read = a.client.call(get(s, ['grant', 'matching'])).finally(() => {
      readDone = true;
    });
    const receipt = a.client
      .call({ op: 'resolve', scope: s, mutationId: input.mutationId })
      .finally(() => {
        receiptDone = true;
      });
    read.catch(() => {});
    receipt.catch(() => {});
    await a.client.health();
    await until(async () => assert.ok(gate.ownerReadCount >= count + 3));
    assert.equal(readDone, false);
    assert.equal(receiptDone, false);
    const stopping = a.stop();
    gate.resume();
    const [result, records, resolved] = await Promise.all([write, read, receipt, stopping]);
    for (const v of Object.values(records.records)) {
      assert.equal(v.version, result.version);
      assert.equal(v.value, true);
    }
    assert.equal(resolved.version, result.version);
    assert.equal(a.child.exitCode, 0);
    a.client.close();
    const reopened = await f.service('durable', { previous: a });
    assert.deepEqual(await reopened.client.call(get(s, ['grant', 'matching'])), records);
  },
);
test(
  'workspace writer fencing protects cached reads and mutations without legacy document guards',
  options,
  async (t) => {
    const f = await metaFixture();
    t.after(() => f.close());
    const a = await f.service('writers');
    const s = scope(a.server.authorityId);
    const first = await a.client.call(commit(s, [change('system/writer', { ownerId: 'first' })]));
    const guard = { ownerId: 'first' };
    await a.client.call({ ...commit(s, [change('state/workspace', { id: 'ws_test' })]), guard });
    await assert.rejects(a.client.call(get(s, ['state/workspace'])), {
      code: 'META_WRITER_REQUIRED',
    });
    await a.client.call(commit(s, [change('system/writer', { ownerId: 'second' }, first.version)]));
    await assert.rejects(a.client.call({ ...get(s, ['state/workspace']), guard }), {
      code: 'META_WRITER_FENCED',
    });
    await assert.rejects(a.client.call({ ...commit(s, [change('resource', true)]), guard }), {
      code: 'META_WRITER_FENCED',
    });
    assert.equal(
      (await a.client.call({ ...get(s, ['state/workspace']), guard: { ownerId: 'second' } }))
        .records['state/workspace'].value.id,
      'ws_test',
    );
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
