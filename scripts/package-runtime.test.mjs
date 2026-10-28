import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { copySqlDependencies } from './sql-runtime-dependencies.mjs';
import { buildApi } from './build-api.mjs';
import { packageRuntime } from './package-runtime.mjs';

async function listen(app) {
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

test('API builds without a frontend; separate archives boot independently without installs or secrets', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'tidb-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../server/', import.meta.url), resolve(root, 'server'), { recursive: true });
  await mkdir(resolve(root, 'public'));
  await cp(
    new URL('../public/openapi.json', import.meta.url),
    resolve(root, 'public/openapi.json'),
  );
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  await writeFile(resolve(root, '.node-version'), '24.22.1\n');
  await copySqlDependencies(fileURLToPath(new URL('../', import.meta.url)), root);
  await buildApi({ root });
  const apiPackage = JSON.parse(await readFile(resolve(root, 'dist/api/package.json'), 'utf8'));
  assert.equal(apiPackage.dependencies, undefined);
  await mkdir(resolve(root, 'dist/console'), { recursive: true });
  await writeFile(
    resolve(root, 'dist/console/index.html'),
    '<!doctype html><title>Independent Console</title>',
  );
  await writeFile(
    resolve(root, 'dist/console/config.json'),
    JSON.stringify({ apiOrigin: 'http://127.0.0.1:4318' }),
  );
  await mkdir(resolve(root, 'scripts'));
  await cp(
    new URL('./serve-console.mjs', import.meta.url),
    resolve(root, 'scripts/serve-console.mjs'),
  );
  await mkdir(resolve(root, '.data'));
  await writeFile(resolve(root, '.data/private.json'), 'secret');
  await writeFile(resolve(root, '.env'), 'secret');
  const artifacts = await packageRuntime({
    root,
    destination: resolve(root, 'output'),
    sourceSha: 'a'.repeat(40),
  });
  assert.equal(artifacts.length, 2);
  const checksums = await readFile(resolve(root, 'output/SHA256SUMS'), 'utf8');
  for (const artifact of artifacts) {
    const { component } = artifact.info;
    const entries = execFileSync('tar', ['-tzf', artifact.archive], { encoding: 'utf8' });
    for (const excluded of ['.data', '.env', '.test.mjs', 'generate-openapi'])
      assert.ok(!entries.includes(excluded));
    assert.equal(artifact.info.sourceSha, 'a'.repeat(40));
    assert.equal(artifact.info.deployed, false);
    assert.equal(
      artifact.digest,
      createHash('sha256')
        .update(await readFile(artifact.archive))
        .digest('hex'),
    );
    assert.ok(checksums.includes(`${artifact.digest}  workspace-${component}.tar.gz`));
    const unpacked = resolve(root, 'unpacked-' + component);
    await mkdir(unpacked);
    execFileSync('tar', ['-xzf', artifact.archive, '-C', unpacked]);
    let app;
    if (component === 'api') {
      assert.ok(entries.includes('api/public/openapi.json'));
      assert.ok(entries.includes('api/node_modules/mysql2/package.json'));
      assert.ok(!entries.includes('api/node_modules/pg/package.json'));
      assert.ok(!entries.includes('api/node_modules/react/'));
      const runtimeRequire = createRequire(resolve(unpacked, 'api/server/index.mjs'));
      assert.equal(typeof runtimeRequire('mysql2').createConnection, 'function');
      const { DuckDBInstance } = runtimeRequire('@duckdb/node-api');
      const native = await DuckDBInstance.create(':memory:');
      const nativeConnection = await native.connect();
      assert.equal(
        (await nativeConnection.runAndReadAll('SELECT 42 AS value')).getRowObjectsJson()[0].value,
        42,
      );
      nativeConnection.closeSync();
      native.closeSync();
      assert.ok(entries.includes('api/server/providers/drive9.mjs'));
      assert.ok(!entries.includes('index.html') && !entries.includes('console'));
      const { createApp } = await import(
        pathToFileURL(resolve(unpacked, 'api/server/index.mjs')).href
      );
      app = await createApp({ filesProvider: 'local', mysqlProvider: 'local' });
      const origin = await listen(app);
      try {
        assert.equal((await fetch(origin + '/api/health')).status, 200);
        assert.equal((await (await fetch(origin + '/openapi.json')).json()).openapi, '3.1.0');
        assert.equal((await fetch(origin + '/')).status, 404);
        assert.equal((await fetch(origin + '/api/v1/workspaces')).status, 401);
      } finally {
        await new Promise((resolve) => app.close(resolve));
      }
    } else {
      assert.ok(!entries.includes('node_modules'));
      assert.ok(!entries.includes('/server/') && !entries.includes('openapi.json'));
      const { createConsoleServer } = await import(
        pathToFileURL(resolve(unpacked, 'console/serve-console.mjs')).href
      );
      app = createConsoleServer({
        directory: resolve(unpacked, 'console/static'),
        apiOrigin: 'http://127.0.0.1:4999',
      });
      const origin = await listen(app);
      try {
        assert.match(await (await fetch(origin)).text(), /Independent Console/);
        assert.equal(
          (await (await fetch(origin + '/config.json')).json()).apiOrigin,
          'http://127.0.0.1:4999',
        );
        assert.equal((await fetch(origin + '/api/health')).status, 404);
        assert.equal((await fetch(origin + '/openapi.json')).status, 404);
        assert.equal((await fetch(origin + '/missing.js')).status, 404);
      } finally {
        await new Promise((resolve) => app.close(resolve));
      }
    }
  }
});
