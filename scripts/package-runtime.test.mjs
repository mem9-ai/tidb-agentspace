import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { packageRustApi } from './package-rust-api.mjs';
const root = resolve('.');
test('native packaging rejects malformed and unreviewed source identities', async () => {
  for (const sourceSha of ['', 'not-a-revision', '0'.repeat(40), 'f'.repeat(40)])
    await assert.rejects(
      packageRustApi({ root, sourceSha, binary: 'unused', destination: 'unused' }),
    );
});
test(
  'packaged Rust executable runs selected-file computation without a Node runtime or private state',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'workspace-native-package-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const packaged = await packageRustApi({
      root,
      sourceSha,
      binary: resolve(root, 'meta-service/target/debug/workspace-backend'),
      destination: resolve(directory, 'package'),
    });
    const files = execFileSync('tar', ['-tzf', packaged.archive], { encoding: 'utf8' });
    assert.equal(
      /(?:server\/|\.data\/|node_modules\/|token|secret|config\.json)/.test(files),
      false,
    );
    await mkdir(resolve(directory, 'unpack'));
    execFileSync('tar', ['-xzf', packaged.archive, '-C', resolve(directory, 'unpack')]);
    const binary = resolve(directory, 'unpack/api/workspace-backend');
    const info = JSON.parse(await readFile(resolve(directory, 'unpack/api/build-info.json')));
    assert.equal(info.sourceSha, sourceSha);
    assert.equal(info.binarySha256, packaged.binarySha256);
    assert.equal(info.duckdb.version, '2.0.0');
    assert.equal(info.duckdb.linkage, 'static');
    assert.deepEqual(
      JSON.parse(execFileSync(binary, ['runtime-info'], { encoding: 'utf8' })).duckdb,
      info.duckdb,
    );
    const libraries = execFileSync(
      process.platform === 'darwin' ? 'otool' : 'ldd',
      process.platform === 'darwin' ? ['-L', binary] : [binary],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(libraries, /libduckdb[^\s]*(?:\.so|\.dylib)/);
    const source = resolve(directory, 'selected.csv');
    await writeFile(source, 'name,n\nalice,1\n');
    const value = await new Promise((done, reject) => {
      const child = spawn(binary, ['execute'], {
        env: { PATH: '/nonexistent' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (b) => (output += b));
      child.stderr.resume();
      child.once('error', reject);
      child.once('exit', (code) => {
        try {
          assert.equal(code, 0);
          done(JSON.parse(output));
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(JSON.stringify({ mode: 'preview', sourcePath: source, format: 'csv' }));
    });
    assert.equal(value.error, undefined);
    assert.ok(value.result);
  },
);
