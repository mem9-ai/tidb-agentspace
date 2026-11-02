import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isBackendOnly, isUiOnlyChange } from './ci-ui-scope.mjs';

test('only known native changes use API verification without a browser', () => {
  const native = ['backend/product/src/files.rs', 'server/rust-product.test.mjs'];
  for (const event of ['pull_request', 'push']) {
    assert.equal(isBackendOnly(event, 2, native), true);
    for (const file of [
      'src/api/client.ts',
      'src/App.tsx',
      'public/openapi.json',
      'public/owner-openapi.json',
      'server/generate-openapi.mjs',
      'backend/contracts/src/lib.rs',
      'package.json',
      'package-lock.json',
      '.github/workflows/ci.yml',
      'scripts/ci-ui-scope.mjs',
      'Dockerfile',
      'unknown',
    ])
      assert.equal(isBackendOnly(event, 2, [...native, file]), false, file);
  }
  for (const event of ['merge_group', 'workflow_dispatch', 'unknown'])
    assert.equal(isBackendOnly(event, 2, native), false);
  for (const parents of [0, 1, 3])
    assert.equal(isBackendOnly('pull_request', parents, native), false);
  assert.equal(isBackendOnly('push', 1, ['server/contract.test.mjs']), false);
  assert.equal(isBackendOnly('push', 1, []), false);
});

test('only proven UI-only PR and main changes use the fast path', () => {
  const ui = ['src/features/auth/SignInChoices.tsx', 'e2e/workspace.spec.mjs'];
  assert.equal(isUiOnlyChange('pull_request', 2, ui), true);
  assert.equal(isUiOnlyChange('push', 1, ui), true);
  assert.equal(isUiOnlyChange('push', 2, ui), true);
  assert.equal(isUiOnlyChange('push', 0, ui), false);
  for (const event of ['merge_group', 'workflow_dispatch'])
    assert.equal(isUiOnlyChange(event, 2, ui), false);
  for (const parents of [0, 1, 3]) assert.equal(isUiOnlyChange('pull_request', parents, ui), false);
  for (const file of [
    'backend/api/src/lib.rs',
    'src/api/client.ts',
    'src/api/client.test.mjs',
    'package-lock.json',
    'public/openapi.json',
    'public/owner-openapi.json',
    '.github/workflows/ci.yml',
    'scripts/ci-ui-scope.mjs',
    'e2e/workspace-fixture.mjs',
    'docs/decisions/0027-single-ci-evidence.md',
    'docs/ci-cd.md',
    'docs/console-publishing.md',
    'docs/standards/intent-driven-development.md',
    'docs/example.mjs',
  ])
    for (const event of ['pull_request', 'push'])
      assert.equal(isUiOnlyChange(event, 2, [...ui, file]), false, file);
  assert.equal(isUiOnlyChange('pull_request', 2, []), false);
  assert.equal(isUiOnlyChange('pull_request', 2, ['e2e/workspace.spec.mjs']), false);
  assert.equal(isUiOnlyChange('pull_request', 2, ['src/App.tsx', 'src/styles.css']), true);
  assert.equal(
    isUiOnlyChange('pull_request', 2, [
      'src/App.tsx',
      'README.md',
      'docs/decisions/0044-workspace-observability.md',
      'docs/standards/product-experience.md',
      'specs/gh-119/spec.md',
    ]),
    true,
  );
  assert.equal(
    isUiOnlyChange('pull_request', 2, [
      'src/App.tsx',
      'src/features/navigation/workspace-route.ts',
      'src/features/navigation/workspace-route.test.mjs',
      'docs/screenshots/streamlined-workspace/overview-desktop-light.png',
    ]),
    true,
  );
  assert.equal(
    isUiOnlyChange('pull_request', 2, ['src/App.tsx', 'docs/screenshots/helper.mjs']),
    false,
  );
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
  assert.equal(readFileSync(output, 'utf8'), 'ui_only=false\nbackend_only=false\n');
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
  assert.equal(classify(), 'ui_only=true\nbackend_only=false');
  git('switch', '-qc', 'rename');
  git('mv', 'backend/private.rs', 'src/Private.tsx');
  git('commit', '-qm', 'move native');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge rename', 'rename');
  assert.equal(classify(), 'ui_only=false\nbackend_only=false');
});

test('native PR renames and full main push ranges fail closed on Console inputs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'native-ci-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
  const script = fileURLToPath(new URL('./ci-ui-scope.mjs', import.meta.url));
  const output = join(directory, 'output');
  const classify = (event, before = '') => {
    writeFileSync(output, '');
    execFileSync(process.execPath, [script], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: event, BEFORE_SHA: before },
      stdio: 'pipe',
    });
    return readFileSync(output, 'utf8');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'backend', 'product', 'src'), { recursive: true });
  writeFileSync(join(directory, 'src/App.tsx'), 'console\n');
  writeFileSync(join(directory, 'backend/product/src/lib.rs'), 'native\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'native');
  writeFileSync(join(directory, 'backend/product/src/lib.rs'), 'native changed\n');
  git('add', '.');
  git('commit', '-qm', 'native');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'native merge', 'native');
  assert.equal(classify('pull_request'), 'ui_only=false\nbackend_only=true\n');
  assert.equal(classify('push', base), 'ui_only=false\nbackend_only=true\n');
  const nativeHead = git('rev-parse', 'HEAD');
  // A main push can contain several commits. The final commit alone is insufficient.
  writeFileSync(join(directory, 'src/App.tsx'), 'console changed\n');
  git('add', 'src/App.tsx');
  git('commit', '-qm', 'console');
  const consoleHead = git('rev-parse', 'HEAD');
  assert.equal(classify('push', nativeHead), 'ui_only=true\nbackend_only=false\n');
  for (const before of ['', 'HEAD^1', '0'.repeat(40), 'f'.repeat(40)])
    assert.equal(classify('push', before), 'ui_only=false\nbackend_only=false\n');
  writeFileSync(join(directory, 'backend/product/src/lib.rs'), 'native changed again\n');
  git('add', 'backend/product/src/lib.rs');
  git('commit', '-qm', 'native again');
  assert.equal(classify('push', consoleHead), 'ui_only=false\nbackend_only=true\n');
  assert.equal(classify('push', nativeHead), 'ui_only=false\nbackend_only=false\n');
  for (const before of ['', 'HEAD^1', '0'.repeat(40), 'f'.repeat(40)])
    assert.equal(classify('push', before), 'ui_only=false\nbackend_only=false\n');
  git('switch', '-qc', 'rename');
  git('mv', 'src/App.tsx', 'backend/product/src/renamed.rs');
  git('commit', '-qm', 'move Console');
  const unrelated = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  assert.equal(classify('push', unrelated), 'ui_only=false\nbackend_only=false\n');
  git('merge', '--no-ff', '-qm', 'rename merge', 'rename');
  assert.equal(classify('pull_request'), 'ui_only=false\nbackend_only=false\n');
});
