import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function hasSignoff(message, identities) {
  const trailers = execFileSync('git', ['interpret-trailers', '--parse'], {
    input: message,
    encoding: 'utf8',
  });
  return trailers.split('\n').some((line) => {
    const match = /^Signed-off-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i.exec(line);
    return (
      match &&
      identities.some(
        ({ name, email }) =>
          match[1].trim() === name.trim() && match[2].toLowerCase() === email.toLowerCase(),
      )
    );
  });
}

export function checkCommits(base, head) {
  if (!/^[a-f0-9]{40,64}$/i.test(head || '') || /^0+$/.test(head)) {
    throw new Error('Pass a full commit SHA as HEAD.');
  }
  if (base && !/^[a-f0-9]{40,64}$/i.test(base)) throw new Error('Pass a full commit SHA as BASE.');
  const range = base && !/^0+$/.test(base) ? `${base}..${head}` : head;
  const commits = execFileSync('git', ['rev-list', '--no-merges', range], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  const missing = [];
  for (const sha of commits) {
    const [authorName, authorEmail, committerName, committerEmail, message] = execFileSync(
      'git',
      ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha],
      { encoding: 'utf8' },
    ).split('\0');
    if (
      !hasSignoff(message, [
        { name: authorName, email: authorEmail },
        { name: committerName, email: committerEmail },
      ])
    )
      missing.push(sha);
  }
  if (missing.length)
    throw new Error(`Missing author/committer Signed-off-by trailer: ${missing.join(', ')}`);
  console.log(`Verified sign-off on ${commits.length} introduced non-merge commit(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkCommits(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
