import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareDuckdb } from './prepare-duckdb.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'duckdb-static-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts'));
  await mkdir(resolve(root, 'input'));
  const files = {};
  for (const name of [
    'libduckdb_static.a',
    'libcore_functions_extension.a',
    'libjson_extension.a',
    'libparquet_extension.a',
    'libduckdb_loadable_extensions.a',
    'duckdb.h',
  ]) {
    const bytes = Buffer.from('verified fixture: ' + name);
    files[name] = digest(bytes);
    await writeFile(resolve(root, 'input', name), bytes);
  }
  const archive = resolve(root, 'input.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', resolve(root, 'input'), ...Object.keys(files)]);
  const bytes = await readFile(archive);
  const pins = {
    version: '2.0.0',
    artifacts: {
      'aarch64-apple-darwin': {
        platform: 'darwin',
        arch: 'arm64',
        asset: 'duckdb-static-libs-osx-arm64.tar.gz',
        sha256: digest(bytes),
        size: bytes.length,
        files,
      },
    },
  };
  await writeFile(resolve(root, 'scripts/duckdb-runtime.json'), JSON.stringify(pins));
  return { root, bytes, options: { root, platform: 'darwin', arch: 'arm64' } };
}

test('pinned static setup verifies, atomically caches and reuses exact libraries without another download', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(
      url,
      'https://github.com/duckdb/duckdb/releases/download/v2.0.0/duckdb-static-libs-osx-arm64.tar.gz',
    );
    return new Response(f.bytes);
  };
  const installed = await prepareDuckdb({ ...f.options, fetchImpl });
  assert.equal(installed.cached, false);
  assert.equal((await prepareDuckdb({ ...f.options, fetchImpl })).cached, true);
  assert.equal(calls, 1);
  await writeFile(resolve(installed.directory, 'libduckdb_static.a'), 'changed after verification');
  await assert.rejects(prepareDuckdb({ ...f.options, fetchImpl }), /cache is corrupt/);
  assert.equal(calls, 1);
});

test('static setup rejects corrupt archives without publishing a partial cache', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareDuckdb({
      ...f.options,
      fetchImpl: async () => new Response(Buffer.alloc(f.bytes.length)),
    }),
    /archive checksum mismatch/,
  );
  assert.deepEqual(await readdir(resolve(f.root, '.data/duckdb-native')), []);
});

test('static setup checks individual extracted libraries as well as the archive digest', async (t) => {
  const f = await fixture(t);
  const path = resolve(f.root, 'scripts/duckdb-runtime.json');
  const pins = JSON.parse(await readFile(path));
  pins.artifacts['aarch64-apple-darwin'].files['libjson_extension.a'] = '0'.repeat(64);
  await writeFile(path, JSON.stringify(pins));
  await assert.rejects(
    prepareDuckdb({ ...f.options, fetchImpl: async () => new Response(f.bytes) }),
    /extracted library checksum/,
  );
  assert.deepEqual(await readdir(resolve(f.root, '.data/duckdb-native')), []);
});

test('static setup rejects unknown targets before downloading and handles concurrent identical initialization', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(f.bytes);
  };
  await assert.rejects(prepareDuckdb({ ...f.options, arch: 'unknown', fetchImpl }), /No verified/);
  assert.equal(calls, 0);
  const results = await Promise.all([
    prepareDuckdb({ ...f.options, fetchImpl }),
    prepareDuckdb({ ...f.options, fetchImpl }),
  ]);
  assert.equal(results[0].directory, results[1].directory);
  assert.equal((await prepareDuckdb({ ...f.options, fetchImpl })).cached, true);
});
