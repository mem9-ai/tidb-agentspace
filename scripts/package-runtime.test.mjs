import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { packageRuntime, copySqlDependencies } from './package-runtime.mjs';

test('runtime artifacts include the contract and source identity but exclude local secrets/data', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'tidb-package-test-'));
  try {
    for (const path of ['dist', 'server', 'public', '.data']) await mkdir(resolve(root, path));
    for (const path of [
      'dist/index.html',
      'server/index.mjs',
      'server/store.mjs',
      'server/access-policy.mjs',
      'public/openapi.json',
      '.data/private.json',
      '.env',
    ])
      await writeFile(resolve(root, path), 'fixture');
    await cp(new URL('../server/', import.meta.url), resolve(root, 'server'), { recursive: true });
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
    await writeFile(resolve(root, '.node-version'), '24.22.1\n');
    await copySqlDependencies(fileURLToPath(new URL('../', import.meta.url)), root);
    const result = await packageRuntime({
      root,
      destination: resolve(root, 'output'),
      sourceSha: 'a'.repeat(40),
    });
    const entries = execFileSync('tar', ['-tzf', result.archive], { encoding: 'utf8' });
    assert.ok(entries.includes('workspace/public/openapi.json'));
    assert.ok(entries.includes('workspace/server/store.mjs'));
    assert.ok(entries.includes('workspace/server/providers/drive9.mjs'));
    assert.ok(!entries.includes('server/api.test.mjs'));
    assert.ok(entries.includes('workspace/node_modules/mysql2/package.json'));
    assert.ok(!entries.includes('workspace/node_modules/pg/package.json'));
    const unpacked = resolve(root, 'unpacked');
    await mkdir(unpacked);
    execFileSync('tar', ['-xzf', result.archive, '-C', unpacked]);
    const runtimeRequire = createRequire(resolve(unpacked, 'workspace/server/index.mjs'));
    assert.equal(typeof runtimeRequire('mysql2').createConnection, 'function');
    const { createApp } = await import(
      pathToFileURL(resolve(unpacked, 'workspace/server/index.mjs')).href
    );
    const app = await createApp({ filesProvider: 'local' });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const health = await fetch(`http://127.0.0.1:${app.address().port}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).mode, 'demo');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
    assert.ok(!entries.includes('.data') && !entries.includes('.env'));
    assert.equal(result.info.sourceSha, 'a'.repeat(40));
    assert.equal(result.info.deployed, false);
    assert.equal(
      result.digest,
      createHash('sha256')
        .update(await readFile(result.archive))
        .digest('hex'),
    );
    assert.ok((await readFile(resolve(root, 'output/SHA256SUMS'), 'utf8')).includes(result.digest));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
