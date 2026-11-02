import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const documentation =
  /^(?:README\.md|(?:docs|specs)\/.+\.md|docs\/screenshots\/.+\.(?:png|jpe?g|webp))$/;

export function isDocumentationOnly(event, parents, files) {
  return (
    event === 'pull_request' &&
    parents === 2 &&
    files.length > 0 &&
    files.every((file) => documentation.test(file))
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let docsOnly = false;
  try {
    const parents =
      execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/).length - 1;
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || parents !== 2)
      throw new Error('Not a known merge candidate.');
    const files = execFileSync(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      {
        encoding: 'utf8',
      },
    )
      .split('\0')
      .filter(Boolean);
    docsOnly = isDocumentationOnly(process.env.GITHUB_EVENT_NAME, parents, files);
  } catch {
    console.log('Unable to classify documentation; run native and browser checks.');
  }
  await appendFile(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
  console.log({ docsOnly });
}
