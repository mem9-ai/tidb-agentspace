import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Names and counts include every nested case. Changes to tests or this
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
const agentCases = [
  'resource pages remain bounded and enforce grants on every request',
  'context discovers only the authenticated principal without widening grants',
  'read-only SQL permits reads and catalog, rejects hidden writes before I/O',
  'local versions compare atomically, including identical content and recreation',
  'Drive9 raw and JSON writes use atomic provider revisions',
  'file validators remain usable after durable crash recovery',
  'detail and deletion enforce actions, grants and Workspace isolation before I/O',
  'local deletion is repeatable and blocks data access without deleting Keys',
  'accepted deletion is retained and never repeats across normal or crash restart',
  'db9 and private DuckDB storage delete once while retaining credentials',
  'lost provider deletion response remains unknown after crash and never retries',
];
const apiCases = [
  'action/resource/credential denial matrix has no upstream reads or writes',
  'colliding resource IDs stay isolated across real Workspaces and discovery',
  'retired DuckDB private storage stays hidden',
  'local file paths, UTF-8 writes, conflicts and deletion preserve exact state',
  'native binary transfer and create-only conflicts preserve bytes and headers',
  'PostgreSQL writes, reads and unknown outcomes are not retried',
  'exports preserve CSV/JSON/JSONL precision, column order and create-only destinations',
  'imports bind actor, destination, source version and single-use concurrent confirmation',
  'import row bounds and reviewed dialect-safe field mappings are enforced before SQL',
  'import failures retain unknown outcomes, table-conflict recovery and revocation checks',
  'API and Meta restart retain data and revocation while invalidating ephemeral reviews',
  'acknowledged files and Workspace keys survive abrupt process loss with explicit writer recovery',
];
const workflowCases = [
  'one import collection creates both media representations with followable review identity',
  'cancellation and confirmation cannot both win',
  'export reviews are addressable, currently authorized and cancellable',
  'setup creates durable identities, scoped replay, permission denial and bounded history without effects',
  'PostgreSQL setup resumes saved bindings and reconciles unknown creation without replacement',
  'a crash during PostgreSQL setup never replays an uncertain write',
  'encoded table identity is decoded exactly once, including reserved-looking names',
  'removed command and DELETE-body routes return 404 before upstream I/O',
];
const bothModes = (name, children) =>
  ['remote', 'inProcess'].map((mode) => [
    'server/rust-product.test.mjs',
    `${name} through ${mode} metadata`,
    children.length + 1,
    children,
  ]);
const domain = [
  ...bothModes('Agent REST P0', agentCases),
  ...bothModes('OpenAPI behavioral coverage', apiCases),
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
    ...bothModes('REST workflow resources', workflowCases),
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
  const passed = cases.every(({ name, count, children = [] }) => {
    if (count !== children.length + 1 || new Set(children).size !== children.length) return false;
    const start = lines.indexOf(`# Subtest: ${name}`);
    const end = lines.findIndex(
      (line, index) => index > start && /^ok \d+ - /.test(line) && line.endsWith(name),
    );
    if (start < 0 || end <= start) return false;
    const group = lines.slice(start + 1, end);
    const declared = group.map((line) => /^ {4}# Subtest: (.+)$/.exec(line)?.[1]).filter(Boolean);
    const actual = group.map((line) => /^ {4}ok \d+ - (.+)$/.exec(line)?.[1]).filter(Boolean);
    return (
      actual.length === children.length &&
      declared.length === children.length &&
      children.every((child, index) => actual[index] === child && declared[index] === child)
    );
  });
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
  for (const [file, name, count, children = []] of entries) {
    const cases = byFile.get(file) || [];
    if (cases.some((entry) => entry.name === name)) throw new Error(`Duplicate test: ${name}`);
    cases.push({ name, count, children });
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
