import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const [previousDir, candidateDir, reportFile, previousMain] = process.argv.slice(2);
if (!previousDir || !candidateDir || !reportFile)
  throw new Error(
    'Usage: compatibility-report.mjs OLD_BIN_DIR NEW_BIN_DIR REPORT.json [PREVIOUS_MAIN]',
  );
const baseline = JSON.parse(
  await readFile('tools/api-contract/compatibility-baseline.json', 'utf8'),
);
const git = (...args) => execFileSync('git', args, { maxBuffer: 16 * 1024 * 1024 });
const candidate = git('rev-parse', 'HEAD').toString().trim();
const views = [
  'public/openapi.json',
  'public/owner-openapi.json',
  'public/global-openapi.json',
  'public/agent-entry-openapi.json',
  'public/operator-openapi.json',
  'tools/api-contract/portal-regional-openapi.json',
  'tools/api-contract/portal-global-openapi.json',
];
const cache = await mkdtemp(join(tmpdir(), 'agentspace-compatibility-'));
const report = {
  candidate,
  baseline,
  format: 2,
  contracts: [],
  binaries: {},
  clients: {},
  previousClients: 'not run',
  dataUpgrade: 'not run',
  rollbackAfterWrite: 'not run',
  coverage:
    'Two isolated Workspace APIs, Global and Regional Meta on RustFS, loopback Owner sessions and fixture SQL provider. Rollback evidence covers exercised writes only.',
};
async function digest(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}
async function compare(file, revision, role, oldBytes, newBytes) {
  const result = {
    file,
    revision,
    role,
    sha256: createHash('sha256').update(newBytes).digest('hex'),
    status: 'not run',
  };
  report.contracts.push(result);
  if (oldBytes.equals(newBytes)) {
    result.status = 'unchanged';
    return;
  }
  const original = JSON.parse(oldBytes);
  const current = JSON.parse(newBytes);
  result.operations = [];
  for (const [path, methods] of Object.entries(original.paths))
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation?.operationId) continue;
      if (current.paths?.[path]?.[method]?.operationId !== operation.operationId)
        result.operations.push({ path, method, expectedOperationId: operation.operationId });
    }
  const oldFile = join(cache, 'previous.json');
  await writeFile(oldFile, oldBytes);
  const args = [oldFile, file, '--allow-external-refs=false', '--format', 'json'];
  const findings = spawnSync(
    process.env.OASDIFF_BINARY || 'oasdiff',
    ['breaking', ...args, '--fail-on', 'WARN'],
    { encoding: 'utf8' },
  );
  if (findings.error) throw findings.error;
  result.status = findings.status === 0 && !result.operations.length ? 'passed' : 'failed';
  result.findings = findings.stdout.trim() ? JSON.parse(findings.stdout) : [];
  if (findings.status !== 0) console.error(findings.stderr || JSON.stringify(result.findings));
  else {
    const changes = execFileSync(process.env.OASDIFF_BINARY || 'oasdiff', ['changelog', ...args], {
      encoding: 'utf8',
    });
    result.changes = changes.trim() ? JSON.parse(changes) : [];
  }
}

try {
  const revisions = [[baseline.publicContract, 'frozen']];
  if (previousMain && previousMain !== baseline.publicContract) {
    if (!/^[0-9a-f]{40}$/.test(previousMain)) throw new Error('Invalid previous main revision');
    const ancestor = spawnSync('git', [
      'merge-base',
      '--is-ancestor',
      baseline.publicContract,
      previousMain,
    ]);
    if (ancestor.status === 0) revisions.push([previousMain, 'previous main']);
    else if (ancestor.status !== 1 || previousMain !== baseline.previousRuntime)
      throw new Error('Previous main has no verified compatibility ancestry');
  }
  // Preserve the intentional transition in the first release report. Later changes
  // are always evaluated against the frozen tree, with no per-change exceptions.
  if (previousMain === baseline.previousRuntime) {
    report.preFreezeChanges = {};
    for (const file of views) {
      const before = git('show', baseline.previousRuntime + ':' + file);
      const frozen = git('show', baseline.publicContract + ':' + file);
      if (before.equals(frozen)) continue;
      const from = join(cache, 'before-freeze.json');
      const to = join(cache, 'freeze.json');
      await writeFile(from, before);
      await writeFile(to, frozen);
      const changes = execFileSync(
        process.env.OASDIFF_BINARY || 'oasdiff',
        ['changelog', from, to, '--allow-external-refs=false', '--format', 'json'],
        { encoding: 'utf8' },
      );
      report.preFreezeChanges[file] = JSON.parse(changes || '[]');
    }
  }
  for (const [revision, role] of revisions)
    for (const file of views) {
      await compare(file, revision, role, git('show', revision + ':' + file), await readFile(file));
    }
  if (
    (await readFile(join(previousDir, 'source-revision'), 'utf8')).trim() !==
    baseline.previousRuntime
  )
    throw new Error('Predecessor binaries do not match the selected source');
  for (const [role, directory] of [
    ['predecessor', previousDir],
    ['candidate', candidateDir],
  ]) {
    const source = role === 'candidate' ? candidate : baseline.previousRuntime;
    const served = execFileSync(
      join(resolve(directory), 'workspace-backend'),
      ['openapi', 'regional'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (
      !isDeepStrictEqual(
        JSON.parse(served),
        JSON.parse(git('show', source + ':public/openapi.json')),
      )
    )
      throw new Error(role + ' binary exports a different contract from its recorded source');
    report.binaries[role] = {};
    for (const file of ['workspace-backend', 'workspace-meta-service'])
      report.binaries[role][file] = await digest(join(directory, file));
  }
  for (const path of [
    'src/generated/workspace-agent.mjs',
    'src/clients/python/workspace_agent.py',
  ]) {
    const file = join(cache, basename(path));
    await writeFile(file, git('show', baseline.previousRuntime + ':' + path));
    report.clients[basename(path)] = await digest(file);
  }
  const fixture = spawnSync(
    join(resolve(candidateDir), 'compatibility-fixture'),
    [resolve(previousDir), resolve(candidateDir), cache],
    { encoding: 'utf8', timeout: 180_000 },
  );
  for (const [field, marker] of [
    ['previousClients', 'PREVIOUS_CLIENTS_PASSED'],
    ['dataUpgrade', 'DATA_UPGRADE_PASSED'],
    ['rollbackAfterWrite', 'ROLLBACK_AFTER_WRITE_PASSED'],
  ])
    if (fixture.stdout?.split('\n').includes(marker)) report[field] = 'passed';
  if (fixture.error) throw fixture.error;
  if (
    fixture.status !== 0 ||
    [report.previousClients, report.dataUpgrade, report.rollbackAfterWrite].includes('not run')
  )
    throw new Error(fixture.stderr || 'Compatibility fixture did not complete all assertions');
  if (report.contracts.some((entry) => entry.status === 'failed'))
    throw new Error('Public contract compatibility failed');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await rm(cache, { recursive: true, force: true });
  await mkdir(resolve(reportFile, '..'), { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log('Compatibility report:', report.status, reportFile);
  if (report.error) console.error(report.error);
}
