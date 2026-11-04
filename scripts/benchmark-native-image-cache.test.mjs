import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const benchmark = fileURLToPath(new URL('./benchmark-native-image-cache.sh', import.meta.url));

test('image source preparation leaves cached Cargo artifacts untouched', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'native-image-source-times-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of [
    'backend/contracts',
    'backend/meta-client',
    'backend/workspace',
    'backend/identity',
    'backend/providers',
    'backend/execute',
    'meta-service/src',
    'meta-service/target',
  ])
    mkdirSync(join(directory, name), { recursive: true });
  const source = join(directory, 'meta-service/src/lib.rs');
  const artifact = join(directory, 'meta-service/target/dependency.rlib');
  for (const file of [source, artifact]) {
    writeFileSync(file, 'fixture');
    utimesSync(file, new Date(1000000000000), new Date(1000000000000));
  }
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const command = /RUN (find backend\/contracts[\s\S]*?)\s*\\\n\s*&& cargo build/.exec(
    dockerfile,
  )?.[1];
  assert.ok(command, 'lower-level source preparation must be present');
  const result = spawnSync('sh', ['-c', command.replaceAll('\\\n', ' ')], { cwd: directory });
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.ok(statSync(source).mtimeMs > 1000000000000);
  assert.equal(statSync(artifact).mtimeMs, 1000000000000);
});

test('image cache probe rejects missing cache or stale output and restores its fixture', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'native-image-cache-probe-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'specs/gh-150/fixtures/us-sales.csv');
  const bin = join(directory, 'bin');
  mkdirSync(join(directory, 'specs/gh-150/fixtures'), { recursive: true });
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -eu
case "$1" in
  buildx)
    echo '#6 [builder 8/20] RUN find backend/contracts backend/meta-client'
    if [[ "\${PROBE_MODE}" != 'uncached' ]]; then echo '#6 CACHED'; fi
    ;;
  create) echo 'container-id' ;;
  cp)
    if [[ "\${PROBE_MODE}" == 'stale' ]]; then printf 'old binary' > "$3"; else cp specs/gh-150/fixtures/us-sales.csv "$3"; fi
    ;;
  run) echo '{"duckdb":"verified"}' ;;
  rm) ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  for (const [mode, expected] of [
    ['ok', 0],
    ['uncached', 1],
    ['stale', 1],
  ]) {
    writeFileSync(fixture, 'original\n');
    const result = spawnSync('bash', [benchmark], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PROBE_MODE: mode,
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    assert.equal(result.status, expected, `${mode}: ${result.stdout} ${result.stderr}`);
    assert.equal(readFileSync(fixture, 'utf8'), 'original\n');
  }
});
