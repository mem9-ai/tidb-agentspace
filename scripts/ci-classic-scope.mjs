import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only existing, narrowly scoped implementation files are eligible. Test, fixture,
// policy, contract, workflow and shared-boundary edits always run the full gate.
const paths = new Map([
  ['backend/product/src/tutorials.rs', 'tutorial'],
  ['backend/workspace/src/repository/tutorials.rs', 'tutorial'],
  ['backend/product/src/database.rs', 'database'],
  ['backend/product/src/files.rs', 'files'],
]);

export function selectClassicProfile(event, parents, changes) {
  if (event !== 'pull_request' || parents !== 2 || changes.length === 0) return 'full';
  const profiles = new Set();
  for (const { status, path } of changes) {
    if (status !== 'M' || !paths.has(path)) return 'full';
    profiles.add(paths.get(path));
  }
  return profiles.size === 1 ? [...profiles][0] : 'full';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let profile = 'full';
  try {
    const event = process.env.GITHUB_EVENT_NAME;
    const parents =
      execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/).length - 1;
    if (event !== 'pull_request' || parents !== 2) throw new Error('Not a PR merge candidate');
    const parts = execFileSync(
      'git',
      ['diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).split('\0');
    if (parts.pop() !== '' || parts.length % 2) throw new Error('Invalid diff');
    const changes = [];
    for (let i = 0; i < parts.length; i += 2)
      changes.push({ status: parts[i], path: parts[i + 1] });
    profile = selectClassicProfile(event, parents, changes);
  } catch {
    console.log('Unable to classify changes; run the full integration suite.');
  }
  await appendFile(process.env.GITHUB_OUTPUT, `classic_profile=${profile}\n`);
  console.log({ classicProfile: profile });
}
