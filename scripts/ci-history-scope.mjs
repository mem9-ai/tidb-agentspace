import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These modules contain only the regional history implementation. Anything else,
// including test harness, API contracts and workflow changes, runs the full suite.
const historySource =
  /^(?:backend\/api\/src\/history_(?:audit|maintenance|query|queue|request)\.rs|backend\/workspace\/src\/repository\/observability(?:\.rs|\/[a-z_]+\.rs))$/;
const historyTest = /^backend\/workspace\/src\/observability_tests\.rs$/;

export function isHistoryOnlyPullRequest(event, parents, changes) {
  return (
    event === 'pull_request' &&
    parents === 2 &&
    changes.length > 0 &&
    changes.some(({ status, path }) => status === 'M' && historySource.test(path)) &&
    changes.every(
      ({ status, path }) => status === 'M' && (historySource.test(path) || historyTest.test(path)),
    )
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let scoped = false;
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
    parts.pop();
    if (parts.length % 2) throw new Error('Invalid diff');
    const changes = [];
    for (let i = 0; i < parts.length; i += 2)
      changes.push({ status: parts[i], path: parts[i + 1] });
    scoped = isHistoryOnlyPullRequest(event, parents, changes);
  } catch {
    console.log('Unable to classify history changes; run the full integration suite.');
  }
  await appendFile(process.env.GITHUB_OUTPUT, `history_only=${scoped}\n`);
  console.log({ historyOnly: scoped });
}
