import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { bootstrapDev, devResources } from './bootstrap-dev.mjs';

const config = {
  namespace: 'example-dev',
  deployment: 'example-api',
  container: 'api',
  image: `registry.example/api@sha256:${'a'.repeat(64)}`,
  storageClass: 'example-ebs',
};

test('initial API preserves state and admits only a single writer', () => {
  const [policy, pvc, service, deployment] = devResources(config);
  assert.equal(policy.kind, 'NetworkPolicy');
  assert.deepEqual(policy.spec.podSelector.matchLabels, deployment.spec.template.metadata.labels);
  assert.deepEqual(policy.spec.policyTypes, ['Ingress']);
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOncePod']);
  assert.equal(pvc.spec.storageClassName, config.storageClass);
  assert.equal(pvc.spec.resources.requests.storage, '10Gi');
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(container.name, config.container);
  assert.equal(container.image, config.image);
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels);
  assert.deepEqual(service.spec.selector, deployment.spec.template.metadata.labels);
  assert.equal(service.spec.type, 'ClusterIP');
  assert.equal(service.spec.ports[0].nodePort, undefined);
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(container.ports[0].hostPort, undefined);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  const dataMount = container.volumeMounts.find((mount) => mount.mountPath === '/data');
  const dataVolume = pod.volumes.find((volume) => volume.name === dataMount.name);
  assert.equal(dataVolume.persistentVolumeClaim.claimName, pvc.metadata.name);
  assert.equal(dataVolume.emptyDir, undefined);
  assert.ok(
    container.env.some(
      (env) => env.name === 'WORKSPACE_DATA_FILE' && env.value === '/data/workspace.json',
    ),
  );
  assert.ok(
    container.env.some((env) => env.name === 'WORKSPACE_API_HOST' && env.value === '0.0.0.0'),
  );
  for (const probe of [container.startupProbe, container.readinessProbe, container.livenessProbe]) {
    assert.equal(probe.httpGet.port, container.ports[0].name);
    assert.equal(probe.httpGet.path, '/api/health');
    assert.equal(probe.httpGet.host, undefined); // Connect to the Pod IP, not the kubelet's loopback.
    assert.deepEqual(probe.httpGet.httpHeaders, [{ name: 'Host', value: '127.0.0.1' }]);
  }
});

test('bootstrap rejects missing, malformed and shell-shaped input before contacting the cluster', () => {
  for (const key of ['namespace', 'deployment', 'container', 'storageClass'])
    for (const value of [undefined, '', ' ', 'a/b', '$(id)', 'a'.repeat(64), 'bad\nname'])
      assert.throws(
        () =>
          bootstrapDev({ ...config, [key]: value }, 'bootstrap', () =>
            assert.fail('Cluster contacted'),
          ),
        /DNS label/,
      );
  for (const image of [
    undefined,
    '',
    'example/api:latest',
    `example/api@sha256:${'a'.repeat(63)}`,
    '$(id)',
  ])
    assert.throws(() => devResources({ ...config, image }), /digest/);
  assert.throws(
    () => bootstrapDev(config, 'deploy', () => assert.fail('Cluster contacted')),
    /mode/,
  );
});

function fixture({ existingKind, failedAt, provisioner = 'ebs.csi.aws.com' } = {}) {
  const calls = [];
  return {
    calls,
    kubectl(args, input) {
      calls.push({ args, input });
      if (args.includes(failedAt)) throw new Error('Cluster failure');
      if (args[1] === 'storageclass') return JSON.stringify({ provisioner });
      if (args.includes('--ignore-not-found')) return args[1] === existingKind ? 'existing' : '';
      return '';
    },
  };
}

test('preview performs server-side validation without creating resources', () => {
  const f = fixture();
  bootstrapDev(config, 'bootstrap-preview', f.kubectl);
  const writes = f.calls.filter(({ args }) => args[0] === 'create');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].args.includes('--dry-run=server'));
  assert.deepEqual(JSON.parse(writes[0].input).items, devResources(config));
});

test('bootstrap creates exactly the validated manifest and never deletes storage', () => {
  const f = fixture();
  bootstrapDev(config, 'bootstrap', f.kubectl);
  const writes = f.calls.filter(({ args }) => args[0] === 'create');
  assert.equal(writes.length, 2);
  assert.ok(writes[0].args.includes('--dry-run=server'));
  assert.ok(!writes[1].args.includes('--dry-run=server'));
  assert.equal(writes[0].input, writes[1].input);
  assert.ok(f.calls.every(({ args }) => !args.includes('delete')));
});

test('existing resources, unsupported storage, and failed preflight prevent creation', () => {
  for (const existingKind of ['NetworkPolicy', 'PersistentVolumeClaim', 'Service', 'Deployment']) {
    const f = fixture({ existingKind });
    assert.throws(() => bootstrapDev(config, 'bootstrap', f.kubectl), /already exists/);
    assert.ok(f.calls.every(({ args }) => args[0] === 'get'));
  }
  const unsupported = fixture({ provisioner: 'kubernetes.io/aws-ebs' });
  assert.throws(() => bootstrapDev(config, 'bootstrap', unsupported.kubectl), /EBS CSI/);
  for (const failedAt of ['namespace', 'storageclass', 'csidriver', '--dry-run=server']) {
    const f = fixture({ failedAt });
    assert.throws(() => bootstrapDev(config, 'bootstrap', f.kubectl), /Cluster failure/);
    assert.ok(f.calls.every(({ args }) => args[0] === 'get' || args.includes('--dry-run=server')));
  }
});

test('partial creation failure is surfaced without destructive compensation', () => {
  const f = fixture();
  assert.throws(
    () =>
      bootstrapDev(config, 'bootstrap', (args, input) => {
        const output = f.kubectl(args, input);
        if (args[0] === 'create' && !args.includes('--dry-run=server'))
          throw new Error('Partial creation');
        return output;
      }),
    /Partial creation/,
  );
  assert.ok(f.calls.every(({ args }) => !args.includes('delete') && !args.includes('undo')));
});

test('main always releases, PRs never deploy, and previews never wait or roll back', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/dev-cd.yml', import.meta.url), 'utf8'),
  );
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  const job = workflow.jobs.deploy;
  assert.equal(job.if, "github.event_name != 'pull_request'");
  assert.deepEqual(job.needs, ['resolve', 'verify']);
  assert.equal(job.env.DEPLOYMENT_MODE, "${{ inputs.deployment_mode || 'deploy' }}");
  assert.equal(
    job.steps.find((step) => step.id === 'rollout').if,
    "env.DEPLOYMENT_MODE != 'bootstrap-preview'",
  );
  assert.ok(
    job.steps
      .find((step) => step.name === 'Roll back on failed rollout')
      .if.includes("env.DEPLOYMENT_MODE == 'deploy'"),
  );
  for (const name of ['verify', 'deploy'])
    assert.equal(
      workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref,
      '${{ needs.resolve.outputs.sha }}',
    );
  assert.equal(job.concurrency['cancel-in-progress'], false);
});
