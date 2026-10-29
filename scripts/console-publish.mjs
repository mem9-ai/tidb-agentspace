import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sourceRepository = 'mem9-ai/tidb.ai';
export const websiteRepository = 'mem9-ai/drive9-fe';
export const publicationBranch = 'automation/studio-console';

const shaPattern = /^[a-f0-9]{40}$/;
export function consoleInput(path) {
  return /^(src\/|console\/|tools\/api-contract\/|index\.html$|package(?:-lock)?\.json$|\.node-version$|\.npmrc$|\.env(?:\.|$)|tsconfig[^/]*\.json$|vite\.config\.[^/]+$|scripts\/console-publish(?:\.test)?\.mjs$|\.github\/workflows\/console-publish\.yml$)/.test(
    path,
  );
}

export function consoleFingerprint(tree) {
  assert.equal(tree.truncated, false, 'Cannot compare a truncated source tree.');
  assert.ok(Array.isArray(tree.tree), 'Missing source tree.');
  const inputs = tree.tree.filter((entry) => entry.type !== 'tree' && consoleInput(entry.path));
  assert.ok(
    inputs.some((entry) => entry.path === 'package-lock.json'),
    'Missing lockfile.',
  );
  assert.ok(
    inputs.some((entry) => entry.path === 'index.html'),
    'Missing Console entry.',
  );
  for (const entry of inputs) {
    assert.equal(entry.type, 'blob', 'Console inputs must be regular files.');
    assert.equal(entry.mode, '100644', 'Console inputs must be regular non-executable files.');
    assert.match(entry.sha, shaPattern, 'Invalid source object.');
    assert.ok(
      !/^\.env(?!\.example$)/.test(entry.path),
      'Do not publish builds containing tracked environment files.',
    );
  }
  return JSON.stringify(inputs.map(({ path, mode, sha }) => [path, mode, sha]).sort());
}

export function validateCandidate(pr, commit, main, expectedTree, expectedHead) {
  assert.match(expectedTree, shaPattern);
  assert.match(expectedHead, shaPattern);
  assert.equal(pr.state, 'open', 'Publication PR is not open.');
  assert.equal(pr.draft, false, 'Publication PR is a draft.');
  assert.equal(pr.base.repo.full_name, websiteRepository);
  assert.equal(pr.head.repo.full_name, websiteRepository);
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.head.ref, publicationBranch);
  assert.equal(pr.head.sha, expectedHead, 'Publication branch changed after validation.');
  assert.equal(commit.sha, expectedHead);
  assert.equal(
    commit.commit.tree.sha,
    expectedTree,
    'Publication tree differs from the tested tree.',
  );
  assert.equal(pr.base.sha, main.sha, 'Website base changed; rerun against current main.');
  assert.equal(commit.parents.length, 1, 'Unexpected publication history.');
  assert.equal(
    commit.parents[0].sha,
    main.sha,
    'Website base changed; rerun against current main.',
  );
}

export async function checkPublicFiles(directory, hashes) {
  for (const path of Object.keys(hashes)) {
    if (path.endsWith('.woff2')) continue;
    const content = await readFile(resolve(directory, path), 'utf8');
    assert.ok(
      !/(?:-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|sourceMappingURL\s*=)/.test(
        content,
      ),
      'Public artifact contains a credential marker or source map reference.',
    );
  }
}

function api(endpoint) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

async function output(key, value) {
  assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function run(command, args) {
  if (command === 'current') {
    const [source] = args;
    assert.match(source || '', shaPattern, 'Use a full source commit.');
    const baseline = api(`repos/${sourceRepository}/git/trees/${source}?recursive=1`);
    const latest = api(`repos/${sourceRepository}/git/trees/main?recursive=1`);
    const current = consoleFingerprint(baseline) === consoleFingerprint(latest);
    await output('current', current);
    console.log(
      current ? 'Console inputs are current.' : 'Newer Console inputs exist; skipping this build.',
    );
  } else if (command === 'prepare') {
    const [website, artifact, source] = args;
    assert.match(source || '', shaPattern, 'Use a full source commit.');
    const root = resolve(website);
    const importer = resolve(root, 'scripts/studio-artifact.mjs');
    const { verifyStudioArtifact, studioHashes } = await import(pathToFileURL(importer).href);
    const destination = resolve(root, 'vendor/studio');
    const manifest = resolve(root, 'vendor/studio-build.json');
    await verifyStudioArtifact(destination, manifest);
    const previous = await studioHashes(destination);
    await checkPublicFiles(resolve(artifact), await studioHashes(artifact));
    execFileSync(process.execPath, [importer, resolve(artifact), source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await verifyStudioArtifact(destination, manifest);
    const changed = JSON.stringify(previous) !== JSON.stringify(await studioHashes(destination));
    await output('changed', changed);
    if (changed) {
      execFileSync('git', ['add', '--', 'vendor/studio', 'vendor/studio-build.json'], {
        cwd: root,
      });
      const tree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
      await output('tree', tree);
    }
    console.log(
      changed
        ? 'Public Console artifact validated.'
        : 'Console bytes are unchanged; no publication needed.',
    );
  } else if (command === 'verify') {
    const [number, tree, head] = args;
    assert.match(number || '', /^[1-9][0-9]*$/, 'Invalid PR number.');
    assert.match(head || '', shaPattern, 'Invalid PR head.');
    validateCandidate(
      api(`repos/${websiteRepository}/pulls/${number}`),
      api(`repos/${websiteRepository}/commits/${head}`),
      api(`repos/${websiteRepository}/commits/main`),
      tree,
      head,
    );
    console.log('Publication PR matches the tested tree and current website base.');
  } else {
    throw new Error('Usage: console-publish.mjs current|prepare|verify <arguments>');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await run(process.argv[2], process.argv.slice(3));
  } catch (error) {
    // Child-process errors may contain remote output. Never echo credentials or source content.
    console.error(
      error instanceof assert.AssertionError
        ? error.message.split('\n')[0]
        : 'Console publication failed; inspect the failed stage and rerun on main.',
    );
    process.exitCode = 1;
  }
}
