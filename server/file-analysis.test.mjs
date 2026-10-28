import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './index.mjs';
import { createStore, seed } from './store.mjs';
import { createFileAnalysis } from './file-analysis.mjs';
import { createAnalysisSnapshot } from './file-analysis-snapshot.mjs';
import { analysisLimits, analysisError } from './file-analysis-contract.mjs';
import {
  bashInputPath,
  bashPreviewCommand,
  bashSamples,
} from '../src/features/files/bash-analysis.ts';
const csv = Buffer.from('id,region,amount\n1,APAC,10\n2,APAC,20\n3,EU,5\n4,EU,15\n');
const log = Buffer.from('INFO started\nERROR timeout\nINFO retry\nERROR unavailable\n');
const resource = { id: 'fs_shared', kind: 'filesystem', status: 'active' };
const sql = (script, path = '/orders.csv') => ({
  resourceId: resource.id,
  path,
  engine: 'duckdb',
  sql: script,
});
const command = (script) => ({
  resourceId: resource.id,
  path: '/service.log',
  engine: 'bash',
  command: script,
});
function engine(bytes = csv, options = {}) {
  return createFileAnalysis({ snapshot: async () => ({ bytes, size: bytes.length }), ...options });
}

test('real DuckDB queries CSV/Parquet snapshots, preserves precision and column/schema data', async () => {
  const unavailable = createFileAnalysis({
    snapshot: async () => ({ size: 12, versionAvailable: false }),
  });
  assert.equal((await unavailable.capabilities(resource, '/orders.csv')).available, false);
  const a = engine();
  const result = await a.execute(
    resource,
    sql('SELECT region,SUM(amount) AS total FROM file GROUP BY region ORDER BY region'),
  );
  assert.deepEqual(result.rows, [
    { region: 'APAC', total: '30' },
    { region: 'EU', total: '20' },
  ]);
  assert.ok(result.schema.some((c) => c.column_name === 'amount'));
  assert.equal(result.readOnly, true);
  const precision = await a.execute(
    resource,
    sql('SELECT 9007199254740993::BIGINT AS n, NULL AS missing, 1 AS n'),
  );
  assert.deepEqual(precision.rows, [{ n: '9007199254740993', missing: null, 'n:1': 1 }]);
  const dir = await mkdtemp(join(tmpdir(), 'analysis-parquet-'));
  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const db = await DuckDBInstance.create(':memory:');
    const c = await db.connect();
    try {
      await c.run(
        `COPY (SELECT * FROM (VALUES ('APAC',30),('EU',20)) AS t(region,amount)) TO '${dir}/input.parquet' (FORMAT PARQUET)`,
      );
    } finally {
      c.closeSync();
      db.closeSync();
    }
    const parquet = await engine(await readFile(join(dir, 'input.parquet'))).execute(
      resource,
      sql('SELECT * FROM file ORDER BY region', '/orders.parquet'),
    );
    assert.deepEqual(parquet.rows, [
      { region: 'APAC', amount: 30 },
      { region: 'EU', amount: 20 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DuckDB enforces statement semantics, disabled external access and no secrets', async () => {
  const a = engine();
  for (const script of [
    'DROP TABLE file',
    "INSERT INTO file VALUES(5,'EU',10)",
    "COPY file TO '/tmp/analysis-escape.csv'",
    'SET enable_external_access=true',
    "LOAD 'httpfs'",
    'SELECT 1; SELECT 2',
    "SELECT * FROM read_csv_auto('/etc/passwd')",
    "SELECT * FROM read_csv_auto('https://example.com/data.csv')",
    "SELECT * FROM sqlite_scan('/etc/passwd','x')",
  ]) {
    await assert.rejects(
      a.execute(resource, sql(script)),
      (e) =>
        e.status === 422 &&
        !e.message.includes('/etc/passwd') &&
        !e.message.includes('analysis-escape'),
    );
  }
  const settings = await a.execute(
    resource,
    sql("SELECT current_setting('enable_external_access') AS enabled"),
  );
  assert.equal(settings.rows[0].enabled, false);
  await assert.rejects(a.execute(resource, sql('SELECT * FROM duckdb_secrets()')), {
    code: 'ANALYSIS_FAILED',
  });
  await assert.rejects(a.execute(resource, sql('SELECT * FROM range(1001)')), {
    code: 'ANALYSIS_OUTPUT_LIMIT',
  });
  await assert.rejects(a.execute(resource, sql("SELECT repeat('x',1048577) AS large")), {
    code: 'ANALYSIS_OUTPUT_LIMIT',
  });
  await assert.rejects(
    a.execute(resource, sql('SELECT COUNT(*) FROM (SELECT DISTINCT i FROM range(10000000) t(i))')),
    { code: 'ANALYSIS_FAILED' },
  );
  assert.equal((await a.execute(resource, sql('SELECT COUNT(*) AS n FROM file'))).rows[0].n, '4');
  await assert.rejects(
    engine(Buffer.from('not parquet')).execute(resource, sql('SELECT * FROM file', '/bad.parquet')),
    { code: 'ANALYSIS_FAILED' },
  );
});

test('Just Bash Console examples use the actual input path for a selected Markdown snapshot', async () => {
  const text = '# Selected README\n\nERROR example\n';
  const a = engine(Buffer.from(text));
  const run = (value) => a.execute(resource, { ...command(value), path: '/docs/README.md' });
  const wrong = await run('head ./README.md');
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.stderr, /No such file or directory/);
  for (const example of bashSamples) assert.equal((await run(example.value)).exitCode, 0);
  const preview = await run(bashPreviewCommand);
  assert.equal(preview.stdout, text);
  assert.equal((await run('head -20 input.log')).stdout, text);
  assert.equal((await run(`head -20 ${bashInputPath}`)).stdout, text);
  assert.equal((await run('cat /workspace/other.md')).exitCode, 1);
});

test('Just Bash executes actual grep/awk/pipelines without host files, network, credentials or writes', async () => {
  const a = engine(log);
  const result = await a.execute(
    resource,
    command('grep -n ERROR /workspace/input.log | head -20'),
  );
  assert.equal(result.stdout, '2:ERROR timeout\n4:ERROR unavailable\n');
  assert.equal(result.exitCode, 0);
  assert.equal(
    (await a.execute(resource, command('grep ERROR input.log | wc -l'))).stdout.trim(),
    '2',
  );
  assert.equal(
    (await a.execute(resource, command("awk '{print $1}' input.log | sort | uniq -c"))).exitCode,
    0,
  );
  assert.equal((await a.execute(resource, command('grep NOMATCH input.log'))).exitCode, 1);
  for (const script of [
    'cat /etc/passwd',
    'cat /workspace/other.log',
    'curl https://example.com',
    'node -e true',
    'python3 -c 1',
  ])
    assert.notEqual((await a.execute(resource, command(script))).exitCode, 0);
  process.env.ANALYSIS_PRIVATE_SENTINEL = 'do-not-forward';
  try {
    assert.equal(
      (await a.execute(resource, command('echo "$ANALYSIS_PRIVATE_SENTINEL"'))).stdout,
      '\n',
    );
  } finally {
    delete process.env.ANALYSIS_PRIVATE_SENTINEL;
  }
  for (const script of [
    'printf changed > /workspace/input.log',
    'sed -i s/ERROR/INFO/ input.log',
  ]) {
    try {
      const r = await a.execute(resource, command(script));
      assert.notEqual(r.exitCode, 0);
    } catch (e) {
      assert.equal(e.status, 422);
    }
  }
  assert.equal(
    (await a.execute(resource, command('grep ERROR input.log | wc -l'))).stdout.trim(),
    '2',
  );
  await assert.rejects(engine(Buffer.from([0, 255])).execute(resource, command('cat input.log')), {
    code: 'ANALYSIS_BINARY_TEXT',
  });
  const limited = await a.execute(resource, command('while true; do echo x; done'));
  assert.notEqual(limited.exitCode, 0);
  assert.ok(limited.stdout.length < 10000);
  try {
    const output = await a.execute(resource, command('seq 1 400000'));
    assert.notEqual(output.exitCode, 0);
    assert.ok(Buffer.byteLength(output.stdout + output.stderr) <= analysisLimits.outputBytes);
  } catch (error) {
    assert.equal(error.status, 422);
  }
});

test('supervisor kills expired/canceled workers, bounds concurrent work, and cleans snapshots after errors', async () => {
  await assert.rejects(
    engine(csv, { limits: { ...analysisLimits, timeoutMs: 5 } }).execute(
      resource,
      sql('SELECT * FROM file'),
    ),
    { code: 'ANALYSIS_TIMEOUT' },
  );
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(engine().execute(resource, sql('SELECT 1'), canceled.signal), {
    code: 'ANALYSIS_CANCELED',
  });
  const liveCancel = new AbortController();
  const work = engine().execute(
    resource,
    sql('SELECT * FROM range(10000000000)'),
    liveCancel.signal,
  );
  setTimeout(() => liveCancel.abort(), 30);
  await assert.rejects(work, { code: 'ANALYSIS_CANCELED' });
  let release;
  const wait = new Promise((r) => (release = r));
  let directory;
  const a = engine(csv, {
    runner: async (input) => {
      directory = input.directory;
      assert.ok((await stat(input.sourcePath)).isFile());
      await wait;
      throw analysisError(422, 'TEST_FAILURE', 'Controlled failure.');
    },
  });
  const first = a.execute(resource, sql('SELECT 1'));
  const second = a.execute(resource, sql('SELECT 1'));
  await assert.rejects(a.execute(resource, sql('SELECT 1')), { code: 'ANALYSIS_BUSY' });
  release();
  await Promise.all([
    assert.rejects(first, { code: 'TEST_FAILURE' }),
    assert.rejects(second, { code: 'TEST_FAILURE' }),
  ]);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await assert.rejects(
    engine(Buffer.alloc(analysisLimits.inputBytes + 1)).execute(resource, sql('SELECT 1')),
    { code: 'ANALYSIS_INPUT_LIMIT' },
  );
});

test('live snapshots preflight size, enforce read bounds, version conditions and cancellation', async () => {
  let reads = 0,
    stats = 0;
  let size = csv.length,
    changed = false;
  const drive9 = {
    stat: async () => ({ size, directory: false, revision: changed && stats++ ? '"v2"' : '"v1"' }),
    read: async (_id, _path, options) => {
      reads++;
      assert.equal(options.headers['If-Match'], '"v1"');
      return new Response(csv);
    },
  };
  const read = createAnalysisSnapshot({ drive9 });
  const live = { ...resource, provider: 'drive9-anonymous' };
  size = analysisLimits.inputBytes + 1;
  assert.equal((await read(live, '/x.csv', null, true)).size, size);
  await assert.rejects(read(live, '/x.csv'), { code: 'ANALYSIS_INPUT_LIMIT' });
  assert.equal(reads, 0);
  size = csv.length;
  assert.deepEqual((await read(live, '/x.csv')).bytes, csv);
  changed = true;
  stats = 0;
  await assert.rejects(read(live, '/x.csv'), { code: 'FILE_CHANGED' });
  const growing = createAnalysisSnapshot({
    drive9: {
      stat: async () => ({ size: 2, revision: '"v1"' }),
      read: async () => new Response(csv),
    },
  });
  await assert.rejects(growing(live, '/x.csv'), { code: 'ANALYSIS_INPUT_LIMIT' });
  const abort = new AbortController();
  let canceled = false;
  const hanging = createAnalysisSnapshot({
    drive9: {
      stat: async () => ({ size: 2, revision: '"v1"' }),
      read: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
        ),
    },
  });
  const pending = hanging(live, '/x.csv', abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending);
  assert.equal(canceled, true);
});

test('Workspace analysis checks actions, resources, workspace, expiration and revocation before I/O', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-api-'));
  const dataFile = join(dir, 'state.json');
  const state = seed();
  state.resources.push({ ...resource, id: 'fs_other', name: 'other' });
  state.files.push({
    id: 'csv',
    resourceId: 'fs_shared',
    path: '/orders.csv',
    type: 'file',
    content: csv.toString(),
    updatedAt: new Date().toISOString(),
  });
  state.keys.push({
    id: 'expired',
    digest: createHash('sha256').update('expired').digest('hex'),
    resourceIds: ['fs_shared'],
    scopes: ['files:read', 'files:analyze'],
    expiresAt: '2000-01-01',
  });
  const store = await createStore(dataFile, () => state);
  await store.mutate(() => {});
  let io = 0;
  const snapshot = createAnalysisSnapshot({ store });
  const app = await createApp({
    dataFile,
    filesProvider: 'local',
    mysqlProvider: 'local',
    analysisSnapshot: async (...args) => {
      io++;
      return snapshot(...args);
    },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  let cookie;
  const base = '/api/v1/workspaces/ws_agentlab';
  async function call(path, method = 'GET', body, token) {
    const r = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie || '' }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  cookie = session.headers.get('set-cookie').split(';')[0];
  async function key(scopes, resourceIds = ['fs_shared']) {
    const r = await call(base + '/keys', 'POST', {
      name: 'analysis-test',
      scopes,
      resourceIds,
      expiresInDays: 7,
    });
    assert.equal(r.status, 201);
    return r.body;
  }
  for (const [scopes, ids] of [
    [['files:read'], ['fs_shared']],
    [['files:analyze'], ['fs_shared']],
    [['files:read', 'files:analyze'], ['fs_other']],
  ]) {
    const k = await key(scopes, ids);
    assert.equal(
      (await call(base + '/file-analyses', 'POST', sql('SELECT 1'), k.secret)).status,
      403,
    );
  }
  assert.equal(
    (await call(base + '/file-analyses', 'POST', sql('SELECT 1'), 'expired')).status,
    401,
  );
  assert.equal(io, 0);
  const full = await key(['files:read', 'files:analyze']);
  assert.equal(
    (await call('/api/v1/workspaces/other/file-analyses', 'POST', sql('SELECT 1'), full.secret))
      .status,
    404,
  );
  assert.equal(io, 0);
  const cap = await call(
    base + '/file-analyses/capabilities?resourceId=fs_shared&path=/orders.csv',
    'GET',
    null,
    full.secret,
  );
  assert.equal(cap.body.available, true);
  const result = await call(
    base + '/file-analyses',
    'POST',
    sql('SELECT COUNT(*) AS n FROM file'),
    full.secret,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.rows[0].n, '4');
  assert.equal(
    JSON.parse(await readFile(dataFile, 'utf8')).files.find((f) => f.id === 'csv').content,
    csv.toString(),
  );
  assert.equal(
    (
      await call(
        base + '/file-analyses',
        'POST',
        { ...sql('SELECT 1'), host: '/etc/passwd' },
        full.secret,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        base + '/file-analyses',
        'POST',
        { ...sql('SELECT 1'), path: '/../orders.csv' },
        full.secret,
      )
    ).status,
    400,
  );
  const previous = io;
  await call(base + '/keys/' + full.data.id, 'DELETE');
  assert.equal(
    (await call(base + '/file-analyses', 'POST', sql('SELECT 1'), full.secret)).status,
    401,
  );
  assert.equal(io, previous);
});
