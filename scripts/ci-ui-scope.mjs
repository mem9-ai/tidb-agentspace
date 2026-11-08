import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiFile = /^src\/(?!api\/).+\.(?:ts|tsx|css)$/;
const companionFile =
  /^(?:src\/(?!api\/).+\.test\.mjs|e2e\/[^/]+\.spec\.mjs|README\.md|docs\/screenshots\/.+\.(?:png|jpe?g|webp)|docs\/standards\/(?:product-experience|browser-verification)\.md|docs\/(?!standards\/|ci-cd\.md$|console-publishing\.md$|decisions\/0027-single-ci-evidence\.md$).+\.md|specs\/.+\.md)$/;
const nativeSource = /^(?:backend\/(?!(?:contracts|openapi)\/)|meta-service\/).+\.rs$/;
const nativeFile =
  /^(?:(?:backend|meta-service)\/.+\.(?:rs|toml)|Cargo\.(?:toml|lock)|rust-toolchain\.toml|\.cargo\/config\.toml|docs\/(?:rust-backend|meta-service|native-backend-retirement)\.md)$/;

export function isUiOnlyChange(event, parents, files) {
  return (
    ((event === 'pull_request' && parents === 2) || (event === 'push' && parents >= 1)) &&
    files.length > 0 &&
    files.some((file) => uiFile.test(file)) &&
    files.every((file) => uiFile.test(file) || companionFile.test(file))
  );
}

export function isBackendOnly(event, parents, files) {
  return (
    (event === 'push' || (event === 'pull_request' && parents === 2)) &&
    files.some((file) => nativeSource.test(file)) &&
    files.every((file) => nativeFile.test(file) && !/^backend\/(?:contracts|openapi)\//.test(file))
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let uiOnly = false;
  let backendOnly = false;
  try {
    const event = process.env.GITHUB_EVENT_NAME;
    const parents =
      execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/).length - 1;
    let base = 'HEAD^1';
    if (event === 'push') {
      base = process.env.BEFORE_SHA;
      if (!/^[a-f0-9]{40}$/.test(base || '') || /^0+$/.test(base))
        throw new Error('Missing push baseline.');
      execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { stdio: 'pipe' });
    } else if (event !== 'pull_request' || parents !== 2) {
      throw new Error('Not a known merge candidate.');
    }
    const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    uiOnly = isUiOnlyChange(event, parents, files);
    backendOnly = isBackendOnly(event, parents, files);
  } catch {
    console.log('Unable to classify the candidate; run native and browser checks.');
  }
  await appendFile(process.env.GITHUB_OUTPUT, `ui_only=${uiOnly}\nbackend_only=${backendOnly}\n`);
  console.log({ uiOnly, backendOnly });
}
