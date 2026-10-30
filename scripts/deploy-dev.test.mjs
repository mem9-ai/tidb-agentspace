import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { deployDev } from './deploy-dev.mjs';

const previousImage = `registry.example/api@sha256:${'a'.repeat(64)}`;
const config = {
  namespace: 'example-dev',
  deployment: 'example-api',
  container: 'api',
  image: `registry.example/api@sha256:${'b'.repeat(64)}`,
};

function fixture({
  missing = false,
  failUpdate = false,
  failures = 0,
  externalOnFailure = false,
  externalOnRollback = false,
} = {}) {
  const container = {
    name: config.container,
    image: previousImage,
    readinessProbe: { httpGet: { path: '/api/health', port: 'http' } },
  };
  const template = {
    metadata: { annotations: { 'workspace.tidb.ai/runtime': 'rust-v1' } },
    spec: { containers: [container], volumes: [{ name: 'persistent-data' }] },
  };
  const calls = [];
  const metadata = { uid: 'owned-deployment', resourceVersion: '1' };
  const externalImage = `registry.example/api@sha256:${'c'.repeat(64)}`;
  let waits = 0;
  let patches = 0;
  return {
    calls,
    container,
    template,
    kubectl(args) {
      calls.push(args);
      assert.equal(args[args.indexOf('-n') + 1], config.namespace);
      if (args[0] === 'get') {
        if (missing) throw new Error('Private cluster endpoint unavailable');
        return JSON.stringify({ metadata, spec: { template } });
      }
      if (args[0] === 'patch') {
        assert.equal(args[1], `deployment/${config.deployment}`);
        const patch = JSON.parse(args[args.indexOf('--patch') + 1]);
        if (externalOnRollback && patches > 0) {
          container.image = externalImage;
          metadata.resourceVersion = String(Number(metadata.resourceVersion) + 1);
        }
        assert.deepEqual(patch.slice(0, 3), [
          { op: 'test', path: '/metadata/uid', value: metadata.uid },
          { op: 'test', path: '/metadata/resourceVersion', value: metadata.resourceVersion },
          { op: 'test', path: '/spec/template/spec/containers/0/image', value: container.image },
        ]);
        assert.equal(patch[3].op, 'replace');
        assert.equal(patch[3].path, '/spec/template/spec/containers/0/image');
        container.image = patch[3].value;
        metadata.resourceVersion = String(Number(metadata.resourceVersion) + 1);
        patches++;
        if (failUpdate && container.image === config.image) {
          if (externalOnFailure) container.image = externalImage;
          throw new Error('Response lost');
        }
        return '';
      }
      assert.deepEqual(args, [
        'rollout',
        'status',
        `deployment/${config.deployment}`,
        '-n',
        config.namespace,
        '--timeout=300s',
      ]);
      if (waits++ < failures) {
        if (externalOnFailure) container.image = externalImage;
        throw new Error('Readiness timed out');
      }
      return '';
    },
  };
}

test('release updates only the image and waits for HTTP readiness', () => {
  const f = fixture();
  const before = structuredClone(f.template);
  deployDev(config, f.kubectl);
  assert.equal(f.container.image, config.image);
  before.spec.containers[0].image = config.image;
  assert.deepEqual(f.template, before);
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['get', 'patch', 'rollout', 'get'],
  );
});

test('redeploying the current digest checks readiness without a mutation', () => {
  const f = fixture();
  deployDev({ ...config, image: previousImage }, f.kubectl);
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['get', 'rollout', 'get'],
  );
  const unhealthy = fixture({ failures: 1 });
  assert.throws(
    () => deployDev({ ...config, image: previousImage }, unhealthy.kubectl),
    /Current deployment is not ready/,
  );
  assert.equal(unhealthy.calls.length, 2);
});

test('invalid input fails before contacting the cluster', () => {
  for (const key of ['namespace', 'deployment', 'container']) {
    for (const value of [undefined, '', ' ', 'a/b', '$(id)', 'a'.repeat(64), 'bad\nname']) {
      assert.throws(
        () => deployDev({ ...config, [key]: value }, () => assert.fail('Cluster contacted')),
        /DNS labels/,
      );
    }
  }
  for (const image of [undefined, '', 'registry.example/api:latest', '$(id)']) {
    assert.throws(
      () => deployDev({ ...config, image }, () => assert.fail('Cluster contacted')),
      /immutable digest/,
    );
  }
});

test('missing deployment, container, immutable rollback target or readiness probe prevent writes', () => {
  const missing = fixture({ missing: true });
  assert.throws(() => deployDev(config, missing.kubectl), /Cannot read the existing Deployment/);
  assert.equal(missing.calls.length, 1);
  for (const mutate of [
    (c) => (c.name = 'different'),
    (c) => (c.image = 'registry.example/api:latest'),
    (c) => delete c.readinessProbe,
    (c) => (c.readinessProbe.httpGet.path = '/'),
  ]) {
    const f = fixture();
    mutate(f.container);
    assert.throws(() => deployDev(config, f.kubectl), /Existing container must/);
    assert.equal(f.calls.length, 1);
  }
});

test('failed rollout restores the captured digest and verifies recovery while failing the release', () => {
  const f = fixture({ failures: 1 });
  assert.throws(() => deployDev(config, f.kubectl), /previous image is restored and ready/);
  assert.equal(f.container.image, previousImage);
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['get', 'patch', 'rollout', 'get', 'patch', 'rollout', 'get'],
  );
});

test('update committed but response lost still restores the previous digest', () => {
  const f = fixture({ failUpdate: true });
  assert.throws(() => deployDev(config, f.kubectl), /previous image is restored and ready/);
  assert.equal(f.container.image, previousImage);
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['get', 'patch', 'get', 'patch', 'rollout', 'get'],
  );
});

test('failed rollback is surfaced without deletion or further retry', () => {
  const f = fixture({ failures: 2 });
  assert.throws(() => deployDev(config, f.kubectl), /rollback did not recover readiness/);
  assert.equal(f.calls.length, 6);
});

test('external image changes prevent rollback after timeout or lost update response', () => {
  for (const options of [{ failures: 1 }, { failUpdate: true }]) {
    const f = fixture({ ...options, externalOnFailure: true });
    assert.throws(() => deployDev(config, f.kubectl), /changed externally; rollback skipped/);
    assert.equal(f.container.image, `registry.example/api@sha256:${'c'.repeat(64)}`);
    assert.equal(f.calls.filter((args) => args[0] === 'patch').length, 1);
  }
});

test('atomic rollback preconditions preserve an external update after the rollback read', () => {
  const f = fixture({ failures: 1, externalOnRollback: true });
  assert.throws(() => deployDev(config, f.kubectl), /rollback did not recover readiness/);
  assert.equal(f.container.image, `registry.example/api@sha256:${'c'.repeat(64)}`);
  assert.equal(f.calls.filter((args) => args[0] === 'rollout').length, 1);
});

test('workflow keeps PRs credential-free and binds releases to one verified commit', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, [
    'inspect',
    'verify',
    'deploy',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'inspect');
  assert.equal(workflow.jobs.resolve, undefined);
  assert.equal(
    workflow.jobs.deploy.if,
    "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && github.event.inputs.operation != 'verify'",
  );
  assert.equal(
    workflow.jobs.verify.if,
    "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'",
  );
  assert.equal(workflow.jobs.deploy.needs, 'verify');
  assert.equal(workflow.jobs.deploy.environment, 'dev');
  assert.equal(workflow.jobs.verify.environment, undefined);
  assert.equal(workflow.jobs.image.environment, undefined);
  assert.equal(
    workflow.jobs.image.if,
    "github.event_name == 'pull_request' || (github.ref == 'refs/heads/main' && github.event.inputs.operation == 'verify')",
  );
  assert.equal(workflow.jobs.image.needs, undefined);
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' || github.event.inputs.operation == 'verify' }}",
  );
  assert.equal(
    workflow.concurrency.group,
    "dev-cd-${{ (github.event_name == 'pull_request' || github.event.inputs.operation == 'verify') && format('verify-{0}', github.ref) || 'deploy' }}",
  );
  assert.equal(workflow.jobs.deploy.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.deploy.concurrency.group, 'dev-cd-deploy-target');
  for (const name of ['verify', 'image', 'deploy']) {
    assert.equal(
      workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref,
      '${{ github.sha }}',
    );
  }
  for (const name of ['verify', 'image']) {
    const job = workflow.jobs[name];
    assert.ok(!JSON.stringify(job).includes('secrets.'));
    assert.notEqual(job.permissions?.['id-token'], 'write');
  }
  assert.ok(workflow.jobs.verify.steps.some((s) => s.run === 'npm run check' && !s.if));
  for (const command of [
    'npm run backend:fmt',
    'npm run backend:build -- --timings',
    'npm run backend:clippy',
    'npm run backend:test',
    'npm run backend:test:integration',
  ]) {
    const step = workflow.jobs.verify.steps.find((s) => s.run === command);
    assert.ok(step, `Release verification lost ${command}`);
    assert.equal(step.if, "github.event.inputs.operation != 'inspect'");
  }
  const prBuild = workflow.jobs.image.steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  );
  assert.equal(prBuild.with.push, false);
  assert.equal(prBuild.with.load, true);
  assert.equal(prBuild.with.platforms, 'linux/amd64');
  const releaseBuild = workflow.jobs.deploy.steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  );
  assert.equal(releaseBuild.with.platforms, 'linux/amd64');
  assert.equal(releaseBuild.with.push, true);
  assert.equal(releaseBuild.if, "github.event.inputs.operation != 'inspect'");
  assert.ok(
    workflow.jobs.deploy.steps.some(
      (s) => s.env?.IMAGE_DIGEST === '${{ steps.image.outputs.digest }}',
    ),
  );
  assert.equal(workflow.jobs.deploy.steps.at(-1).run, 'node scripts/deploy-dev.mjs');
});

test('image delivery refuses a legacy target before mutation', () => {
  const f = fixture();
  delete f.template.metadata.annotations;
  assert.throws(() => deployDev(config, f.kubectl), /Bootstrap the native target/);
  assert.equal(f.calls.length, 1);
});
