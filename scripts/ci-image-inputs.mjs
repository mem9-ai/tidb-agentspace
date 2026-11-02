import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativeImageInput(path) {
  return /^(backend\/|meta-service\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo\/|scripts\/(duckdb-runtime\.json|prepare-duckdb\.mjs|deploy-dev\.mjs$|ci-image-inputs)|public\/(?:owner-|global-|agent-entry-)?openapi\.json$|package(?:-lock)?\.json$|\.node-version$|Dockerfile$|\.dockerignore$|\.github\/workflows\/(ci|dev-cd)\.yml$)/.test(
    path,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // PR checkouts are merge candidates: their first parent is the tested base.
  const files = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD^1', 'HEAD'], {
    encoding: 'utf8',
  }).split('\0');
  const changed = files.some(nativeImageInput);
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  console.log(changed ? 'Native image inputs changed.' : 'No native image inputs changed.');
}
