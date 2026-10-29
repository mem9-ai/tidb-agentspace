import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './regression-api.mjs';
import { createStore, seed } from './store.mjs';
import { createFileAnalysis } from './file-analysis.mjs';
import { createAnalysisSnapshot } from './file-analysis-snapshot.mjs';
import { analysisLimits, analysisError } from './file-analysis-contract.mjs';
import {
  legacyBashInput,
  quoteBashPath,
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

test('analysis capabilities separate file format, default engine and individual availability', async () => {
  const a = engine();
  const csvCap = await a.capabilities(resource, '/ORDERS.CSV');
  assert.equal(csvCap.format, 'csv');
  assert.equal(csvCap.engine, 'duckdb');
  assert.equal(csvCap.available, true);
  assert.deepEqual(csvCap.engines, [
    { engine: 'duckdb', available: true, reason: '' },
    {
      engine: 'bash',
      available: true,
      reason: '',
      input: {
        path: '/ORDERS.CSV',
        workingDirectory: '/workspace',
        aliases: ['/workspace/input.log'],
        fileVariable: 'FILE',
      },
    },
  ]);
  assert.deepEqual(
    (await a.capabilities(resource, '/orders.parquet')).engines.map((e) => e.engine),
    ['duckdb'],
  );
  assert.deepEqual(
    (await a.capabilities(resource, '/README.md')).engines.map((e) => e.engine),
    ['bash'],
  );
  assert.deepEqual(
    (await a.capabilities(resource, '/data.json')).engines.map((e) => e.engine),
    ['bash'],
  );
  const unknown = await a.capabilities(resource, '/image.png');
  assert.equal(unknown.engine, null);
  assert.equal(unknown.available, false);
  assert.deepEqual(unknown.engines, []);
  const empty = await engine(Buffer.alloc(0)).capabilities(resource, '/empty.csv');
  assert.equal(empty.engine, 'duckdb');
  assert.equal(empty.available, false);
  assert.match(empty.engines[0].reason, /empty/);
  assert.deepEqual(empty.engines[1], {
    engine: 'bash',
    available: true,
    reason: '',
    input: {
      path: '/empty.csv',
      workingDirectory: '/workspace',
      aliases: ['/workspace/input.log'],
      fileVariable: 'FILE',
    },
  });
  for (const info of [
    { size: analysisLimits.inputBytes + 1 },
    { size: 12, versionAvailable: false },
  ]) {
    const limited = await engine(csv, { snapshot: async () => info }).capabilities(
      resource,
      '/orders.csv',
    );
    assert.equal(limited.available, false);
    assert.equal(limited.engines.length, 2);
    assert.ok(limited.engines.every((e) => !e.available && e.reason));
  }
});

test('the same CSV supports real SQL and raw-text Bash without broadening format or snapshot access', async () => {
  const a = engine();
  const bashCsv = (value) => ({
    resourceId: resource.id,
    path: '/orders.csv',
    engine: 'bash',
    command: value,
  });
  assert.equal((await a.execute(resource, sql('SELECT COUNT(*) AS n FROM file'))).rows[0].n, '4');
  const text = await a.execute(resource, bashCsv('cat /workspace/input.log'));
  assert.equal(text.engine, 'bash');
  assert.equal(text.stdout, csv.toString());
  assert.equal(
    (await a.execute(resource, bashCsv('head -1 input.log'))).stdout,
    'id,region,amount\n',
  );
  const malformed = Buffer.from('id,description\n1,"unterminated');
  assert.equal(
    (await engine(malformed).execute(resource, bashCsv('cat input.log'))).stdout,
    malformed.toString(),
  );
  assert.equal(
    (await engine(Buffer.alloc(0)).execute(resource, bashCsv('cat input.log'))).exitCode,
    0,
  );
  for (const bytes of [Buffer.from([0, 1]), Buffer.from([255])])
    await assert.rejects(engine(bytes).execute(resource, bashCsv('cat input.log')), {
      code: 'ANALYSIS_BINARY_TEXT',
    });
  assert.notEqual((await a.execute(resource, bashCsv('cat /workspace/other.csv'))).exitCode, 0);
  let snapshots = 0;
  const guarded = engine(csv, {
    snapshot: async () => {
      snapshots++;
      return { bytes: csv, size: csv.length };
    },
  });
  for (const input of [
    { ...bashCsv('cat input.log'), path: '/orders.parquet' },
    { ...sql('SELECT 1'), path: '/README.md' },
    { ...bashCsv('cat input.log'), engine: 'other' },
  ])
    await assert.rejects(guarded.execute(resource, input), { code: 'UNSUPPORTED_ANALYSIS' });
  for (const input of [
    { ...sql('SELECT 1'), command: 'cat input.log' },
    { ...bashCsv('cat input.log'), sql: 'SELECT 1' },
    { ...bashCsv('cat input.log'), command: undefined, sql: 'SELECT 1' },
    { ...bashCsv('cat input.log'), input: { path: '/etc/passwd' } },
    { ...bashCsv('cat input.log'), workspacePath: '/etc/passwd' },
    { ...bashCsv('cat "$FILE"'), env: { FILE: '/other.log' } },
  ])
    await assert.rejects(guarded.execute(resource, input), { code: 'INVALID_ANALYSIS' });
  assert.equal(snapshots, 0);
});

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
  for (const example of bashSamples('/docs/README.md'))
    assert.equal((await run(example.value)).exitCode, 0);
  const preview = await run(bashPreviewCommand('/docs/README.md'));
  assert.equal(preview.stdout, text);
  assert.equal((await run('head -20 input.log')).stdout, text);
  assert.equal((await run(bashPreviewCommand(legacyBashInput.path))).stdout, text);
  assert.equal((await run('cat /workspace/other.md')).exitCode, 1);
});

test('Bash exposes the selected Workspace path, quotes samples safely and keeps aliases read-only', async () => {
  const text = 'INFO ready\nERROR retry\n';
  const a = engine(Buffer.from(text));
  const nested = '/file-analysis-demo-9de2ebb1/service.log';
  for (const path of [
    nested,
    '/service.log',
    '/etc/selected.log',
    "/context/a' $(printf INJECTED) `printf BAD`; file.log",
    '/context/line\nbreak.log',
  ]) {
    const run = (script) => a.execute(resource, { ...command(script), path });
    const cap = await a.capabilities(resource, path);
    assert.deepEqual(cap.engines[0].input, {
      path,
      workingDirectory: '/workspace',
      aliases: ['/workspace/input.log'],
      fileVariable: 'FILE',
    });
    assert.equal((await run(`cat ${quoteBashPath(path)}`)).stdout, text);
    if (path === nested) assert.equal((await run(`cat ${path}`)).stdout, text);
    for (const example of bashSamples(path, cap.engines[0].input.fileVariable))
      assert.equal((await run(example.value)).exitCode, 0);
    assert.equal((await run('cat "$FILE"')).stdout, text);
    assert.equal((await run('cat "${FILE}"')).stdout, text);
    assert.equal((await run(bashPreviewCommand(path))).stdout, text);
    assert.equal((await run('pwd')).stdout, '/workspace\n');
    assert.equal((await run('cat /workspace/input.log')).stdout, text);
    assert.equal((await run('cat input.log')).stdout, text);
    assert.notEqual((await run('cat /context/other.log')).exitCode, 0);
    assert.notEqual((await run('cat /etc/passwd')).exitCode, 0);
    for (const target of [path, '/workspace/input.log']) {
      try {
        assert.notEqual((await run(`printf changed > ${quoteBashPath(target)}`)).exitCode, 0);
      } catch (error) {
        assert.equal(error.status, 422);
      }
    }
    assert.equal((await run(`cat ${quoteBashPath(path)}`)).stdout, text);
  }
});

test('Bash alias collisions never shadow the selected file or its parent directories', async () => {
  const text = 'selected snapshot\n';
  const a = engine(Buffer.from(text));
  for (const path of ['/workspace/input.log', '/workspace/input.log/nested.log']) {
    const cap = await a.capabilities(resource, path);
    assert.deepEqual(cap.engines[0].input, {
      path,
      workingDirectory: '/workspace',
      aliases: [],
      fileVariable: 'FILE',
    });
    const run = (script) => a.execute(resource, { ...command(script), path });
    assert.equal((await run('cat "$FILE"')).stdout, text);
    assert.equal((await run(bashPreviewCommand(path))).stdout, text);
    assert.equal((await run(`cat ${quoteBashPath(path)}`)).stdout, text);
    if (path === '/workspace/input.log') assert.equal((await run('cat input.log')).stdout, text);
    else assert.notEqual((await run('cat /workspace/input.log')).exitCode, 0);
    assert.notEqual((await run('cat /workspace/input.log/other.log')).exitCode, 0);
  }
});

test('FILE is bound to the selected path on each fresh run without inheriting private environment', async () => {
  const path = '/context/selected.log';
  const a = engine(log);
  const run = (script) => a.execute(resource, { ...command(script), path });
  const previousFile = process.env.FILE;
  const previousPrivate = process.env.ANALYSIS_FILE_PRIVATE_SENTINEL;
  process.env.FILE = '/private/parent-secret.log';
  process.env.ANALYSIS_FILE_PRIVATE_SENTINEL = 'do-not-forward';
  try {
    assert.equal((await run('cat "$FILE"')).stdout, log.toString());
    assert.equal((await run('printf "%s" "$FILE"')).stdout, path);
    assert.equal((await run('echo "$ANALYSIS_FILE_PRIVATE_SENTINEL"')).stdout, '\n');
    assert.notEqual((await run('FILE=/other.log; cat "$FILE"')).exitCode, 0);
    assert.equal((await run('unset FILE; printf "%s" "$FILE"')).stdout, '');
    assert.equal((await run('cat "$FILE"')).stdout, log.toString());
    try {
      assert.notEqual((await run('printf changed > "$FILE"')).exitCode, 0);
    } catch (error) {
      assert.equal(error.status, 422);
    }
    assert.equal((await run('cat "$FILE"')).stdout, log.toString());
  } finally {
    if (previousFile === undefined) delete process.env.FILE;
    else process.env.FILE = previousFile;
    if (previousPrivate === undefined) delete process.env.ANALYSIS_FILE_PRIVATE_SENTINEL;
    else process.env.ANALYSIS_FILE_PRIVATE_SENTINEL = previousPrivate;
  }
  assert.equal(
    bashSamples(legacyBashInput.path).some((sample) => sample.value.includes('$FILE')),
    false,
  );
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
  const requests = [
    sql('SELECT COUNT(*) AS n FROM file'),
    {
      resourceId: 'fs_shared',
      path: '/orders.csv',
      engine: 'bash',
      command: 'cat "$FILE"',
    },
  ];
  for (const [scopes, ids] of [
    [['files:read'], ['fs_shared']],
    [['files:analyze'], ['fs_shared']],
    [['files:read', 'files:analyze'], ['fs_other']],
  ]) {
    const k = await key(scopes, ids);
    for (const input of requests)
      assert.equal((await call(base + '/file-analyses', 'POST', input, k.secret)).status, 403);
  }
  for (const input of requests)
    assert.equal((await call(base + '/file-analyses', 'POST', input, 'expired')).status, 401);
  assert.equal(io, 0);
  const full = await key(['files:read', 'files:analyze']);
  for (const input of requests)
    assert.equal(
      (await call('/api/v1/workspaces/other/file-analyses', 'POST', input, full.secret)).status,
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
  assert.deepEqual(
    cap.body.engines.map((e) => e.engine),
    ['duckdb', 'bash'],
  );
  const result = await call(
    base + '/file-analyses',
    'POST',
    sql('SELECT COUNT(*) AS n FROM file'),
    full.secret,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.rows[0].n, '4');
  const bashResult = await call(base + '/file-analyses', 'POST', requests[1], full.secret);
  assert.equal(bashResult.status, 200);
  assert.equal(bashResult.body.engine, 'bash');
  assert.equal(bashResult.body.stdout, csv.toString());
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
  for (const input of requests)
    assert.equal((await call(base + '/file-analyses', 'POST', input, full.secret)).status, 401);
  assert.equal(io, previous);
});
