import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { packageRuntime } from './package-runtime.mjs';

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
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
    await writeFile(resolve(root, '.node-version'), '24.22.1\n');
    const result = await packageRuntime({
      root,
      destination: resolve(root, 'output'),
      sourceSha: 'a'.repeat(40),
    });
    const entries = execFileSync('tar', ['-tzf', result.archive], { encoding: 'utf8' });
    assert.ok(entries.includes('workspace/public/openapi.json'));
    assert.ok(entries.includes('workspace/server/store.mjs'));
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
