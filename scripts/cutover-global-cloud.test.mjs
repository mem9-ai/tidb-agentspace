import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import {
  cutover,
  configureHealthProbes,
  probeSummary,
  prepareCutover,
  readTarget,
  recoverPrepared,
  verifyGlobal,
  waitForBootstrap,
} from './cutover-global-cloud.mjs';

const options = {
  namespace: 'dev',
  deployment: 'workspace',
  container: 'api',
  operation: 'reset-and-enable-global',
};
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const decode = (v) => JSON.parse(Buffer.from(v, 'base64').toString());
function fixture() {
  const image = 'registry.example/api@sha256:' + 'a'.repeat(64);
  const source = {
    metadata: { uid: 'target-uid', resourceVersion: '7' },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      template: {
        spec: {
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'api',
              image,
              args: ['serve', '--config', '/run/workspace/deployment.json'],
              env: [
                { name: 'TIDB_SSO_ISSUER', value: 'https://identity.example/' },
                { name: 'TIDB_SSO_CLIENT_ID', value: 'public-client' },
                {
                  name: 'TIDB_SSO_REDIRECT_URI',
                  value: 'https://drive9.ai/studio/api/auth/tidbcloud/callback',
                },
                {
                  name: 'TIDB_SSO_OWNER_SUBJECTS',
                  valueFrom: { secretKeyRef: { name: 'login', key: 'subjects' } },
                },
              ],
              volumeMounts: [{ name: 'private', mountPath: '/run/workspace' }],
              readinessProbe: { exec: { command: ['true'] } },
            },
          ],
          initContainers: [
            {
              name: 'copy',
              image,
              command: ['sh', '-c', 'cp /projected/* /run/workspace/; chmod 600 /run/workspace/*'],
              volumeMounts: [
                { name: 'source', mountPath: '/projected' },
                { name: 'private', mountPath: '/run/workspace' },
              ],
            },
          ],
          volumes: [
            {
              name: 'source',
              secret: { secretName: 'original', items: [{ key: 'api.json', path: 'api.json' }] },
            },
            { name: 'private', emptyDir: { medium: 'Memory' } },
          ],
        },
      },
    },
  };
  const api = {
    bind: '0.0.0.0:4318',
    workspaceId: 'ws_agentlab',
    authorityId: 'region:studio-dev',
    metadata: { transport: 'inProcess', authorityId: 'region:studio-dev' },
    publicOrigins: ['https://drive9.ai'],
    publicPath: '/studio',
    consoleOrigins: [],
    product: { providers: { filesProvider: 'drive9-anonymous' } },
  };
  const services = ['global', 'region'].map((name) => ({
    kind: 'metadata',
    configFile: `/run/workspace/${name}.json`,
  }));
  services.push({ kind: 'workspace', configFile: '/run/workspace/api.json' });
  const data = { 'api.json': encode(api), 'deployment.json': encode({ format: 1, services }) };
  for (const role of ['global', 'region']) {
    data[role + '.json'] = encode({
      authorityId: role === 'global' ? role : api.authorityId,
      s3: {
        endpoint: 'https://s3.example',
        bucket: 'private-bucket',
        prefix: `old-installation/${role}`,
      },
      tokenFile: `/run/workspace/${role}-token`,
      encryptionKeyFile: `/run/workspace/${role}-key`,
    });
    data[role + '-token'] = Buffer.from('old-token-' + role).toString('base64');
    data[role + '-key'] = Buffer.from('old-key-' + role).toString('base64');
  }
  const secret = { metadata: { name: 'original' }, immutable: true, data };
  const calls = [];
  const kubectl = (args, input) => {
    const call = { args, input };
    if (args[0] === 'patch') {
      const path = args.find((a) => a.startsWith('--patch-file=')).slice('--patch-file='.length);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      call.patch = JSON.parse(readFileSync(path, 'utf8'));
      call.patchPath = path;
    }
    calls.push(call);
    if (args[0] === 'get') {
      if (['jobs', 'pods', 'events', 'storageclasses', 'csidrivers'].includes(args[1]))
        return JSON.stringify({ items: [] });
      if (args[1] === 'pvc') return JSON.stringify({ items: [] });
      if (args[1] === 'job')
        return JSON.stringify({ status: { conditions: [{ type: 'Complete', status: 'True' }] } });
      if (args[1] === 'deployment' || args[1] === 'deployment/workspace')
        return JSON.stringify(source);
      if (args[2] === 'original') return JSON.stringify(secret);
      if (args[2] === 'login')
        return JSON.stringify({
          data: { subjects: Buffer.from('private-subject').toString('base64') },
        });
      assert.fail('Unexpected configuration read');
    }
    return '';
  };
  return { source, secret, calls, kubectl, image };
}
const healthy = async (url) => {
  if (url.endsWith('/api/auth/config'))
    return Response.json({ globalApi: { apiPathPrefix: '/studio/api/global' } });
  if (url.endsWith('/api/v1/workspaces') || url.endsWith('/keys'))
    return Response.json({}, { status: 401 });
  return Response.json({ status: 'ok' });
};

test('inspection reads only referenced configuration and reports no identities or credential values', async () => {
  const f = fixture();
  const report = await cutover({ ...options, operation: 'inspect' }, f.kubectl);
  assert.equal(report.globalConfigured, false);
  assert.ok(f.calls.every((c) => c.args[0] === 'get'));
  for (const value of ['private-subject', 'old-token', 'old-key', 'private-bucket'])
    assert.ok(!JSON.stringify(report).includes(value));
});

test('cloud preparation isolates roots and credentials, retains one callback and initializes Meta security state', async () => {
  const f = fixture();
  const before = JSON.stringify(f.secret);
  const prepared = await prepareCutover(readTarget(options, f.kubectl), options);
  assert.equal(JSON.stringify(f.secret), before);
  const data = prepared.secret.data;
  const api = decode(data['api.json']);
  const global = decode(data['global-api.json']);
  assert.equal(api.sso.redirectUri, 'https://drive9.ai/studio/api/auth/tidbcloud/callback');
  assert.equal(global.sso, undefined);
  assert.equal(global.localWorkspace, undefined);
  assert.equal(global.sharedListener, true);
  assert.equal(global.initializeClock, false);
  assert.equal(api.security.initializeClock, false);
  assert.equal(global.metadataSecurityState, true);
  assert.equal(api.security.metadataSecurityState, true);
  assert.equal(decode(data['global-api-bootstrap.json']).initializeClock, true);
  assert.equal(decode(data['api-bootstrap.json']).security.initializeClock, true);
  for (const name of ['global', 'region']) {
    assert.notEqual(data[name + '-key'], f.secret.data[name + '-key']);
    assert.notEqual(data[name + '-token'], f.secret.data[name + '-token']);
    assert.ok(
      decode(data[name + '.json']).s3.prefix.startsWith(`old-installation/${name}-global-`),
    );
  }
  assert.notEqual(data['global-key'], data['region-key']);
  assert.notEqual(data['global-signing.der'], data['region-signing.der']);
  assert.equal(data['control-ca.key'], undefined);
  assert.equal(prepared.secret.immutable, true);
  assert.equal(prepared.patch.metadata.resourceVersion, '7');
  const pod = prepared.patch.spec.template.spec;
  assert.equal(pod.containers[0].image, f.image);
  assert.deepEqual(
    pod.containers[0].readinessProbe,
    f.source.spec.template.spec.containers[0].readinessProbe,
  );
  assert.equal(pod.volumes[0].secret.items, undefined);
  assert.equal(prepared.pvc, undefined);
  assert.ok(!pod.volumes.some((volume) => volume.name === 'global-security'));
  assert.equal(prepared.job.spec.template.spec.containers[0].readinessProbe, undefined);
  assert.deepEqual(prepared.job.spec.template.spec.containers[0].args, [
    'initialize',
    '--config',
    '/run/workspace/bootstrap.json',
  ]);
  assert.equal(prepared.job.spec.backoffLimit, 0);
  assert.equal(prepared.job.spec.template.spec.automountServiceAccountToken, false);
  assert.ok(decode(data['deployment.json']).services.every((s) => !s.initialize));
  assert.ok(
    decode(data['bootstrap.json'])
      .services.filter((s) => s.kind === 'metadata')
      .every((s) => s.initialize),
  );
  assert.equal(f.calls.filter((c) => c.args[0] !== 'get').length, 0);
});

test('SSO environment whitespace matches native loading without requiring a storage class', async () => {
  const f = fixture();
  const target = readTarget(options, f.kubectl);
  target.environment.TIDB_SSO_CLIENT_ID += '\n';
  const prepared = await prepareCutover(target, options);
  assert.equal(prepared.pvc, undefined);
  assert.equal(decode(prepared.secret.data['api.json']).sso.clientId, 'public-client');
});

test('bootstrap polling stops on failure and does not wait for an impossible success', async () => {
  let polls = 0;
  let pauses = 0;
  await assert.rejects(
    waitForBootstrap(
      'job',
      'dev',
      () => JSON.stringify({ status: ++polls === 1 ? { active: 1 } : { failed: 1 } }),
      async () => {
        pauses++;
      },
    ),
    /bootstrap failed/,
  );
  assert.equal(polls, 2);
  assert.equal(pauses, 1);
});

test('failed bootstrap never switches the live Deployment or deletes storage', async () => {
  const f = fixture();
  await assert.rejects(
    cutover(
      options,
      (args, input) => {
        if (args[0] === 'get' && args[1] === 'job')
          return JSON.stringify({ status: { failed: 1 } });
        return f.kubectl(args, input);
      },
      healthy,
    ),
    /Native bootstrap not confirmed/,
  );
  assert.equal(f.calls.filter((c) => c.args[0] === 'create').length, 2);
  assert.ok(!f.calls.some((c) => ['patch', 'replace', 'delete', 'rollout'].includes(c.args[0])));
});

test('cutover verifies bootstrap before guarded switch and public auth denials', async () => {
  const f = fixture();
  const report = await cutover(options, f.kubectl, healthy);
  assert.equal(report.globalEnabled, true);
  assert.deepEqual(
    f.calls.filter((c) => c.args[0] !== 'get').map((c) => c.args[0]),
    ['create', 'create', 'patch', 'rollout'],
  );
  const patch = f.calls.find((c) => c.args[0] === 'patch');
  assert.equal(patch.input, undefined);
  assert.equal(patch.patch.metadata.resourceVersion, '7');
  assert.ok(!existsSync(patch.patchPath));
  assert.ok(!patch.args.some((arg) => arg.includes('private-subject')));
});

test('unsafe targets, repeated resets and concurrent Deployment changes fail closed', async () => {
  assert.throws(
    () => readTarget({ ...options, namespace: '../other' }, () => assert.fail()),
    /Invalid/,
  );
  const f = fixture();
  const target = readTarget(options, f.kubectl);
  target.api.security = {};
  await assert.rejects(prepareCutover(target, options), /Incomplete Global configuration/);
  let gets = 0;
  await assert.rejects(
    cutover(
      options,
      (args, input) => {
        if (args[0] === 'get' && args[1].startsWith('deployment')) {
          gets++;
          if (gets === 2)
            return JSON.stringify({ ...f.source, spec: { ...f.source.spec, replicas: 2 } });
        }
        return f.kubectl(args, input);
      },
      healthy,
    ),
    /changed during bootstrap/,
  );
  assert.ok(!f.calls.some((c) => c.args[0] === 'patch'));
  await assert.rejects(
    verifyGlobal(async () => Response.json({})),
    /verification failed/,
  );
});

test('authorized fresh reset replaces an existing Global profile and unmounts only its legacy security PVC', async () => {
  const f = fixture();
  const target = readTarget(options, f.kubectl);
  target.api.security = { clockDirectory: '/var/lib/workspace-security/checkpoints/region' };
  target.api.globalEntry = { apiOrigin: 'https://drive9.ai', apiPathPrefix: '/studio/api/global' };
  target.plan.services.push({ kind: 'global', configFile: '/run/workspace/global-api.json' });
  target.pod.volumes.push({
    name: 'global-security',
    persistentVolumeClaim: { claimName: 'old-clock' },
  });
  target.runtime.volumeMounts.push({
    name: 'global-security',
    mountPath: '/var/lib/workspace-security',
  });
  const prepared = await prepareCutover(target, options);
  const pod = prepared.patch.spec.template.spec;
  assert.ok(!pod.volumes.some((volume) => volume.name === 'global-security'));
  assert.ok(!pod.containers[0].volumeMounts.some((mount) => mount.name === 'global-security'));
  assert.ok(pod.volumes.some((volume) => volume.name === 'private'));
  assert.equal(decode(prepared.secret.data['api.json']).security.metadataSecurityState, true);
  assert.equal(
    decode(prepared.secret.data['deployment.json']).services.filter(
      (role) => role.kind === 'global',
    ).length,
    1,
  );
  assert.ok(!f.calls.some((call) => call.args[0] === 'delete'));
  target.runtime.volumeMounts.find((mount) => mount.name === 'global-security').mountPath =
    '/other';
  await assert.rejects(prepareCutover(target, options), /Unexpected legacy security volume/);
});

test('status-only Deployment updates retain a fresh guarded write and private patch files', async () => {
  const f = fixture();
  const kubectl = (args, input) => {
    if (args[0] === 'get' && args[1] === 'deployment/workspace')
      return JSON.stringify({
        ...f.source,
        metadata: { ...f.source.metadata, resourceVersion: '9' },
        status: { availableReplicas: 1 },
      });
    return f.kubectl(args, input);
  };
  await cutover(options, kubectl, healthy);
  assert.equal(f.calls.find((call) => call.patch).patch.metadata.resourceVersion, '9');
});

async function recoveryFixture() {
  const f = fixture();
  const prepared = await prepareCutover(readTarget(options, f.kubectl), options);
  const job = {
    ...prepared.job,
    status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
  };
  const candidates = [job];
  const kubectl = (args, input) => {
    if (args[0] === 'get') {
      if (args[1] === 'jobs') return JSON.stringify({ items: candidates });
      if (args[2] === prepared.name && args[1] === 'secret') return JSON.stringify(prepared.secret);
    }
    return f.kubectl(args, input);
  };
  return { ...f, prepared, job, candidates, kubectl };
}

test('completed candidate activation reuses its configuration and clocks without creating or initializing', async () => {
  const f = await recoveryFixture();
  const result = await cutover({ ...options, operation: 'activate-prepared' }, f.kubectl, healthy);
  assert.equal(result.globalEnabled, true);
  assert.deepEqual(
    f.calls.filter((c) => c.args[0] !== 'get').map((c) => c.args[0]),
    ['patch', 'rollout'],
  );
  assert.ok(
    !f.calls
      .find((c) => c.patch)
      .patch.spec.template.spec.volumes.some((volume) => volume.name === 'global-security'),
  );
});

test('recovery rejects incomplete/ambiguous candidates, mutable config and runtime/SSO/storage drift', async () => {
  const cases = [
    (f) => {
      f.job.status.conditions = [];
    },
    (f) => {
      f.candidates.push(structuredClone(f.job));
    },
    (f) => {
      f.prepared.secret.immutable = false;
    },
    (f) => {
      const api = decode(f.prepared.secret.data['api.json']);
      api.security.metadataSecurityState = false;
      f.prepared.secret.data['api.json'] = encode(api);
    },
    (f) => {
      f.job.spec.template.spec.containers[0].image = 'unreviewed';
    },
    (f) => {
      const api = decode(f.prepared.secret.data['api.json']);
      api.sso.clientId = 'different';
      f.prepared.secret.data['api.json'] = encode(api);
    },
    (f) => {
      const meta = decode(f.prepared.secret.data['region.json']);
      meta.s3.bucket = 'unrelated';
      f.prepared.secret.data['region.json'] = encode(meta);
    },
  ];
  for (const mutate of cases) {
    const f = await recoveryFixture();
    mutate(f);
    assert.throws(() => recoverPrepared(readTarget(options, f.kubectl), options, f.kubectl));
    assert.ok(!f.calls.some((c) => c.args[0] === 'patch' || c.args[0] === 'create'));
  }
});

test('HTTP health probes connect to the Pod with the configured public Host and preserve timings', () => {
  const f = fixture(),
    pod = structuredClone(f.source.spec.template.spec);
  pod.containers[0].readinessProbe = {
    httpGet: {
      path: '/api/health',
      port: 4318,
      httpHeaders: [
        { name: 'host', value: '127.0.0.1:4318' },
        { name: 'X-Other', value: 'private-header' },
      ],
    },
    periodSeconds: 7,
    timeoutSeconds: 3,
    failureThreshold: 4,
  };
  pod.containers[0].livenessProbe = {
    httpGet: { path: '/studio/api/health', port: 4318, host: 'localhost' },
    initialDelaySeconds: 30,
  };
  const before = structuredClone(pod);
  assert.equal(
    configureHealthProbes(pod, 'api', {
      publicOrigins: ['https://drive9.ai'],
      publicPath: '/studio',
    }),
    2,
  );
  assert.deepEqual(pod.containers[0].readinessProbe, {
    ...before.containers[0].readinessProbe,
    httpGet: {
      ...before.containers[0].readinessProbe.httpGet,
      httpHeaders: [
        { name: 'X-Other', value: 'private-header' },
        { name: 'Host', value: 'drive9.ai' },
      ],
    },
  });
  assert.equal(pod.containers[0].livenessProbe.httpGet.host, undefined);
  assert.equal(pod.containers[0].livenessProbe.initialDelaySeconds, 30);
  assert.ok(!JSON.stringify(probeSummary(pod.containers[0])).includes('private-header'));
});

test('active Global probe recovery preserves metadata, credentials, runtime and checkpoints without initialization', async () => {
  const f = await recoveryFixture();
  f.source.spec.template.spec = structuredClone(f.prepared.patch.spec.template.spec);
  f.source.spec.template.spec.containers[0].readinessProbe = {
    httpGet: {
      path: '/api/health',
      port: 4318,
      httpHeaders: [{ name: 'Host', value: 'localhost:4318' }],
    },
    periodSeconds: 5,
  };
  const prior = structuredClone(f.source.spec.template.spec);
  const result = await cutover({ ...options, operation: 'repair-probes' }, f.kubectl, healthy);
  assert.equal(result.globalEnabled, true);
  assert.deepEqual(
    f.calls.filter((c) => c.args[0] !== 'get').map((c) => c.args[0]),
    ['patch', 'rollout'],
  );
  const patched = f.calls.find((c) => c.patch).patch.spec.template.spec;
  const expected = structuredClone(prior);
  expected.containers[0].readinessProbe.httpGet.httpHeaders = [
    { name: 'Host', value: 'drive9.ai' },
  ];
  assert.deepEqual(patched, expected);
});

test('probe repair rejects non-Global profiles and unrelated HTTP targets without mutating', async () => {
  const f = fixture();
  await assert.rejects(
    cutover({ ...options, operation: 'repair-probes' }, f.kubectl, healthy),
    /already configured/,
  );
  const target = readTarget(options, f.kubectl);
  for (const httpGet of [
    { path: '/data', port: 4318 },
    { path: '/api/health', port: 4318, host: 'unrelated.example' },
    { path: '/api/health', port: 4318, scheme: 'HTTPS' },
  ]) {
    const pod = structuredClone(target.pod);
    pod.containers[0].readinessProbe = { httpGet };
    assert.throws(() => configureHealthProbes(pod, 'api', target.api), /Unsupported HTTP/);
  }
  assert.ok(!f.calls.some((c) => c.args[0] === 'patch'));
});

test('cloud cutover requires protected main-only same-commit CI and serializes against deployment', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/global-configure.yml', import.meta.url), 'utf8'),
  );
  assert.equal(workflow.jobs.configure.environment, 'dev');
  assert.equal(workflow.jobs.configure.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.configure.needs, 'verify');
  assert.equal(workflow.concurrency.group, 'dev-cd-deploy-target');
  assert.equal(workflow.on.pull_request, undefined);
  assert.ok(
    workflow.jobs.verify.steps.some(
      (s) => s.run === 'node scripts/require-ci.mjs full "$SOURCE_SHA"',
    ),
  );
});
