import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isDocumentationOnly } from './ci-docs-scope.mjs';

test('only reviewed documentation files on a PR merge candidate skip application checks', () => {
  const docs = [
    'README.md',
    'docs/architecture.md',
    'specs/gh-119/spec.md',
    'docs/screenshots/example.png',
  ];
  assert.equal(isDocumentationOnly('pull_request', 2, docs), true);
  for (const event of ['push', 'merge_group', 'workflow_dispatch'])
    assert.equal(isDocumentationOnly(event, 2, docs), false);
  for (const parents of [0, 1, 3])
    assert.equal(isDocumentationOnly('pull_request', parents, docs), false);
  for (const file of [
    'src/App.tsx',
    'backend/api/src/lib.rs',
    'public/openapi.json',
    'package.json',
    'docs/example.mjs',
    'docs/screenshots/script.svg',
    'scripts/ci-docs-scope.mjs',
    '.github/workflows/ci.yml',
    'AGENTS.md',
  ])
    assert.equal(isDocumentationOnly('pull_request', 2, [...docs, file]), false, file);
  assert.equal(isDocumentationOnly('pull_request', 2, []), false);
});

test('merge candidates detect both sides of renames and untrusted candidates fail closed', (t) => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'docs-ci-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  const script = fileURLToPath(new URL('./ci-docs-scope.mjs', import.meta.url));
  const output = join(directory, 'output');
  const classify = (policy = script) => {
    writeFileSync(output, '');
    execFileSync(process.execPath, [policy], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'pull_request' },
      stdio: 'pipe',
    });
    return readFileSync(output, 'utf8').trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(directory, 'docs'));
  mkdirSync(join(directory, 'backend'));
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(script, join(directory, 'scripts', 'ci-docs-scope.mjs'));
  writeFileSync(join(directory, 'docs', 'guide.md'), 'before\n');
  writeFileSync(join(directory, 'backend', 'private.rs'), 'native\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  assert.equal(classify(), 'docs_only=false');
  git('switch', '-qc', 'docs');
  writeFileSync(join(directory, 'docs', 'guide.md'), 'after\n');
  git('add', 'docs/guide.md');
  git('commit', '-qm', 'docs');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge docs', 'docs');
  assert.equal(classify(), 'docs_only=true');
  git('switch', '-qc', 'rename');
  git('mv', 'backend/private.rs', 'docs/private.md');
  git('commit', '-qm', 'move native');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge rename', 'rename');
  assert.equal(classify(), 'docs_only=false');
  git('switch', '-qc', 'policy');
  writeFileSync(join(directory, 'scripts', 'ci-docs-scope.mjs'), 'malicious candidate\n');
  git('add', 'scripts/ci-docs-scope.mjs');
  git('commit', '-qm', 'modify policy');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge policy', 'policy');
  const trusted = join(directory, 'trusted.mjs');
  writeFileSync(trusted, git('show', 'HEAD^1:scripts/ci-docs-scope.mjs'));
  assert.equal(classify(trusted), 'docs_only=false');
});
