import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { validateCandidate, verifyWebsiteCheckout, websiteRepository } from './console-publish.mjs';

test('blobless website checkout preserves full publication trees without fetching release binaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'console-sparse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const website = join(root, 'website');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (directory, ...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-C',
        directory,
        ...args,
      ],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
    ).trim();
  await mkdir(origin);
  git(origin, 'init', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const path of ['site/releases', 'scripts', 'tests', 'vendor/studio'])
    await mkdir(join(origin, path), { recursive: true });
  for (const path of [
    'site/index.html',
    'site/skill.md',
    'site/netlify.toml',
    'scripts/build.mjs',
    'tests/build.test.mjs',
    'vendor/studio/index.html',
    'vendor/studio/stale.js',
    'vendor/studio-build.json',
  ])
    await writeFile(join(origin, path), `fixture ${path}`);
  await writeFile(join(origin, 'site/releases/download'), randomBytes(1024 * 1024));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-m', 'fixture baseline');
  const base = git(origin, 'rev-parse', 'HEAD');
  const releaseTree = git(origin, 'rev-parse', 'HEAD:site/releases');
  git(
    root,
    'clone',
    '--no-checkout',
    '--filter=blob:none',
    '--depth=1',
    pathToFileURL(origin).href,
    website,
  );
  const workflow = parse(
    await readFile(new URL('../.github/workflows/console-publish.yml', import.meta.url), 'utf8'),
  );
  const checkout = workflow.jobs.publish.steps.find(
    (step) => step.with?.repository === websiteRepository,
  );
  const patterns = checkout.with['sparse-checkout'].trim().split('\n');
  git(website, 'sparse-checkout', 'set', '--no-cone', ...patterns);
  git(website, 'checkout', 'main');
  assert.equal((await verifyWebsiteCheckout(website)).excludedReleaseBlobs, 1);
  assert.equal(git(website, 'write-tree'), git(origin, 'rev-parse', 'HEAD^{tree}'));
  for (const path of [
    'site/index.html',
    'site/skill.md',
    'site/netlify.toml',
    'scripts/build.mjs',
    'tests/build.test.mjs',
    'vendor/studio/index.html',
    'vendor/studio-build.json',
  ])
    assert.match(await readFile(join(website, path), 'utf8'), /fixture/);

  // Stage added/changed/deleted artifacts as prepare does; the full tree keeps downloads.
  await writeFile(join(website, 'vendor/studio/index.html'), 'new Console');
  await writeFile(join(website, 'vendor/studio/current.js'), 'new asset');
  await rm(join(website, 'vendor/studio/stale.js'));
  await writeFile(join(website, 'vendor/studio-build.json'), 'new manifest');
  git(website, 'add', '--', 'vendor/studio', 'vendor/studio-build.json');
  const tree = git(website, 'write-tree');
  assert.notEqual(tree, git(origin, 'rev-parse', 'HEAD^{tree}'));
  git(website, 'checkout', '-b', 'automation/studio-console');
  git(website, 'commit', '-m', 'fixture artifact');
  const head = git(website, 'rev-parse', 'HEAD');
  validateCandidate(
    {
      state: 'open',
      draft: false,
      base: { ref: 'main', sha: base, repo: { full_name: websiteRepository } },
      head: { ref: 'automation/studio-console', sha: head, repo: { full_name: websiteRepository } },
    },
    {
      sha: head,
      commit: { tree: { sha: git(website, 'rev-parse', 'HEAD^{tree}') } },
      parents: [{ sha: base }],
    },
    { sha: base },
    tree,
    head,
  );
  assert.equal(git(website, 'rev-parse', 'HEAD:site/releases'), releaseTree);
  assert.deepEqual(git(website, 'diff', '--name-only', base, head).split('\n').sort(), [
    'vendor/studio-build.json',
    'vendor/studio/current.js',
    'vendor/studio/index.html',
    'vendor/studio/stale.js',
  ]);

  // Publication-style fetch/branch reset keeps the promisor filter and sparse index entries.
  git(website, 'push', 'origin', 'automation/studio-console');
  git(website, 'checkout', 'main');
  git(
    website,
    'fetch',
    '--no-tags',
    '--depth=10',
    'origin',
    '+refs/heads/automation/studio-console:refs/remotes/origin/automation/studio-console',
  );
  git(website, 'checkout', '-B', 'automation/studio-console', 'origin/automation/studio-console');
  git(website, 'reset', '--hard', head);
  await verifyWebsiteCheckout(website);
  assert.equal(git(website, 'write-tree'), tree);
  assert.equal(git(website, 'rev-parse', 'HEAD:site/releases'), releaseTree);

  // Losing an excluded index entry fails even when the worktree still looks sparse.
  git(website, 'update-index', '--force-remove', 'site/releases/download');
  await assert.rejects(verifyWebsiteCheckout(website), /preserve excluded releases/);
  git(website, 'reset', '--hard', head);
  await verifyWebsiteCheckout(website);
  // Hiding files is insufficient: an accidental lazy fetch must also fail the guard.
  execFileSync('git', ['-C', website, 'show', 'HEAD:site/releases/download'], {
    env,
    stdio: 'ignore',
    timeout: 15_000,
  });
  await assert.rejects(verifyWebsiteCheckout(website), /release blob was downloaded/);
});
