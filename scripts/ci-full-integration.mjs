import { appendFile, lstat, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GitHub scope classification runs from the verified base. The native runner discovers
// every Cargo integration target and executes both independent partitions.
export const runner = 'backend/build-tools/src/bin/workspace-verify.rs';
export const files = [
  runner,
  ...[
    'contract',
    'guest_host',
    'host_transport',
    'identity_directory',
    'meta',
    'product',
    'sso',
  ].map((name) => `backend/test-support/tests/${name}.rs`),
  'backend/host/tests/local_runtime.rs',
  'backend/build-tools/tests/package.rs',
];
export const fullCommand = 'cargo acceptance all';
export async function partition(command, event) {
  if (command !== fullCommand || !['pull_request', 'push'].includes(event)) return false;
  try {
    return (await Promise.all(files.map((file) => lstat(file)))).every((stat) => stat.isFile());
  } catch {
    return false;
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  if (process.argv[2] !== 'classify') throw new Error('Expected classify');
  const command = JSON.parse(await readFile('package.json', 'utf8')).scripts?.[
    'backend:test:integration'
  ];
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `full_partition=${await partition(command, process.env.GITHUB_EVENT_NAME)}\n`,
  );
}
