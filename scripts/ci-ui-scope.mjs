import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiFile = /^src\/(?!api\/).+\.(?:tsx|css)$/;
const companionFile =
  /^(?:e2e\/[^/]+\.spec\.mjs|docs\/standards\/(?:product-experience|browser-verification)\.md)$/;

export function isUiOnlyPullRequest(event, parents, files) {
  return (
    event === 'pull_request' &&
    parents === 2 &&
    files.length > 0 &&
    files.some((file) => uiFile.test(file)) &&
    files.every((file) => uiFile.test(file) || companionFile.test(file))
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let uiOnly = false;
  try {
    const parents =
      execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/).length - 1;
    const files = execFileSync(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      {
        encoding: 'utf8',
      },
    )
      .split('\0')
      .filter(Boolean);
    uiOnly = isUiOnlyPullRequest(process.env.GITHUB_EVENT_NAME, parents, files);
  } catch {
    console.log('Unable to classify the merge candidate; run the full native job.');
  }
  await appendFile(process.env.GITHUB_OUTPUT, `ui_only=${uiOnly}\n`);
  console.log(uiOnly ? 'UI-only PR: native checks run on main.' : 'Full native checks required.');
}
