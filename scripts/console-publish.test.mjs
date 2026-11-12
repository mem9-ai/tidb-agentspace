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
    'scripts/console-publish-sparse.test.mjs',
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
  assert.equal(workflow.jobs.build.permissions.actions, 'read');
  const setup = workflow.jobs.build.steps.find((step) =>
    step.uses?.startsWith('actions/setup-node@'),
  );
  assert.equal(setup.with.cache, 'npm');
  assert.ok(!JSON.stringify(workflow).includes('npm run check'));
  const gate = workflow.jobs.build.steps.find((step) =>
    step.run?.startsWith('node scripts/require-ci.mjs '),
  );
  assert.equal(gate.env.SOURCE_SHA, '${{ steps.commit.outputs.sha }}');
  assert.equal(gate.run, 'node scripts/require-ci.mjs console "$SOURCE_SHA"');
  assert.ok(
    workflow.jobs.build.steps.indexOf(gate) <
      workflow.jobs.build.steps.findIndex((step) => step.run === 'npm ci'),
  );
  const steps = workflow.jobs.publish.steps;
  const checkout = steps.find((step) => step.with?.repository === websiteRepository);
  assert.equal(checkout.with['sparse-checkout-cone-mode'], false);
  assert.equal(checkout.with['sparse-checkout'], '/*\n!/site/releases/\n');
  assert.equal(checkout.with.filter, undefined);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'] ?? 1, 1);
  const guards = steps.filter(
    (step) => step.run === 'node scripts/console-publish.mjs checkout website',
  );
  const tests = steps.findIndex(
    (step) => step.run === 'node --test scripts/*.test.mjs tests/*.test.mjs',
  );
  const mint = steps.findIndex((step) => step.id === 'app');
  assert.equal(guards.length, 2);
  assert.ok(steps.indexOf(checkout) < steps.indexOf(guards[0]));
  assert.ok(steps.indexOf(guards[0]) < tests && tests < mint);
  assert.ok(steps.findIndex((step) => step.id === 'pr') < steps.indexOf(guards[1]));
  assert.ok(steps.indexOf(guards[1]) < steps.findIndex((step) => step.id === 'latest'));
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

test('prepare publishes a signature change even when the Console payload is unchanged', async (t) => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { cp, mkdtemp, readFile, rm, writeFile, mkdir } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'console-sign-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const website = join(directory, 'website');
  const artifact = join(directory, 'artifact');
  const output = join(directory, 'output');
  const script = new URL('./console-publish.mjs', import.meta.url);

  // The website owns the artifact format and the signer, so the fixture copies the
  // real implementations from a drive9-fe checkout instead of re-deriving them.
  const websiteSource = process.env.STUDIO_WEBSITE_CHECKOUT;
  if (!websiteSource) {
    t.skip(
      'set STUDIO_WEBSITE_CHECKOUT to a drive9-fe checkout to run the prepare-path regression',
    );
    return;
  }
  await mkdir(join(website, 'scripts'), { recursive: true });
  await mkdir(join(artifact, 'assets'), { recursive: true });
  for (const name of ['studio-artifact.mjs', 'studio-signature.mjs', 'sign-studio-manifest.mjs']) {
    await cp(join(websiteSource, 'scripts', name), join(website, 'scripts', name));
  }
  await writeFile(
    join(artifact, 'index.html'),
    '<!doctype html><script src="/studio/assets/app.js"></script>',
  );
  await writeFile(join(artifact, 'config.json'), '{"apiOrigin":"","apiPathPrefix":"/studio"}\n');
  await writeFile(join(artifact, 'assets/app.js'), 'export const version = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: website });
  execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'add', '-A'], {
    cwd: website,
  });
  execFileSync(
    'git',
    ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'baseline'],
    { cwd: website },
  );
  // Seed the already-published state the workflow checks out.
  execFileSync(process.execPath, [join(website, 'scripts/studio-artifact.mjs'), artifact, old], {
    cwd: website,
  });
  execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'add', '-A'], {
    cwd: website,
  });
  execFileSync(
    'git',
    ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'published'],
    { cwd: website },
  );
  await writeFile(output, '');

  const key = () =>
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyA = key();
  const keyB = key();
  const signaturePath = join(website, 'vendor/studio-build.json.sig');
  const prepare = async (signingKey) => {
    execFileSync(process.execPath, [script.pathname, 'prepare', website, artifact, old], {
      env: { ...process.env, GITHUB_OUTPUT: output, STUDIO_ARTIFACT_SIGNING_KEY: signingKey },
      encoding: 'utf8',
    });
    return readFile(output, 'utf8');
  };
  const lastValue = (text, name) =>
    text
      .split('\n')
      .filter((line) => line.startsWith(`${name}=`))
      .map((line) => line.split('=')[1])
      .pop();

  // Unchanged payload, no key: a genuine no-op.
  assert.equal(lastValue(await prepare(''), 'changed'), 'false');
  await assert.rejects(readFile(signaturePath, 'utf8'), { code: 'ENOENT' });

  // First activation: the payload is identical, but the signature is new.
  const first = await prepare(keyA);
  assert.equal(lastValue(first, 'changed'), 'true');
  assert.match(lastValue(first, 'tree'), /^[a-f0-9]{40}$/);
  const firstSignature = await readFile(signaturePath, 'utf8');
  assert.ok(firstSignature.trim().length > 0);

  // Key rotation: same payload, different key, so the signature changes again.
  const rotated = await prepare(keyB);
  assert.equal(lastValue(rotated, 'changed'), 'true');
  const rotatedSignature = await readFile(signaturePath, 'utf8');
  assert.notEqual(rotatedSignature.trim(), firstSignature.trim());

  // The complete intended publication is current again: a real no-op.
  assert.equal(lastValue(await prepare(keyB), 'changed'), 'false');
});
