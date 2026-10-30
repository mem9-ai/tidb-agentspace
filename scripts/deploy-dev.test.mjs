import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { deployDev } from './deploy-dev.mjs';

const config = {
  namespace: 'example-dev',
  deployment: 'example-api',
  container: 'api',
  image: `registry.example/api@sha256:${'b'.repeat(64)}`,
};

test('release sets only the selected image without reading or waiting for the target', () => {
  const calls = [];
  deployDev(config, (args) => calls.push(args));
  assert.deepEqual(calls, [
    [
      'set',
      'image',
      `deployment/${config.deployment}`,
      '-n',
      config.namespace,
      `api=${config.image}`,
    ],
  ]);
});

test('a failed image update fails the release without retry, readiness checks or rollback', () => {
  let calls = 0;
  assert.throws(
    () =>
      deployDev(config, () => {
        calls++;
        throw new Error('Private cluster endpoint unavailable');
      }),
    { message: 'Deployment image update failed; inspect the target before retrying.' },
  );
  assert.equal(calls, 1);
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

test('workflow keeps PRs credential-free and binds releases to one verified commit', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.push.paths, workflow.on.pull_request.paths);
  for (const input of ['backend/**', 'meta-service/**', 'Cargo.lock', 'Dockerfile'])
    assert.ok(workflow.on.push.paths.includes(input), `API release lost ${input}`);
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.on.pull_request, null);
  assert.deepEqual(ci.on.push, { branches: ['main'] });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ['deploy', 'inspect']);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'deploy');
  assert.equal(workflow.jobs.resolve, undefined);
  assert.equal(
    workflow.jobs.deploy.if,
    "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
  );
  assert.equal(
    workflow.jobs.verify.if,
    "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'",
  );
  assert.equal(workflow.jobs.deploy.needs, 'verify');
  assert.equal(workflow.jobs.deploy.environment, 'dev');
  assert.equal(workflow.jobs.verify.environment, undefined);
  assert.equal(workflow.jobs.image.environment, undefined);
  assert.equal(workflow.jobs.image.if, "github.event_name == 'pull_request'");
  assert.equal(workflow.jobs.image.needs, undefined);
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' }}",
  );
  assert.equal(
    workflow.concurrency.group,
    "dev-cd-${{ github.event_name == 'pull_request' && format('verify-{0}', github.ref) || 'deploy' }}",
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
