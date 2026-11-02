import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { deployDev, recoverDev } from './deploy-dev.mjs';
import { files as integrationFiles, fullCommand } from './ci-full-integration.mjs';

const config = {
  namespace: 'example-dev',
  deployment: 'example-api',
  container: 'api',
  image: `registry.example/api@sha256:${'b'.repeat(64)}`,
  sourceSha: 'c'.repeat(40),
};

const oldImage = `registry.example/api@sha256:${'a'.repeat(64)}`;
const pause = async () => {};

test('full partition uses the verified merge base and fails closed on mismatched parents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-partition-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'CI fixture');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(
    join(root, 'scripts/ci-full-integration.mjs'),
    readFileSync(new URL('./ci-full-integration.mjs', import.meta.url)),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'backend:test:integration': fullCommand } }),
  );
  for (const file of integrationFiles) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '// fixture\n');
  }
  git('add', '.');
  git('commit', '-qm', 'trusted base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'candidate');
  writeFileSync(join(root, 'candidate.txt'), 'candidate\n');
  git('add', 'candidate.txt');
  git('commit', '-qm', 'candidate');
  const head = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'merge candidate', 'candidate');
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const script = ci.jobs.scope.steps.find((step) => step.id === 'full_partition').run;
  const output = join(root, 'output');
  const classify = (overrides = {}) => {
    writeFileSync(output, '');
    const env = {
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: root,
      BASE_SHA: base,
      HEAD_SHA: head,
      BEFORE_SHA: '',
      ...overrides,
    };
    delete env.NODE_TEST_CONTEXT;
    execFileSync('bash', ['-c', script], { cwd: root, env, stdio: 'pipe' });
    return readFileSync(output, 'utf8');
  };
  assert.equal(classify(), 'full_partition=true\n');
  assert.equal(classify({ BASE_SHA: 'f'.repeat(40) }), 'full_partition=false\n');
  assert.equal(classify({ HEAD_SHA: 'f'.repeat(40) }), 'full_partition=false\n');
  assert.equal(classify({ GITHUB_EVENT_NAME: 'push', BEFORE_SHA: base }), 'full_partition=true\n');
  assert.equal(
    classify({ GITHUB_EVENT_NAME: 'push', BEFORE_SHA: 'f'.repeat(40) }),
    'full_partition=false\n',
  );
  git('switch', '-q', 'candidate');
  assert.equal(classify(), 'full_partition=false\n');
});

function fixture({
  failRollout = false,
  failPublic = false,
  patchUncertain = false,
  concurrent = false,
  failBaseline = false,
  stillReady = false,
  alterDuringFailure = false,
} = {}) {
  const calls = [];
  let current = {
    metadata: { uid: 'uid-1', resourceVersion: '1', generation: 1 },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      template: {
        spec: {
          containers: [
            { name: 'api', image: oldImage, readinessProbe: { httpGet: { path: '/api/health' } } },
          ],
        },
      },
    },
    status: { observedGeneration: 1, availableReplicas: 1, updatedReplicas: 1, readyReplicas: 1 },
  };
  let rolloutCalls = 0;
  const kube = (args) => {
    calls.push(args);
    if (args[0] === 'get') return JSON.stringify(current);
    if (args[0] === 'patch') {
      if (patchUncertain) throw new Error('unknown response');
      const patch = JSON.parse(args[args.indexOf('--patch') + 1]);
      assert.equal(patch.metadata.resourceVersion, current.metadata.resourceVersion);
      current.spec.template.spec.containers[0].image = patch.spec.template.spec.containers[0].image;
      current.metadata.generation++;
      current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
      current.status.observedGeneration = current.metadata.generation;
      current.status.availableReplicas = 1;
      current.status.readyReplicas = 1;
      if (concurrent)
        current.spec.template.spec.containers[0].env = [{ name: 'OTHER', value: 'changed' }];
      return '';
    }
    if (args[0] === 'rollout') {
      rolloutCalls++;
      if (failRollout && rolloutCalls === 1) {
        if (!stillReady) {
          current.status.availableReplicas = 0;
          current.status.readyReplicas = 0;
        }
        if (alterDuringFailure)
          current.spec.template.spec.containers[0].env = [{ name: 'CHANGED', value: 'yes' }];
        throw new Error('timed out');
      }
      return '';
    }
    throw new Error('unexpected command');
  };
  let requests = 0;
  const request = async (url) => {
    requests++;
    if (failBaseline || (failPublic && requests > 3))
      return { status: 500, json: async () => ({}) };
    if (url.endsWith('/health')) return { status: 200, json: async () => ({ status: 'ok' }) };
    if (url.endsWith('/auth/config')) return { status: 200, json: async () => ({ enabled: true }) };
    return { status: 401 };
  };
  return { calls, kube, request, current: () => current };
}
const approval = JSON.stringify([
  { sourceSha: config.sourceSha, previousDigest: oldImage.split('@')[1], storageCompatible: true },
]);

test('release checks an existing healthy single writer and verifies rollout and public API', async () => {
  const f = fixture();
  await deployDev(config, f.kube, f.request, pause);
  assert.equal(f.current().spec.template.spec.containers[0].image, config.image);
  assert.deepEqual(
    f.calls.map((call) => call[0]),
    ['get', 'patch', 'get', 'rollout', 'get'],
  );
});

test('failed rollout restores only the explicitly compatible old image and still reports failure', async () => {
  const f = fixture({ failRollout: true });
  await assert.rejects(
    deployDev({ ...config, rollbackPolicy: approval }, f.kube, f.request, pause),
    /restored and verified/,
  );
  assert.equal(f.current().spec.template.spec.containers[0].image, oldImage);
  assert.equal(f.calls.filter((call) => call[0] === 'patch').length, 2);
});

test('failed rollout without matching compatibility evidence is not automatically downgraded', async () => {
  for (const rollbackPolicy of [
    undefined,
    '[]',
    JSON.stringify([
      {
        sourceSha: 'd'.repeat(40),
        previousDigest: oldImage.split('@')[1],
        storageCompatible: true,
      },
    ]),
  ]) {
    const f = fixture({ failRollout: true });
    await assert.rejects(
      deployDev({ ...config, rollbackPolicy }, f.kube, f.request, pause),
      /no compatible rollback/,
    );
    assert.equal(f.calls.filter((call) => call[0] === 'patch').length, 1);
  }
});

test('uncertain mutations, concurrent changes and public-only failures never trigger rollback', async () => {
  for (const options of [
    { patchUncertain: true },
    { concurrent: true },
    { failPublic: true },
    { failRollout: true, stillReady: true },
    { failRollout: true, alterDuringFailure: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      deployDev({ ...config, rollbackPolicy: approval }, f.kube, f.request, pause),
    );
    assert.equal(f.calls.filter((call) => call[0] === 'patch').length, 1);
  }
});

test('a broken public baseline or malformed compatibility policy never changes the deployment', async () => {
  const f = fixture({ failBaseline: true });
  await assert.rejects(deployDev(config, f.kube, f.request, pause), /baseline failed/);
  assert.ok(!f.calls.some((call) => call[0] === 'patch'));
  const g = fixture();
  await assert.rejects(
    deployDev({ ...config, rollbackPolicy: '{' }, g.kube, g.request, pause),
    /policy is invalid/,
  );
  assert.ok(!g.calls.some((call) => call[0] === 'patch'));
});

test('invalid input fails before contacting the cluster', async () => {
  for (const overrides of [
    { namespace: '../bad' },
    { image: 'example:latest' },
    { sourceSha: '' },
  ]) {
    await assert.rejects(
      deployDev(
        { ...config, ...overrides },
        () => assert.fail('Cluster contacted'),
        async () => {},
      ),
    );
  }
});

test('manual recovery requires an exact unavailable image and explicit compatibility', async () => {
  const f = fixture({ failRollout: true });
  await assert.rejects(deployDev(config, f.kube, f.request, pause), /no compatible rollback/);
  const recovery = {
    ...config,
    failedImage: config.image,
    image: oldImage,
    confirmation: 'storage-compatible',
  };
  await assert.rejects(
    recoverDev({ ...recovery, confirmation: '' }, f.kube, f.request, pause),
    /compatibility confirmation/,
  );
  await assert.rejects(
    recoverDev({ ...recovery, failedImage: oldImage }, f.kube, f.request, pause),
  );
  await recoverDev(recovery, f.kube, f.request, pause);
  assert.equal(f.current().spec.template.spec.containers[0].image, oldImage);
});

test('manual recovery refuses a healthy deployment or an unrelated failed image', async () => {
  const f = fixture();
  await assert.rejects(
    recoverDev(
      { ...config, failedImage: oldImage, confirmation: 'storage-compatible' },
      f.kube,
      f.request,
      pause,
    ),
    /unavailable/,
  );
  assert.ok(!f.calls.some((call) => call[0] === 'patch'));
});

test('CLI does not leak invalid Kubernetes output or stderr', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-redaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'kubectl'),
    '#!/bin/sh\nprintf "synthetic-private-deployment"\nprintf "synthetic-private-error" >&2\n',
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, ['scripts/deploy-dev.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${dirname(process.execPath)}`,
      DEPLOY_NAMESPACE: config.namespace,
      K8S_DEPLOYMENT: config.deployment,
      K8S_CONTAINER: config.container,
      IMAGE_REF: config.image,
      SOURCE_SHA: config.sourceSha,
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'A Kubernetes operation failed; inspect before action.\n');
});

test('automatic checks execute once and releases require exact-commit native evidence', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.pull_request, undefined);
  for (const input of ['backend/**', 'meta-service/**', 'Cargo.lock', 'Dockerfile'])
    assert.ok(workflow.on.push.paths.includes(input), `API release lost ${input}`);
  for (const path of [
    'backend/api/src/lib.rs',
    'meta-service/src/main.rs',
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    '.cargo/config.toml',
    'scripts/duckdb-runtime.json',
    'scripts/prepare-duckdb.mjs',
    'public/openapi.json',
    'public/owner-openapi.json',
    'public/global-openapi.json',
    'public/agent-entry-openapi.json',
    'package.json',
    'package-lock.json',
    '.node-version',
    'Dockerfile',
    '.dockerignore',
  ])
    assert.ok(
      workflow.on.push.paths.some((pattern) => matchesGlob(path, pattern)),
      path,
    );
  for (const path of [
    'scripts/deploy-dev.mjs',
    'scripts/deploy-dev.test.mjs',
    '.github/workflows/dev-cd.yml',
    '.github/workflows/ci.yml',
    'src/App.tsx',
    'README.md',
  ])
    assert.equal(
      workflow.on.push.paths.some((pattern) => matchesGlob(path, pattern)),
      false,
      path,
    );
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, [
    'deploy',
    'inspect',
    'recover',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'deploy');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.verification.options, [
    'full',
    'dev-smoke',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.verification.default, 'full');
  assert.equal(workflow.jobs.deploy.needs, 'verify');
  assert.equal(workflow.jobs.deploy.environment, 'dev');
  assert.equal(workflow.jobs.verify.environment, undefined);
  assert.equal(workflow.jobs.verify.permissions['actions'], 'read');
  assert.equal(workflow.jobs.image, undefined);
  const evidence = workflow.jobs.verify.steps.find((step) =>
    step.run?.startsWith('node scripts/require-ci.mjs '),
  );
  assert.ok(evidence);
  assert.equal(evidence.env.SOURCE_SHA, '${{ github.sha }}');
  assert.equal(
    evidence.env.GATE,
    "${{ github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy' && inputs.verification == 'dev-smoke' && 'dev-smoke' || inputs.operation == 'inspect' && 'console' || 'full' }}",
  );
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.deploy.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.deploy.concurrency.group, 'dev-cd-deploy-target');
  for (const name of ['verify', 'deploy'])
    assert.equal(
      workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref,
      '${{ github.sha }}',
    );
  assert.ok(!JSON.stringify(workflow.jobs.verify).includes('secrets.'));
  assert.equal(ci.jobs.quality.steps.filter((step) => step.run === 'npm run check').length, 1);
  assert.equal(ci.jobs.quality.needs, 'scope');
  assert.equal(ci.jobs.quality.if, '${{ !cancelled() }}');
  assert.equal(
    ci.jobs.quality.steps.find((step) => step.run === 'npm run check').if,
    "${{ needs.scope.outputs.docs_only != 'true' }}",
  );
  const docsQuality = ci.jobs.quality.steps.find(
    (step) => step.name === 'Check documentation and repository policy',
  );
  assert.equal(docsQuality.if, "${{ needs.scope.outputs.docs_only == 'true' }}");
  assert.equal(
    docsQuality.run,
    'npm run check:runtime && npm run check:repo && npm run format:check',
  );
  assert.equal(ci.jobs.browser.needs, 'scope');
  assert.equal(
    ci.jobs.browser.if,
    "${{ !cancelled() && needs.scope.outputs.backend_only != 'true' && needs.scope.outputs.docs_only != 'true' }}",
  );
  assert.deepEqual(ci.jobs['backend-scope'].needs, ['scope', 'metadata', 'product_integration']);
  assert.equal(ci.jobs['backend-scope'].name, 'Backend-only scope');
  assert.equal(
    ci.jobs['backend-scope'].if,
    "${{ always() && !cancelled() && needs.scope.outputs.backend_only == 'true' && needs.metadata.result == 'success' && (needs.product_integration.result == 'success' || (needs.product_integration.result == 'skipped' && (needs.scope.outputs.full_partition != 'true' || needs.scope.outputs.history_only == 'true' || contains(fromJSON('[\"tutorial\",\"database\",\"files\"]'), needs.scope.outputs.classic_profile)))) }}",
  );
  assert.equal(
    ci.jobs.browser.steps.filter((step) => step.run === 'npm run build:console').length,
    1,
  );
  assert.equal(ci.jobs.metadata.needs, 'scope');
  assert.equal(
    ci.jobs.metadata.if,
    "${{ !cancelled() && needs.scope.outputs.ui_only != 'true' && needs.scope.outputs.docs_only != 'true' }}",
  );
  assert.deepEqual(ci.jobs['documentation-scope'].needs, ['scope', 'quality']);
  assert.equal(ci.jobs['documentation-scope'].name, 'Documentation-only scope');
  assert.equal(
    ci.jobs['documentation-scope'].if,
    "${{ !cancelled() && needs.scope.outputs.docs_only == 'true' && needs.quality.result == 'success' }}",
  );
  const scope = ci.jobs.scope.steps.find((step) => step.id === 'scope');
  assert.equal(
    scope.if,
    "(github.event_name == 'pull_request' && github.base_ref == 'main') || github.event_name == 'push'",
  );
  assert.equal(scope.env.BEFORE_SHA, '${{ github.event.before }}');
  assert.match(scope.run, /policy_ref='HEAD\^1'/);
  assert.match(scope.run, /policy_ref="\$BEFORE_SHA"/);
  assert.match(scope.run, /merge-base --is-ancestor/);
  assert.match(scope.run, /git show "\$policy_ref:scripts\/ci-ui-scope\.mjs"/);
  assert.match(scope.run, /git show "\$policy_ref:scripts\/ci-docs-scope\.mjs"/);
  assert.match(scope.run, /docs_only=false/);
  assert.match(scope.run, /ui_only=false/);
  assert.match(scope.run, /backend_only=false/);
  assert.equal(ci.jobs.scope.outputs.backend_only, '${{ steps.scope.outputs.backend_only }}');
  assert.equal(ci.jobs.scope.outputs.docs_only, '${{ steps.scope.outputs.docs_only }}');
  assert.equal(
    ci.jobs.scope.outputs.history_only,
    '${{ steps.history_scope.outputs.history_only }}',
  );
  const historyScope = ci.jobs.scope.steps.find((step) => step.id === 'history_scope');
  assert.equal(historyScope.if, "github.event_name == 'pull_request' && github.base_ref == 'main'");
  assert.match(historyScope.run, /git show 'HEAD\^1:scripts\/ci-history-scope\.mjs'/);
  assert.match(historyScope.run, /history_only=false/);
  assert.equal(
    ci.jobs.scope.outputs.classic_profile,
    '${{ steps.classic_scope.outputs.classic_profile }}',
  );
  const classicScope = ci.jobs.scope.steps.find((step) => step.id === 'classic_scope');
  assert.equal(classicScope.if, "github.event_name == 'pull_request' && github.base_ref == 'main'");
  assert.match(classicScope.run, /git show 'HEAD\^1:scripts\/ci-classic-scope\.mjs'/);
  assert.match(classicScope.run, /classic_profile=full/);
  assert.equal(
    ci.jobs.scope.outputs.full_partition,
    '${{ steps.full_partition.outputs.full_partition }}',
  );
  const partitionScope = ci.jobs.scope.steps.find((step) => step.id === 'full_partition');
  assert.equal(partitionScope.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(partitionScope.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.match(partitionScope.run, /policy_ref='HEAD\^1'/);
  assert.match(partitionScope.run, /git rev-parse HEAD\^1/);
  assert.match(partitionScope.run, /git rev-parse HEAD\^2/);
  assert.match(partitionScope.run, /merge-base --is-ancestor/);
  assert.match(partitionScope.run, /git show "\$policy_ref:scripts\/ci-full-integration\.mjs"/);
  assert.match(partitionScope.run, /full_partition=false/);
  assert.equal(ci.jobs.scope.steps[0].with['fetch-depth'], 0);
  const fullIntegration = ci.jobs.metadata.steps.find(
    (step) => step.run === 'npm run backend:test:integration',
  );
  assert.equal(
    fullIntegration.if,
    '${{ needs.scope.outputs.history_only != \'true\' && !contains(fromJSON(\'["tutorial","database","files"]\'), needs.scope.outputs.classic_profile) && needs.scope.outputs.full_partition != \'true\' }}',
  );
  const otherIntegration = ci.jobs.metadata.steps.find(
    (step) => step.name === 'Run remaining native API and real S3 integration tests',
  );
  assert.equal(
    otherIntegration.if,
    '${{ needs.scope.outputs.history_only != \'true\' && !contains(fromJSON(\'["tutorial","database","files"]\'), needs.scope.outputs.classic_profile) && needs.scope.outputs.full_partition == \'true\' }}',
  );
  assert.match(otherIntegration.run, /git show "\$policy_ref:scripts\/ci-full-integration\.mjs"/);
  assert.match(otherIntegration.run, /node "\$runner" other/);
  const productIntegration = ci.jobs.product_integration;
  assert.equal(productIntegration.name, 'Native product integration');
  assert.equal(productIntegration.needs, 'scope');
  assert.equal(
    productIntegration.if,
    "${{ !cancelled() && needs.scope.outputs.full_partition == 'true' && needs.scope.outputs.history_only != 'true' && !contains(fromJSON('[\"tutorial\",\"database\",\"files\"]'), needs.scope.outputs.classic_profile) && needs.scope.outputs.ui_only != 'true' && needs.scope.outputs.docs_only != 'true' }}",
  );
  assert.ok(!JSON.stringify(productIntegration).includes('secrets.'));
  assert.equal(productIntegration.steps[0].with['fetch-depth'], 0);
  assert.equal(
    productIntegration.steps.find((step) => step.uses?.startsWith('Swatinem/rust-cache@')).with[
      'save-if'
    ],
    false,
  );
  const productStep = productIntegration.steps.find(
    (step) => step.name === 'Run product API integration tests',
  );
  assert.match(productStep.run, /git show "\$policy_ref:scripts\/ci-full-integration\.mjs"/);
  assert.match(productStep.run, /node "\$runner" product/);
  const historyIntegration = ci.jobs.metadata.steps.find(
    (step) => step.name === 'Run history authorization, isolation and storage integration tests',
  );
  assert.equal(historyIntegration.if, "${{ needs.scope.outputs.history_only == 'true' }}");
  assert.match(historyIntegration.run, /git show 'HEAD\^1:scripts\/run-history-integration\.mjs'/);
  const classicIntegration = ci.jobs.metadata.steps.find(
    (step) => step.name === 'Run classic and risk-specific integration tests',
  );
  assert.equal(
    classicIntegration.if,
    '${{ needs.scope.outputs.history_only != \'true\' && contains(fromJSON(\'["tutorial","database","files"]\'), needs.scope.outputs.classic_profile) }}',
  );
  assert.match(classicIntegration.run, /git show 'HEAD\^1:scripts\/run-classic-integration\.mjs'/);
  assert.equal(ci.jobs.metadata.steps[0].with['fetch-depth'], 0);
  for (const command of [
    'npm run backend:fmt',
    'npm run backend:build -- --timings',
    'npm run backend:clippy',
    'npm run backend:test',
    'npm run backend:test:integration',
  ]) {
    assert.equal(ci.jobs.metadata.steps.filter((step) => step.run === command).length, 1, command);
    assert.ok(!JSON.stringify(workflow).includes(command), `CD duplicates ${command}`);
  }
  assert.ok(!JSON.stringify(workflow).includes('npm run check'));
  const prBuild = ci.jobs.image.steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  );
  assert.equal(ci.jobs.image.if, "github.event_name == 'pull_request'");
  assert.equal(ci.jobs.image.needs, undefined);
  assert.equal(ci.jobs.image.environment, undefined);
  assert.ok(!JSON.stringify(ci.jobs.image).includes('secrets.'));
  assert.equal(prBuild.with.push, false);
  assert.equal(prBuild.with.load, true);
  assert.equal(prBuild.with.platforms, 'linux/amd64');
  assert.match(
    prBuild.with['cache-from'],
    /scope=native-api-pr-\$\{\{ github\.event\.pull_request\.number \}\}/,
  );
  assert.match(prBuild.with['cache-from'], /scope=native-api-linux-amd64-v1/);
  assert.match(
    prBuild.with['cache-to'],
    /scope=native-api-pr-\$\{\{ github\.event\.pull_request\.number \}\}/,
  );
  assert.equal(prBuild.if, "steps.changes.outputs.changed == 'true'");
  assert.ok(ci.jobs.image.steps.some((step) => step.run === 'node scripts/ci-image-inputs.mjs'));
  const smoke = ci.jobs.image.steps.find(
    (step) => step.name === 'Run the final native image without network or writable root',
  );
  assert.equal(smoke.if, prBuild.if);
  assert.match(smoke.run, /--network none --read-only --cap-drop ALL/);
  const releaseBuild = workflow.jobs.deploy.steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  );
  assert.equal(releaseBuild.with.push, true);
  assert.equal(releaseBuild.with.labels, prBuild.with.labels);
  assert.equal(
    releaseBuild.if,
    "github.event.inputs.operation != 'inspect' && github.event.inputs.operation != 'recover'",
  );
  assert.ok(
    workflow.jobs.deploy.steps.some(
      (step) => step.env?.IMAGE_DIGEST === '${{ steps.image.outputs.digest }}',
    ),
  );
  assert.equal(workflow.jobs.deploy.steps.at(-2).run, 'node scripts/deploy-dev.mjs');
  assert.equal(workflow.jobs.deploy.steps.at(-1).run, 'node scripts/deploy-dev.mjs --recover');
});

test('main pushes and default manual runs publish and deploy; inspection is explicit', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  const deployment = workflow.jobs.deploy;
  const build = deployment.steps.find((step) => step.id === 'image');
  const rollout = deployment.steps.find((step) => step.run === 'node scripts/deploy-dev.mjs');
  for (const [event, ref, requested, expected] of [
    ['push', 'refs/heads/main', undefined, true],
    ['workflow_dispatch', 'refs/heads/main', undefined, true],
    ['workflow_dispatch', 'refs/heads/main', 'deploy', true],
    ['workflow_dispatch', 'refs/heads/main', 'inspect', false],
    ['workflow_dispatch', 'refs/heads/main', 'recover', false],
    ['workflow_dispatch', 'refs/heads/feature', undefined, false],
    ['pull_request', 'refs/pull/1/merge', undefined, false],
    ['pull_request', 'refs/heads/main', undefined, false],
  ]) {
    const operation =
      event === 'workflow_dispatch'
        ? (requested ?? workflow.on.workflow_dispatch.inputs.operation.default)
        : undefined;
    const github = { event_name: event, ref, event: { inputs: { operation } } };
    for (const step of [build, rollout]) {
      const runs =
        runInNewContext(deployment.if, { github }) && runInNewContext(step.if, { github });
      assert.equal(runs, expected, `${event} on ${ref} (${operation ?? 'no operation'})`);
    }
  }
});
