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

function fixture({ missing = false, failUpdate = false, failures = 0 } = {}) {
  const container = {
    name: config.container,
    image: previousImage,
    readinessProbe: { httpGet: { path: '/api/health', port: 'http' } },
  };
  const template = { spec: { containers: [container], volumes: [{ name: 'persistent-data' }] } };
  const calls = [];
  let waits = 0;
  return {
    calls,
    container,
    template,
    kubectl(args) {
      calls.push(args);
      assert.equal(args[args.indexOf('-n') + 1], config.namespace);
      if (args[0] === 'get') {
        if (missing) throw new Error('Private cluster endpoint unavailable');
        return JSON.stringify({ spec: { template } });
      }
      if (args[0] === 'set') {
        assert.deepEqual(args.slice(0, 3), ['set', 'image', `deployment/${config.deployment}`]);
        container.image = args[3].slice(`${config.container}=`.length);
        if (failUpdate && container.image === config.image) throw new Error('Response lost');
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
      if (waits++ < failures) throw new Error('Readiness timed out');
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
    ['get', 'set', 'rollout'],
  );
});

test('redeploying the current digest checks readiness without a mutation', () => {
  const f = fixture();
  deployDev({ ...config, image: previousImage }, f.kubectl);
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['get', 'rollout'],
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
    ['get', 'set', 'rollout', 'set', 'rollout'],
  );
});

test('update committed but response lost still restores the previous digest', () => {
  const f = fixture({ failUpdate: true });
  assert.throws(() => deployDev(config, f.kubectl), /previous image is restored and ready/);
  assert.equal(f.container.image, previousImage);
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['get', 'set', 'set', 'rollout'],
  );
});

test('failed rollback is surfaced without deletion or further retry', () => {
  const f = fixture({ failures: 2 });
  assert.throws(() => deployDev(config, f.kubectl), /rollback did not recover readiness/);
  assert.equal(f.calls.length, 5);
});

test('workflow keeps PRs credential-free and binds releases to one verified commit', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['deploy_ref']);
  assert.equal(workflow.jobs.deploy.if, "github.event_name != 'pull_request'");
  assert.deepEqual(workflow.jobs.deploy.needs, ['resolve', 'verify']);
  assert.equal(workflow.jobs.deploy.environment, 'dev');
  assert.equal(workflow.jobs.verify.environment, undefined);
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' }}",
  );
  assert.equal(workflow.jobs.deploy.concurrency['cancel-in-progress'], false);
  for (const name of ['verify', 'deploy']) {
    assert.equal(
      workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref,
      '${{ needs.resolve.outputs.sha }}',
    );
  }
  const prBuild = workflow.jobs.verify.steps.find((step) =>
    step.run?.includes('docker buildx build'),
  );
  assert.equal(prBuild.if, "github.event_name == 'pull_request'");
  assert.ok(!prBuild.run.includes('--push'));
  const releaseBuild = workflow.jobs.deploy.steps.find((step) =>
    step.run?.includes('docker buildx build'),
  );
  assert.match(releaseBuild.run, /--platform linux\/amd64,linux\/arm64/);
  assert.match(releaseBuild.run, /--metadata-file/);
  assert.match(releaseBuild.run, /--push/);
  assert.equal(workflow.jobs.deploy.steps.at(-1).run, 'node scripts/deploy-dev.mjs');
});
