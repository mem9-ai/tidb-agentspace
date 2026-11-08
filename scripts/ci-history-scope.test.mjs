import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isHistoryOnlyPullRequest } from './ci-history-scope.mjs';

const source = { status: 'M', path: 'backend/api/src/history_queue.rs' };
test('history integration selection is restricted to existing history modules in PRs', () => {
  assert.equal(isHistoryOnlyPullRequest('pull_request', 2, [source]), true);
  assert.equal(
    isHistoryOnlyPullRequest('pull_request', 2, [
      source,
      { status: 'M', path: 'backend/workspace/src/observability_tests.rs' },
    ]),
    true,
  );
  for (const event of ['push', 'merge_group', 'workflow_dispatch', 'unknown'])
    assert.equal(isHistoryOnlyPullRequest(event, 2, [source]), false);
  for (const parents of [0, 1, 3])
    assert.equal(isHistoryOnlyPullRequest('pull_request', parents, [source]), false);
  for (const path of [
    'backend/api/src/lib.rs',
    'backend/workspace/src/repository.rs',
    'backend/contracts/src/lib.rs',
    'backend/test-support/tests/product.rs',
    'backend/test-support/tests/meta.rs',
    'backend/build-tools/src/bin/workspace-verify.rs',
    '.github/workflows/ci.yml',
    'public/openapi.json',
    'src/App.tsx',
  ])
    assert.equal(
      isHistoryOnlyPullRequest('pull_request', 2, [source, { status: 'M', path }]),
      false,
      path,
    );
  for (const status of ['A', 'D', 'R100', 'T', ''])
    assert.equal(
      isHistoryOnlyPullRequest('pull_request', 2, [{ ...source, status }]),
      false,
      status,
    );
  assert.equal(isHistoryOnlyPullRequest('pull_request', 2, []), false);
  assert.equal(
    isHistoryOnlyPullRequest('pull_request', 2, [
      { status: 'M', path: 'backend/workspace/src/observability_tests.rs' },
    ]),
    false,
  );
});

test('real merge candidates select narrowly and unknown or renamed paths fail closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'history-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./ci-history-scope.mjs', import.meta.url));
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
  assert.equal(classify(), 'history_only=false\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(root, 'backend/api/src'), { recursive: true });
  writeFileSync(join(root, 'backend/api/src/history_queue.rs'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'history');
  writeFileSync(join(root, 'backend/api/src/history_queue.rs'), 'after\n');
  git('commit', '-qam', 'history');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge history', 'history');
  assert.equal(classify(), 'history_only=true\n');
  git('switch', '-qc', 'rename');
  git('mv', 'backend/api/src/history_queue.rs', 'backend/api/src/history_request.rs');
  git('commit', '-qm', 'rename history');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge rename', 'rename');
  assert.equal(classify(), 'history_only=false\n');
});
