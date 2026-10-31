import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('automatic checks execute once and releases require exact-commit native evidence', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.pull_request, undefined);
  for (const input of ['backend/**', 'meta-service/**', 'Cargo.lock', 'Dockerfile'])
    assert.ok(workflow.on.push.paths.includes(input), `API release lost ${input}`);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ['deploy', 'inspect']);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'deploy');
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
    "${{ github.event.inputs.operation == 'inspect' && 'console' || 'full' }}",
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
  assert.equal(ci.jobs.browser.needs, 'scope');
  assert.equal(
    ci.jobs.browser.if,
    "${{ !cancelled() && needs.scope.outputs.backend_only != 'true' }}",
  );
  assert.deepEqual(ci.jobs['backend-scope'].needs, ['scope', 'metadata']);
  assert.equal(ci.jobs['backend-scope'].name, 'Backend-only scope');
  assert.equal(
    ci.jobs['backend-scope'].if,
    "${{ !cancelled() && needs.scope.outputs.backend_only == 'true' && needs.metadata.result == 'success' }}",
  );
  assert.equal(
    ci.jobs.browser.steps.filter((step) => step.run === 'npm run build:console').length,
    1,
  );
  assert.equal(ci.jobs.metadata.needs, 'scope');
  assert.equal(
    ci.jobs.metadata.if,
    "${{ !cancelled() && (github.event_name != 'pull_request' || needs.scope.outputs.ui_only != 'true') }}",
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
  assert.match(scope.run, /ui_only=false/);
  assert.match(scope.run, /backend_only=false/);
  assert.equal(ci.jobs.scope.outputs.backend_only, '${{ steps.scope.outputs.backend_only }}');
  assert.equal(ci.jobs.scope.steps[0].with['fetch-depth'], 0);
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
  assert.equal(releaseBuild.if, "github.event.inputs.operation != 'inspect'");
  assert.ok(
    workflow.jobs.deploy.steps.some(
      (step) => step.env?.IMAGE_DIGEST === '${{ steps.image.outputs.digest }}',
    ),
  );
  assert.equal(workflow.jobs.deploy.steps.at(-2).run, 'node scripts/deploy-dev.mjs');
  assert.equal(workflow.jobs.deploy.steps.at(-1).name, 'Confirm Deployment image');
});

test('main pushes and default manual runs publish and deploy; inspection is explicit', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  const deployment = workflow.jobs.deploy;
  const build = deployment.steps.find((step) => step.id === 'image');
  const rollout = deployment.steps.find((step) => step.run === 'node scripts/deploy-dev.mjs');
  const confirm = deployment.steps.find((step) => step.name === 'Confirm Deployment image');
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
    for (const step of [build, rollout, confirm]) {
      const runs =
        runInNewContext(deployment.if, { github }) && runInNewContext(step.if, { github });
      assert.equal(runs, expected, `${event} on ${ref} (${operation ?? 'no operation'})`);
    }
  }
});

test('workflow reads the selected Deployment image and rejects mismatch or unavailable evidence', (t) => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  const confirm = workflow.jobs.deploy.steps.find(
    (step) => step.name === 'Confirm Deployment image',
  );
  const directory = mkdtempSync(join(tmpdir(), 'deployment-image-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const argsFile = join(directory, 'args');
  writeFileSync(
    join(directory, 'kubectl'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS_FILE"\nprintf "%s" "$TEST_STDOUT"\nprintf "%s" "$TEST_STDERR" >&2\nexit "$TEST_EXIT"\n',
    { mode: 0o700 },
  );
  const target = (containers) => JSON.stringify({ spec: { template: { spec: { containers } } } });
  for (const [name, stdout, exit, expectedImage, success] of [
    [
      'matching selected container',
      target([
        { name: 'sidecar', image: 'example/sidecar:old' },
        { name: 'api', image: config.image },
      ]),
      '0',
      config.image,
      true,
    ],
    [
      'old image despite another matching container',
      target([
        { name: 'api', image: 'example/api:old' },
        { name: 'sidecar', image: config.image },
      ]),
      '0',
      config.image,
      false,
    ],
    [
      'missing selected container',
      target([{ name: 'sidecar', image: config.image }]),
      '0',
      config.image,
      false,
    ],
    ['invalid response', 'invalid JSON', '0', config.image, false],
    ['kubectl failure', '', '1', config.image, false],
    ['missing expected image', target([]), '0', '', false],
  ]) {
    const result = spawnSync('bash', ['-c', confirm.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`,
        DEPLOY_NAMESPACE: config.namespace,
        K8S_DEPLOYMENT: config.deployment,
        K8S_CONTAINER: config.container,
        IMAGE_REF: expectedImage,
        TEST_ARGS_FILE: argsFile,
        TEST_STDOUT: stdout,
        TEST_STDERR: 'Synthetic private detail that must not reach Actions logs',
        TEST_EXIT: exit,
      },
    });
    assert.equal(result.status, success ? 0 : 1, name);
    assert.equal(
      result.stdout,
      success ? `Deployment image confirmed: sha256:${'b'.repeat(64)}\n` : '',
      name,
    );
    assert.equal(result.stderr, success ? '' : 'Deployment image verification failed.\n', name);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      '--request-timeout=30s',
      'get',
      `deployment/${config.deployment}`,
      '-n',
      config.namespace,
      '-o',
      'json',
    ]);
  }
});
