import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import {
  consoleFingerprint,
  consoleInput,
  validateCandidate,
  validateTargetGate,
  waitForWebsiteCheck,
  websiteRepository,
  publicationBranch,
} from './console-publish.mjs';

const old = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);
function source(extra = []) {
  return {
    truncated: false,
    tree: ['index.html', 'package-lock.json', 'src/App.tsx']
      .map((path) => ({ path, sha: old, mode: '100644', type: 'blob' }))
      .concat(extra),
  };
}
function candidate() {
  return {
    pr: {
      state: 'open',
      draft: false,
      base: { ref: 'main', sha: old, repo: { full_name: websiteRepository } },
      head: { ref: publicationBranch, sha: head, repo: { full_name: websiteRepository } },
    },
    commit: { sha: head, commit: { tree: { sha: tree } }, parents: [{ sha: old }] },
    main: { sha: old },
  };
}
function verify({ pr, commit, main }) {
  validateCandidate(pr, commit, main, tree, head);
}

test('later backend-only changes do not invalidate a Console build; frontend changes and removals do', () => {
  const original = source();
  const laterBackend = source([
    { path: 'backend/api/src/sso.rs', sha: head, mode: '100644', type: 'blob' },
  ]);
  assert.equal(consoleFingerprint(original), consoleFingerprint(laterBackend));
  laterBackend.tree.find((entry) => entry.path === 'src/App.tsx').sha = head;
  assert.notEqual(consoleFingerprint(original), consoleFingerprint(laterBackend));
  const removed = source();
  removed.tree.pop();
  assert.notEqual(consoleFingerprint(original), consoleFingerprint(removed));
  assert.equal(
    consoleFingerprint(original),
    consoleFingerprint({ ...original, tree: [...original.tree].reverse() }),
  );
});

test('incomplete source trees, tracked environments, symlinks and submodules fail closed', () => {
  assert.throws(() => consoleFingerprint({ ...source(), truncated: true }), /truncated/);
  assert.throws(() => consoleFingerprint({ truncated: false, tree: [] }), /lockfile/);
  for (const [path, type, mode] of [
    ['.env.production', 'blob', '100644'],
    ['src/secret', 'blob', '120000'],
    ['console/dependency', 'commit', '160000'],
  ]) {
    assert.throws(() => consoleFingerprint(source([{ path, type, mode, sha: old }])));
  }
  assert.doesNotThrow(() =>
    consoleFingerprint(source([{ path: '.env.example', type: 'blob', mode: '100644', sha: old }])),
  );
});

test('workflow triggers all current Console inputs, including config and workspace dependencies, but excludes backend-only edits', async () => {
  const workflow = parse(
    await readFile(new URL('../.github/workflows/console-publish.yml', import.meta.url), 'utf8'),
  );
  for (const path of [
    'src/App.tsx',
    'src/api/schema.d.ts',
    'console/public/config.json',
    'tools/api-contract/package.json',
    'package-lock.json',
    'vite.config.js',
    'tsconfig.json',
    'index.html',
    '.node-version',
    '.npmrc',
    '.env.production',
    'scripts/console-publish.mjs',
    '.github/workflows/console-publish.yml',
  ]) {
    assert.equal(consoleInput(path), true, path);
    assert.ok(
      workflow.on.push.paths.some((pattern) => matchesGlob(path, pattern)),
      path,
    );
  }
  for (const path of ['backend/api/src/sso.rs', 'docs/architecture.md', 'deploy/dev.yaml']) {
    assert.equal(consoleInput(path), false, path);
    assert.equal(
      workflow.on.push.paths.some((pattern) => matchesGlob(path, pattern)),
      false,
      path,
    );
  }
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.jobs.build.if, /refs\/heads\/main/);
  assert.ok(!JSON.stringify(workflow.jobs.build).includes('secrets.'));
  assert.equal(workflow.jobs.build.steps[0].with.ref, 'main');
  assert.equal(workflow.jobs.publish.steps[0].with.ref, '${{ needs.build.outputs.sha }}');
});

test('merge accepts only the exact tested tree on the current website base', () => {
  assert.doesNotThrow(() => verify(candidate()));
  for (const change of [
    (value) => {
      value.pr.state = 'closed';
    },
    (value) => {
      value.pr.draft = true;
    },
    (value) => {
      value.pr.head.sha = old;
    },
    (value) => {
      value.commit.commit.tree.sha = old;
    },
    (value) => {
      value.pr.head.repo.full_name = 'someone/fork';
    },
    (value) => {
      value.pr.head.ref = 'unrelated';
    },
    (value) => {
      value.main.sha = head;
    },
    (value) => {
      value.commit.parents[0].sha = head;
    },
    (value) => {
      value.commit.parents.push({ sha: head });
    },
  ]) {
    const value = candidate();
    change(value);
    assert.throws(() => verify(value));
  }
});

test('publication requires an independent Actions check enforced for everyone', () => {
  const branch = {
    protected: true,
    protection: {
      required_status_checks: {
        enforcement_level: 'everyone',
        checks: [{ context: 'Studio artifact', app_id: 15368 }],
      },
    },
  };
  assert.doesNotThrow(() => validateTargetGate(branch));
  for (const change of [
    (value) => {
      value.protected = false;
    },
    (value) => {
      value.protection.required_status_checks.enforcement_level = 'non_admins';
    },
    (value) => {
      value.protection.required_status_checks.checks = [];
    },
    (value) => {
      value.protection.required_status_checks.checks[0].app_id = 123;
    },
    (value) => {
      value.protection.required_status_checks.checks[0].context = 'Other check';
    },
  ]) {
    const value = structuredClone(branch);
    change(value);
    assert.throws(() => validateTargetGate(value));
  }
});

test('current command skips stale input and never echoes remote failure output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'console-publish-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'bin');
  await mkdir(binary);
  const current = source();
  current.tree[2].sha = head;
  const fake = join(binary, 'gh');
  await writeFile(
    fake,
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv[3].includes('/main?') ? ${JSON.stringify(current)} : ${JSON.stringify(source())}));\n`,
    { mode: 0o700 },
  );
  const output = join(directory, 'output');
  const script = new URL('./console-publish.mjs', import.meta.url);
  const options = {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binary}:${process.env.PATH}`, GITHUB_OUTPUT: output },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  execFileSync(process.execPath, [script.pathname, 'current', old], options);
  assert.equal(await readFile(output, 'utf8'), 'current=false\n');
  await writeFile(
    fake,
    `#!${process.execPath}\nconsole.error('PRIVATE_REMOTE_OUTPUT');process.exit(1);\n`,
    { mode: 0o700 },
  );
  assert.throws(
    () => execFileSync(process.execPath, [script.pathname, 'current', old], options),
    (error) => {
      assert.equal(error.status, 1);
      assert.ok(!`${error.stdout}${error.stderr}`.includes('PRIVATE_REMOTE_OUTPUT'));
      return true;
    },
  );
});

test('waits for registration and pending checks, accepts only Actions success', async () => {
  const run = (id, status, conclusion, app = 15368) => ({
    id,
    name: 'Studio artifact',
    app: { id: app },
    status,
    conclusion,
  });
  const states = [
    [],
    [run(1, 'queued', null)],
    [run(1, 'completed', 'success', 123)],
    [run(2, 'completed', 'success')],
  ];
  let pauses = 0;
  await waitForWebsiteCheck(
    async () => ({ check_runs: states.shift() }),
    async () => {
      pauses++;
    },
    4,
  );
  assert.equal(pauses, 3);
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
    await assert.rejects(
      waitForWebsiteCheck(
        async () => ({ check_runs: [run(2, 'completed', conclusion)] }),
        async () => {},
        1,
      ),
      /failed/,
    );
  }
  await assert.rejects(
    waitForWebsiteCheck(
      async () => ({ check_runs: [run(1, 'completed', 'success'), run(2, 'queued', null)] }),
      async () => {},
      2,
    ),
    /Timed out/,
  );
});
