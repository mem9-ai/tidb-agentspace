import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// This manifest is executed from the trusted base, never from the candidate.
// An edited full command falls back to the existing unsharded test command.
export const files = [
  'server/meta-service.test.mjs',
  'server/identity-directory.test.mjs',
  'server/guest-host.test.mjs',
  'server/rust-backend.test.mjs',
  'server/rust-product.test.mjs',
  'server/contract.test.mjs',
  'scripts/package-runtime.test.mjs',
  'server/local-runtime.test.mjs',
  'server/rust-sso.test.mjs',
];
const prefix = 'WORKSPACE_META_TEST=1 WORKSPACE_BACKEND_TEST=1 node --test --test-concurrency=1 ';
export const fullCommand = prefix + files.join(' ');

export function partition(command, event) {
  if (!['pull_request', 'push'].includes(event) || command !== fullCommand) return null;
  return {
    product: files.filter((file) => file === 'server/rust-product.test.mjs'),
    other: files.filter((file) => file !== 'server/rust-product.test.mjs'),
  };
}

async function presentFiles() {
  const present = await Promise.all(
    files.map(async (file) => {
      try {
        return (await lstat(file)).isFile();
      } catch {
        return false;
      }
    }),
  );
  return present.every(Boolean);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const command = JSON.parse(await readFile('package.json', 'utf8')).scripts?.[
      'backend:test:integration'
    ];
    const candidate = partition(command, process.env.GITHUB_EVENT_NAME);
    const groups = candidate && (await presentFiles()) ? candidate : null;
    const action = process.argv[2];
    if (action === 'classify') {
      await appendFile(process.env.GITHUB_OUTPUT, `full_partition=${Boolean(groups)}\n`);
      console.log(`Full integration partition: ${groups ? 'enabled' : 'unsharded fallback'}`);
    } else {
      if (!groups || !['product', 'other'].includes(action))
        throw new Error('The trusted full integration partition is unavailable.');
      console.log(`Full integration group ${action}: ${groups[action].join(', ')}`);
      const result = spawnSync(
        process.execPath,
        ['--test', '--test-concurrency=1', ...groups[action]],
        {
          stdio: 'inherit',
          env: { ...process.env, WORKSPACE_META_TEST: '1', WORKSPACE_BACKEND_TEST: '1' },
        },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
