import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { selectClassicProfile } from './ci-classic-scope.mjs';

const change = (path, status = 'M') => ({ path, status });
test('classic scope selects only reviewed existing implementation files', () => {
  for (const [profile, files] of Object.entries({
    tutorial: ['backend/product/src/tutorials.rs', 'backend/workspace/src/repository/tutorials.rs'],
    database: ['backend/product/src/database.rs'],
    files: ['backend/product/src/files.rs'],
  })) {
    for (const file of files)
      assert.equal(selectClassicProfile('pull_request', 2, [change(file)]), profile);
    assert.equal(
      selectClassicProfile(
        'pull_request',
        2,
        files.map((file) => change(file)),
      ),
      profile,
    );
  }
  const source = change('backend/product/src/tutorials.rs');
  for (const event of ['push', 'workflow_dispatch', 'merge_group', 'unknown'])
    assert.equal(selectClassicProfile(event, 2, [source]), 'full');
  for (const parents of [0, 1, 3])
    assert.equal(selectClassicProfile('pull_request', parents, [source]), 'full');
  for (const status of ['A', 'D', 'R100', 'T', ''])
    assert.equal(selectClassicProfile('pull_request', 2, [change(source.path, status)]), 'full');
  for (const path of [
    'backend/product/src/read_only.rs',
    'backend/product/src/imports.rs',
    'backend/product/src/exports.rs',
  ])
    assert.equal(selectClassicProfile('pull_request', 2, [change(path)]), 'full', path);
  for (const path of [
    'backend/product/src/files.rs',
    'backend/api/src/lib.rs',
    'backend/contracts/src/lib.rs',
    'backend/test-support/tests/product.rs',
    'backend/test-support/tests/product/tutorial.rs',
    'backend/build-tools/src/bin/workspace-verify.rs',
    'scripts/ci-classic-scope.mjs',
    '.github/workflows/ci.yml',
    'public/openapi.json',
    'src/App.tsx',
    'unknown',
  ])
    assert.equal(selectClassicProfile('pull_request', 2, [source, change(path)]), 'full', path);
  assert.equal(selectClassicProfile('pull_request', 2, []), 'full');
});

test('real merge candidates reject renames and unknown additions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'classic-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./ci-classic-scope.mjs', import.meta.url));
  const output = join(root, 'output');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const classify = () => {
    writeFileSync(output, '');
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: output },
      stdio: 'pipe',
    });
    return readFileSync(output, 'utf8');
  };
  assert.equal(classify(), 'classic_profile=full\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(root, 'backend/product/src'), { recursive: true });
  writeFileSync(join(root, 'backend/product/src/tutorials.rs'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'tutorial');
  writeFileSync(join(root, 'backend/product/src/tutorials.rs'), 'after\n');
  git('commit', '-qam', 'tutorial');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge tutorial', 'tutorial');
  assert.equal(classify(), 'classic_profile=tutorial\n');
  git('switch', '-qc', 'rename');
  git('mv', 'backend/product/src/tutorials.rs', 'backend/product/src/files.rs');
  git('commit', '-qm', 'rename');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge rename', 'rename');
  assert.equal(classify(), 'classic_profile=full\n');
});
