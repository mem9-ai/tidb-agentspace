import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isUiOnlyPullRequest } from './ci-ui-scope.mjs';

test('only a proven UI-only PR merge candidate uses the fast path', () => {
  const ui = ['src/features/auth/SignInChoices.tsx', 'e2e/workspace.spec.mjs'];
  assert.equal(isUiOnlyPullRequest('pull_request', 2, ui), true);
  for (const event of ['push', 'merge_group', 'workflow_dispatch'])
    assert.equal(isUiOnlyPullRequest(event, 2, ui), false);
  for (const parents of [0, 1, 3])
    assert.equal(isUiOnlyPullRequest('pull_request', parents, ui), false);
  for (const file of [
    'backend/api/src/lib.rs',
    'src/api/client.ts',
    'src/features/auth/helper.ts',
    'package-lock.json',
    'public/openapi.json',
    '.github/workflows/ci.yml',
    'scripts/ci-ui-scope.mjs',
    'e2e/workspace-fixture.mjs',
    'docs/decisions/0027-single-ci-evidence.md',
  ])
    assert.equal(isUiOnlyPullRequest('pull_request', 2, [...ui, file]), false, file);
  assert.equal(isUiOnlyPullRequest('pull_request', 2, []), false);
  assert.equal(isUiOnlyPullRequest('pull_request', 2, ['e2e/workspace.spec.mjs']), false);
  assert.equal(isUiOnlyPullRequest('pull_request', 2, ['src/App.tsx', 'src/styles.css']), true);
});

test('missing or untrusted Git candidate fails closed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ui-ci-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const script = fileURLToPath(new URL('./ci-ui-scope.mjs', import.meta.url));
  mkdirSync(join(directory, 'empty'));
  writeFileSync(output, '');
  execFileSync(process.execPath, [script], {
    cwd: join(directory, 'empty'),
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'pull_request' },
    stdio: 'pipe',
  });
  assert.equal(readFileSync(output, 'utf8'), 'ui_only=false\n');
});

test('a real merge candidate detects UI changes and both sides of renames', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ui-ci-merge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  const script = fileURLToPath(new URL('./ci-ui-scope.mjs', import.meta.url));
  const output = join(directory, 'output');
  const classify = () => {
    writeFileSync(output, '');
    execFileSync(process.execPath, [script], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'pull_request' },
      stdio: 'pipe',
    });
    return readFileSync(output, 'utf8').trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'backend'));
  writeFileSync(join(directory, 'src', 'App.tsx'), 'before\n');
  writeFileSync(join(directory, 'backend', 'private.rs'), 'native\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'ui');
  writeFileSync(join(directory, 'src', 'App.tsx'), 'after\n');
  git('add', 'src/App.tsx');
  git('commit', '-qm', 'ui');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge ui', 'ui');
  assert.equal(classify(), 'ui_only=true');
  git('switch', '-qc', 'rename');
  git('mv', 'backend/private.rs', 'src/Private.tsx');
  git('commit', '-qm', 'move native');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge rename', 'rename');
  assert.equal(classify(), 'ui_only=false');
});
