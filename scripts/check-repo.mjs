import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const nodeVersion = (await read('.node-version')).trim();
assert.equal((await read('.nvmrc')).trim(), nodeVersion, 'Node version files drifted.');
assert.match(pkg.engines.node, new RegExp(nodeVersion.replaceAll('.', '\\.')));
assert.equal(pkg.packageManager, `npm@${pkg.engines.npm}`);
assert.equal(
  pkg.devDependencies['@types/node'].split('.')[0],
  nodeVersion.split('.')[0],
  '@types/node must match the pinned Node runtime major.',
);
for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `Pin an exact version for ${name}.`);
}
for (const name of ['@duckdb/node-api', 'mysql2', 'pg', 'just-bash']) {
  assert.equal(
    pkg.dependencies[name] ?? pkg.devDependencies[name],
    undefined,
    `The retired Node business runtime dependency ${name} must not return. See server/README.md.`,
  );
}
for (const path of ['server/regression-api.mjs', 'server/store.mjs', 'server/providers']) {
  await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' });
}
for (const path of [
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursor/rules/workspace.mdc',
]) {
  assert.ok((await read(path)).includes('AGENTS.md'), `${path} must point to shared instructions.`);
}
assert.match(await read('CLAUDE.md'), /^@AGENTS\.md$/m);
assert.match(await read('.cursor/rules/workspace.mdc'), /^alwaysApply: true$/m);
// Check onboarding/rule routing and availability, not whether an agent read or understood them.
const instructionLinks = {
  'README.md': ['start-here.md'],
  'CONTRIBUTING.md': ['start-here.md'],
  'CLAUDE.md': ['start-here.md'],
  '.github/copilot-instructions.md': ['../start-here.md'],
  '.cursor/rules/workspace.mdc': ['../../start-here.md'],
  'start-here.md': [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'docs/architecture.md',
    'docs/independent-delivery.md',
    'docs/decisions/README.md',
    'docs/standards/README.md',
    'docs/standards/intent-driven-development.md',
    'docs/standards/github-contribution-workflow.md',
    'docs/ci-cd.md',
  ],
  'AGENTS.md': [
    'start-here.md',
    'docs/standards/README.md',
    'docs/standards/tiui-design-system.md',
    'docs/standards/product-experience.md',
    'docs/standards/knowledge-maintenance.md',
  ],
  'src/AGENTS.md': [
    '../AGENTS.md',
    '../docs/standards/tiui-design-system.md',
    '../docs/standards/product-experience.md',
    '../docs/standards/knowledge-maintenance.md',
  ],
  'docs/standards/README.md': [
    '../../start-here.md',
    'tiui-design-system.md',
    'product-experience.md',
    'knowledge-maintenance.md',
    '../../src/AGENTS.md',
  ],
  'docs/standards/tiui-design-system.md': ['../decisions/0002-tiui-design-system.md'],
  'docs/standards/knowledge-maintenance.md': ['../../start-here.md'],
};
for (const [source, targets] of Object.entries(instructionLinks)) {
  const contents = await read(source);
  for (const target of targets) {
    assert.ok(contents.includes(`](${target})`), `${source} must link to ${target}.`);
    const destination = new URL(target, new URL(source, root));
    assert.ok((await readFile(destination, 'utf8')).trim(), `${source}: ${target} is empty.`);
  }
}
for (const [, target] of (await read('start-here.md')).matchAll(/\]\(([^)\s]+)\)/g)) {
  if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
  await access(new URL(target.split('#')[0], root));
}
const names = await readdir(new URL('.github/workflows/', root));
for (const name of names.filter((file) => /\.ya?ml$/.test(file))) {
  const workflow = parse(await read(`.github/workflows/${name}`));
  assert.equal(workflow.permissions.contents, 'read', `${name}: unexpected token permissions.`);
  assert.ok(
    !('pull_request_target' in workflow.on),
    `${name}: privileged PR execution is prohibited.`,
  );
  assert.ok(workflow.concurrency, `${name}: declare concurrency.`);
  const jobs = Object.values(workflow.jobs);
  const ownsGate = jobs.some((job) => job.steps.some((step) => step.run === 'npm run check'));
  const consumesGate =
    [
      'dev-cd.yml',
      'console-publish.yml',
      'guest-enable.yml',
      'retire-legacy-workspace.yml',
    ].includes(name) &&
    jobs.some((job) =>
      job.steps.some((step) => step.run?.startsWith('node scripts/require-ci.mjs ')),
    );
  assert.ok(
    ownsGate || consumesGate,
    `${name}: execute or verify the exact-commit shared quality gate.`,
  );
  for (const job of jobs) {
    assert.ok(job['timeout-minutes'] > 0, `${name}: set a timeout.`);
    for (const step of job.steps) {
      if (step.uses)
        assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, `${name}: pin action SHAs.`);
      if (step.uses?.startsWith('actions/checkout@'))
        assert.equal(step.with['persist-credentials'], false);
      if (step.uses?.startsWith('actions/setup-node@'))
        assert.equal(step.with['node-version-file'], '.node-version');
      if (step.name === 'Select the pinned npm version')
        assert.equal(step.run, `npm install --global npm@${pkg.engines.npm} --ignore-scripts`);
    }
  }
}
console.log(
  'Shared instruction/standard links, dependency pins, toolchain, and workflow baseline verified.',
);
