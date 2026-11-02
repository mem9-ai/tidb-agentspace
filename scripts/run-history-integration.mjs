import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Selected by a trusted-base policy only for existing history-only source edits.
// Names are pinned deliberately: a renamed or skipped test fails the gate.
export const suites = [
  [
    'server/meta-service.test.mjs',
    ['inactive history is isolated and survives a real metadata restart'],
  ],
  [
    'server/guest-host.test.mjs',
    ['hosted Guest survives restart and Global outage with isolated regional Workspaces'],
  ],
  [
    'server/contract.test.mjs',
    [
      'published regional owner contract exposes only owner-authenticated history operations',
      'native API responses conform to every declared JSON operation, including denials',
    ],
  ],
  [
    'server/rust-product.test.mjs',
    [
      'an unavailable audit journal rejects a file mutation before provider I/O',
      'audit history journals covered effects without storing customer content',
      'request history records authenticated responses without paths, secrets or cross-Workspace leakage',
      'history pages require the current Workspace owner and disclose unavailable collection',
      'concurrent resource creation preserves idempotency without a Workspace writer lock',
    ],
  ],
  [
    'server/rust-sso.test.mjs',
    [
      'native hosted /studio SSO, stable identity, owner grants, logout and replay protection',
      'SSO logout after CREATE revokes in-flight import (local legacy)',
      'SSO logout after CREATE revokes in-flight import (personal)',
    ],
  ],
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function completedSuite(names, result) {
  const lines = (result.stdout || '').split('\n');
  const passed = names.every((name) =>
    lines.some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)),
  );
  return result.status === 0 && passed && lines.includes(`# pass ${names.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, names] of suites) {
    const pattern = `^(?:${names.map(escape).join('|')})$`;
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern', pattern, file],
      {
        env: { ...process.env, WORKSPACE_META_TEST: '1', WORKSPACE_BACKEND_TEST: '1' },
        encoding: 'utf8',
      },
    );
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (!completedSuite(names, result)) {
      console.error(`History integration verification incomplete: ${file}`);
      process.exit(1);
    }
  }
}
