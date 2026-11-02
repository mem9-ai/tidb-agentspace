import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Counts include the parent and every nested test. Changes to tests or this
// trusted-base manifest always select the full gate, not this runner.
const core = [
  [
    'server/meta-service.test.mjs',
    'record metadata preserves atomicity, per-record conflicts, receipts, scope isolation and crash recovery',
    1,
  ],
  [
    'server/guest-host.test.mjs',
    'hosted Guest survives restart and Global outage with isolated regional Workspaces',
    1,
  ],
  [
    'server/contract.test.mjs',
    'published regional owner contract exposes only owner-authenticated history operations',
    1,
  ],
  [
    'server/contract.test.mjs',
    'native API responses conform to every declared JSON operation, including denials',
    1,
  ],
  [
    'server/rust-product.test.mjs',
    'tutorial sample uses Rust import and file analysis APIs without losing data on restart',
    1,
  ],
  ['server/rust-product.test.mjs', 'Workspace tutorial progress through remote metadata', 1],
  [
    'server/rust-product.test.mjs',
    'Rust API satisfies data, analysis, export and credential contracts through remote metadata',
    1,
  ],
];
const bothModes = (name, count) =>
  ['remote', 'inProcess'].map((mode) => [
    'server/rust-product.test.mjs',
    `${name} through ${mode} metadata`,
    count,
  ]);
const domain = [
  ...bothModes('Agent REST P0', 12),
  ...bothModes('OpenAPI behavioral coverage', 13),
  [
    'server/rust-product.test.mjs',
    'Rust API satisfies data, analysis, export and credential contracts through inProcess metadata',
    1,
  ],
];
const product = (name) => ['server/rust-product.test.mjs', name, 1];
export const profiles = {
  classic: core,
  tutorial: [...core, product('Workspace tutorial progress through inProcess metadata')],
  database: [
    ...core,
    ...domain,
    ...bothModes('REST workflow resources', 9),
    product(
      'Rust provider lifecycle retains one creation intent across retries, unknown responses and restart',
    ),
  ],
  files: [
    ...core,
    ...domain,
    product('an unavailable audit journal rejects a file mutation before provider I/O'),
    product('audit history journals covered effects without storing customer content'),
    product('image preview enforces the size boundary before reading and validates image type'),
    product('independent local File Systems can commit concurrent writes without losing events'),
    product('local File System deletion clears indexed files in bounded batches'),
    product('concurrent local file writes preserve directory and version checks'),
    product('a local File System with 10000 files supports bounded pages and point operations'),
    product('local file operations read only their File System after resumable index migration'),
  ],
};
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function completedSuite(cases, result) {
  const lines = (result.stdout || '').split('\n');
  const passed = cases.every(({ name }) =>
    lines.some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)),
  );
  const expected = cases.reduce((sum, entry) => sum + entry.count, 0);
  return (
    result.status === 0 &&
    passed &&
    lines.includes(`# pass ${expected}`) &&
    lines.includes('# fail 0') &&
    lines.includes('# cancelled 0') &&
    lines.includes('# skipped 0') &&
    lines.includes('# todo 0')
  );
}
export function groupedCases(profile) {
  const entries = profiles[profile];
  if (!entries) throw new Error('Unknown classic profile');
  const byFile = new Map();
  for (const [file, name, count] of entries) {
    const cases = byFile.get(file) || [];
    if (cases.some((entry) => entry.name === name)) throw new Error(`Duplicate test: ${name}`);
    cases.push({ name, count });
    byFile.set(file, cases);
  }
  return byFile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.argv[2] || 'classic';
  for (const [file, cases] of groupedCases(profile)) {
    const pattern = `^(?:${cases.map(({ name }) => escape(name)).join('|')})$`;
    console.log(`Classic profile ${profile}: ${file}: ${cases.map(({ name }) => name).join('; ')}`);
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
    if (!completedSuite(cases, result)) {
      console.error(`Classic integration verification incomplete: ${file}`);
      process.exit(1);
    }
  }
}
