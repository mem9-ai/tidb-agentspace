import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { files, fullCommand, partition } from './ci-full-integration.mjs';

test('the trusted full-suite groups contain every existing integration file exactly once', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(packageJson.scripts['backend:test:integration'], fullCommand);
  for (const event of ['pull_request', 'push']) {
    const groups = partition(fullCommand, event);
    assert.deepEqual(groups.product, ['server/rust-product.test.mjs']);
    const all = [...groups.product, ...groups.other];
    assert.equal(new Set(all).size, files.length);
    assert.deepEqual([...all].sort(), [...files].sort());
  }
});

test('changed, missing, duplicate, renamed or unknown inputs use the full fallback', () => {
  for (const command of [
    undefined,
    '',
    `${fullCommand} server/new.test.mjs`,
    fullCommand.replace('server/contract.test.mjs ', ''),
    fullCommand.replace('server/contract.test.mjs', 'server/renamed.test.mjs'),
    `${fullCommand} server/contract.test.mjs`,
  ])
    assert.equal(partition(command, 'pull_request'), null);
  for (const event of ['merge_group', 'workflow_dispatch', 'unknown', ''])
    assert.equal(partition(fullCommand, event), null);
});

test('both isolated groups execute the full command once and reject changed membership', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'full-integration-partition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = fileURLToPath(new URL('./ci-full-integration.mjs', import.meta.url));
  const output = join(root, 'classification');
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: output };
  delete env.NODE_TEST_CONTEXT;
  const writePackage = (command) =>
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'backend:test:integration': command } }),
    );
  writePackage(fullCommand);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(
      join(root, file),
      `import test from 'node:test'; import {appendFileSync} from 'node:fs';\n` +
        `test('runs with isolated integration flags', () => { if (process.env.WORKSPACE_META_TEST !== '1' || process.env.WORKSPACE_BACKEND_TEST !== '1') throw Error('missing flags'); appendFileSync('executed', ${JSON.stringify(file)} + '\\n'); });\n`,
    );
  }
  writeFileSync(output, '');
  execFileSync(process.execPath, [runner, 'classify'], { cwd: root, env });
  assert.equal(readFileSync(output, 'utf8'), 'full_partition=true\n');
  for (const group of ['product', 'other'])
    execFileSync(process.execPath, [runner, group], { cwd: root, env });
  const executed = readFileSync(join(root, 'executed'), 'utf8').trim().split('\n');
  assert.equal(new Set(executed).size, files.length);
  assert.deepEqual([...executed].sort(), [...files].sort());
  const missing = join(root, files[0]);
  const original = readFileSync(missing);
  unlinkSync(missing);
  writeFileSync(output, '');
  execFileSync(process.execPath, [runner, 'classify'], { cwd: root, env });
  assert.equal(readFileSync(output, 'utf8'), 'full_partition=false\n');
  writeFileSync(missing, original);
  writePackage(fullCommand.replace('server/contract.test.mjs ', ''));
  writeFileSync(output, '');
  execFileSync(process.execPath, [runner, 'classify'], { cwd: root, env });
  assert.equal(readFileSync(output, 'utf8'), 'full_partition=false\n');
  assert.notEqual(spawnSync(process.execPath, [runner, 'product'], { cwd: root, env }).status, 0);
});

test('a candidate cannot replace its trusted base partition policy', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-full-partition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(
    join(root, 'scripts/ci-full-integration.mjs'),
    readFileSync(new URL('./ci-full-integration.mjs', import.meta.url)),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'backend:test:integration': fullCommand } }),
  );
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '// fixture\n');
  }
  git('add', '.');
  git('commit', '-qm', 'trusted base');
  git('switch', '-qc', 'candidate');
  writeFileSync(
    join(root, 'scripts/ci-full-integration.mjs'),
    'throw Error("candidate policy");\n',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: { 'backend:test:integration': fullCommand + ' server/new.test.mjs' },
    }),
  );
  git('commit', '-qam', 'candidate');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge candidate', 'candidate');
  const trusted = join(root, 'trusted.mjs');
  writeFileSync(trusted, git('show', 'HEAD^1:scripts/ci-full-integration.mjs'));
  const output = join(root, 'classification');
  writeFileSync(output, '');
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: output };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, [trusted, 'classify'], {
    cwd: root,
    env,
  });
  assert.equal(readFileSync(output, 'utf8'), 'full_partition=false\n');
});
