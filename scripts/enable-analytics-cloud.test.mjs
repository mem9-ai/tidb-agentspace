import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { digest, managedBy, prepareAnalytics } from './analytics-cloud-profile.mjs';
import { readTarget } from './cutover-global-cloud.mjs';
import { enableAnalytics, waitForInitialization } from './enable-analytics-cloud.mjs';

const options = {
  namespace: 'dev',
  deployment: 'studio',
  container: 'api',
  cluster: 'test-cluster',
  operation: 'enable-analytics',
};
const identity = {
  account: '123456789012',
  issuer: 'https://oidc.eks.us-west-2.amazonaws.com/id/TESTCLUSTER',
};
const encode = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const decode = (v) => JSON.parse(Buffer.from(v, 'base64').toString());
const text = (v) => Buffer.from(v, 'base64').toString();
const missing = (message) => Object.assign(new Error('Command failed'), { stderr: message });
const fakeCertificates = async (host) =>
  Object.fromEntries(
    ['ca.crt', 'server.crt', 'server.key', 'client.crt', 'client.key'].map((file) => [
      file,
      `${host}-${file}`,
    ]),
  );

function fixture() {
  const image = 'registry.example/studio@sha256:' + 'a'.repeat(64);
  const api = {
    bind: '0.0.0.0:4318',
    authorityId: 'region:studio-dev',
    publicPath: '/studio',
    publicOrigins: ['https://drive9.ai'],
    security: { metadataSecurityState: true, initializeClock: false },
    globalEntry: { apiOrigin: 'https://drive9.ai', apiPathPrefix: '/studio/api/global' },
  };
  const data = {
    'api.json': encode(api),
    'global-api.json': encode({
      regions: [{ regionId: api.authorityId }],
      signingKeyFile: '/run/workspace/signing-key',
    }),
    'signing-key': encode('private-signing-canary'),
  };
  const services = ['global', 'region'].map((kind) => ({
    kind: 'metadata',
    configFile: `/run/workspace/${kind}.json`,
  }));
  for (const kind of ['global', 'region']) {
    data[`${kind}.json`] = encode({
      authorityId: kind === 'global' ? 'global' : api.authorityId,
      s3: {
        endpoint: 'https://s3.us-west-2.amazonaws.com',
        region: 'us-west-2',
        bucket: 'main-meta-private',
        prefix: `customer-meta/${kind}`,
        accessKeyId: 'meta-access-canary',
        secretAccessKey: 'meta-secret-canary',
      },
    });
    data[`${kind}-key`] = encode('meta-encryption-canary-' + kind);
  }
  services.push(
    { kind: 'workspace', configFile: '/run/workspace/api.json' },
    { kind: 'global', configFile: '/run/workspace/global-api.json' },
  );
  data['deployment.json'] = encode({ format: 1, services });
  const source = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { uid: 'test-deployment-uid', resourceVersion: '8', name: 'studio' },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      template: {
        spec: {
          containers: [
            {
              name: 'api',
              image,
              args: ['serve', '--config', '/run/workspace/deployment.json'],
              volumeMounts: [{ name: 'private', mountPath: '/run/workspace' }],
            },
          ],
          initContainers: [
            {
              name: 'copy',
              image,
              volumeMounts: [
                { name: 'projected', mountPath: '/projected' },
                { name: 'private', mountPath: '/run/workspace' },
              ],
            },
          ],
          volumes: [
            {
              name: 'projected',
              secret: { secretName: 'original', items: [{ key: 'api.json', path: 'api.json' }] },
            },
            { name: 'private', emptyDir: { medium: 'Memory' } },
          ],
        },
      },
    },
  };
  const original = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'original' },
    immutable: true,
    data,
  };
  const objects = new Map([
    ['deployment/studio', source],
    ['secret/original', original],
  ]);
  const roles = new Map(),
    buckets = new Map(),
    events = [];
  let failJob = false,
    denyRole = false,
    drift = false;
  const kubectl = (args, input) => {
    if (args[0] === 'get') {
      const key = args[1].includes('/') ? args[1] : `${args[1]}/${args[2]}`;
      const object = objects.get(key);
      if (!object) throw missing('(NotFound)');
      if (key.startsWith('job/'))
        object.status = failJob
          ? { failed: 1 }
          : { conditions: [{ type: 'Complete', status: 'True' }] };
      if (
        drift &&
        key === 'deployment/studio' &&
        [...objects.keys()].filter((k) => k.startsWith('deployment/analytics-')).length === 2
      )
        object.spec.replicas = 2;
      return JSON.stringify(object);
    }
    events.push({ kind: 'kube', args });
    if (args[0] === 'create') {
      const object = JSON.parse(input);
      const key = `${object.kind.toLowerCase()}/${object.metadata.name}`;
      assert.ok(!objects.has(key));
      if (object.kind === 'Deployment') object.status = { availableReplicas: 1 };
      objects.set(key, object);
    } else if (args[0] === 'patch') {
      const patch = JSON.parse(
        readFileSync(args.find((a) => a.startsWith('--patch-file=')).slice('--patch-file='.length)),
      );
      assert.equal(patch.metadata.resourceVersion, source.metadata.resourceVersion);
      source.spec.template.spec = patch.spec.template.spec;
    }
    return '';
  };
  const aws = (args) => {
    events.push({ kind: 'aws', args });
    const value = (key) => args[args.indexOf(key) + 1];
    if (args[0] === 'sts') return JSON.stringify({ Account: identity.account });
    if (args[0] === 'eks')
      return JSON.stringify({ cluster: { identity: { oidc: { issuer: identity.issuer } } } });
    if (args[0] === 'iam') {
      if (denyRole) throw missing('AccessDenied private-credential-canary');
      const name = value('--role-name');
      const role = roles.get(name);
      switch (args[1]) {
        case 'get-open-id-connect-provider':
          return JSON.stringify({ ClientIDList: ['sts.amazonaws.com'] });
        case 'get-role':
          if (!role) throw missing('NoSuchEntity');
          return JSON.stringify({ Role: role });
        case 'create-role': {
          const document = JSON.parse(
            readFileSync(value('--assume-role-policy-document').slice(7)),
          );
          const tags = args.slice(args.indexOf('--tags') + 1, args.indexOf('--output')).map((v) => {
            const [Key, Value] = v.replace('Key=', '').split(',Value=');
            return { Key, Value };
          });
          roles.set(name, {
            Arn: `arn:aws:iam::${identity.account}:role/${name}`,
            AssumeRolePolicyDocument: document,
            Tags: tags,
          });
          return '{}';
        }
        case 'put-role-policy':
          role.policy = JSON.parse(readFileSync(value('--policy-document').slice(7)));
          return '{}';
        case 'list-attached-role-policies':
          return JSON.stringify({ AttachedPolicies: [] });
        case 'list-role-policies':
          return JSON.stringify({ PolicyNames: role.policy ? ['analytics-storage'] : [] });
        case 'get-role-policy':
          return JSON.stringify({ PolicyDocument: role.policy });
        default:
          assert.fail('Unexpected IAM operation');
      }
    }
    if (args[0] === 's3api') {
      const bucket = value('--bucket');
      switch (args[1]) {
        case 'get-bucket-tagging':
          if (!buckets.has(bucket)) throw missing('NoSuchBucket');
          return JSON.stringify({ TagSet: buckets.get(bucket) });
        case 'create-bucket':
          buckets.set(bucket, []);
          return '{}';
        case 'put-bucket-tagging':
          buckets.set(bucket, JSON.parse(value('--tagging')).TagSet);
          return '{}';
        case 'put-public-access-block':
        case 'put-bucket-encryption':
          return '{}';
        default:
          assert.fail('Unexpected S3 operation');
      }
    }
    assert.fail('Unexpected AWS operation');
  };
  const request = async (url) => {
    if (url.endsWith('/api/auth/config'))
      return Response.json({ globalApi: { apiPathPrefix: '/studio/api/global' } });
    if (url.endsWith('/analytics/config')) return Response.json({ enabled: true });
    if (url.endsWith('/api/v1/workspaces') || url.endsWith('/keys') || url.includes('/operator/'))
      return Response.json({}, { status: 401 });
    return Response.json({ status: 'ok' });
  };
  const dependencies = {
    kubectl,
    aws,
    request,
    prepare: (t, o, i) => prepareAnalytics(t, o, i, fakeCertificates),
  };
  return {
    source,
    original,
    objects,
    roles,
    buckets,
    events,
    dependencies,
    failJob: () => {
      failJob = true;
    },
    denyRole: () => {
      denyRole = true;
    },
    drift: () => {
      drift = true;
    },
  };
}

test('private profiles isolate Global and Region, preserve business bytes and use valid dedicated TLS identities', async () => {
  const f = fixture();
  const prior = structuredClone(f.original.data);
  const prepared = await prepareAnalytics(
    readTarget(options, f.dependencies.kubectl),
    options,
    identity,
  );
  assert.deepEqual(f.original.data, prior);
  assert.equal(prepared.entries.length, 2);
  assert.notEqual(prepared.entries[0].bucket, prepared.entries[1].bucket);
  for (const entry of prepared.entries) {
    const config = decode(entry.secret.data['config.json']);
    assert.equal(config.authorityId, entry.authority);
    assert.notEqual(config.s3.bucket, 'main-meta-private');
    assert.equal(config.s3.accessKeyId, undefined);
    const contents = Object.fromEntries(
      Object.entries(entry.secret.data).map(([k, v]) => [k, text(v)]),
    );
    assert.ok(!JSON.stringify(contents).includes('meta-secret-canary'));
    assert.ok(!JSON.stringify(contents).includes('private-signing-canary'));
    assert.equal(entry.deployment.spec.replicas, 1);
    assert.equal(entry.deployment.spec.strategy.type, 'Recreate');
    assert.deepEqual(
      decode(entry.secret.data['deployment.json']).services.map((s) => s.kind),
      ['analytics'],
    );
    const server = new X509Certificate(contents['server.crt']),
      ca = new X509Certificate(contents['ca.crt']);
    assert.ok(server.verify(ca.publicKey));
    assert.equal(server.checkHost(`${entry.name}.dev.svc`), `${entry.name}.dev.svc`);
    assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']);
    const privateKey = createPrivateKey(contents['server.key']);
    assert.deepEqual(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }),
      server.publicKey.export({ format: 'der', type: 'spki' }),
    );
    const producerKind = entry.authority === 'global' ? 'global' : 'region';
    const client = new X509Certificate(
      text(prepared.apiSecret.data[`analytics-${producerKind}-client.crt`]),
    );
    assert.ok(client.verify(ca.publicKey));
    assert.deepEqual(client.keyUsage, ['1.3.6.1.5.5.7.3.2']);
    for (const secret of ['encryption-key', 'pseudonym-key', 'server.key'])
      assert.ok(!Object.values(prepared.apiSecret.data).includes(entry.secret.data[secret]));
    assert.ok(!JSON.stringify(entry.policy).includes('main-meta-private'));
    assert.equal(
      entry.trust.Statement[0].Condition.StringEquals[`${identity.issuer.slice(8)}:sub`],
      `system:serviceaccount:dev:${entry.name}`,
    );
  }
  for (const key of [
    'global.json',
    'region.json',
    'global-key',
    'region-key',
    'signing-key',
    'deployment.json',
  ])
    assert.equal(prepared.apiSecret.data[key], prior[key]);
  assert.deepEqual(decode(prepared.apiSecret.data['admin-policy.json']), {
    subjects: [],
    verifiedEmailDomains: ['pingcap.com'],
  });
});

test('activation waits for both independent initializers and readiness, then only switches private configuration', async () => {
  const f = fixture(),
    prior = structuredClone(f.source.spec);
  const result = await enableAnalytics(options, f.dependencies);
  assert.equal(result.analyticsEnabled, true);
  assert.equal(result.realAccountLoginVerified, false);
  const patchIndex = f.events.findIndex((e) => e.args[0] === 'patch');
  const ready = f.events.slice(0, patchIndex).filter((e) => e.args[0] === 'rollout');
  assert.equal(ready.length, 2);
  const expected = structuredClone(prior);
  expected.template.spec.volumes[0].secret.secretName =
    f.source.spec.template.spec.volumes[0].secret.secretName;
  delete expected.template.spec.volumes[0].secret.items;
  assert.deepEqual(f.source.spec, expected);
  const creates = f.events.filter((e) => e.args[0] === 'create').length;
  const patches = f.events.filter((e) => e.args[0] === 'patch').length;
  for (const [key, object] of f.objects)
    if (key.startsWith('deployment/analytics-'))
      object.spec.template.spec.dnsPolicy = 'ClusterFirst';
  await enableAnalytics(options, f.dependencies);
  assert.equal(f.events.filter((e) => e.args[0] === 'create').length, creates);
  assert.equal(f.events.filter((e) => e.args[0] === 'patch').length, patches);
  assert.equal(f.roles.size, 2);
  assert.equal(f.buckets.size, 2);
  const writes = f.events.length;
  await enableAnalytics({ ...options, operation: 'restart-analytics' }, f.dependencies);
  const restartEvents = f.events.slice(writes);
  assert.equal(
    restartEvents.filter((e) => e.args[0] === 'rollout' && e.args[1] === 'restart').length,
    2,
  );
  assert.ok(!restartEvents.some((e) => ['create', 'patch'].includes(e.args[0])));
});

test('permission denial, failed initialization and concurrent target changes never activate the business config', async () => {
  for (const failure of ['denyRole', 'failJob', 'drift']) {
    const f = fixture();
    f[failure]();
    await assert.rejects(enableAnalytics(options, f.dependencies));
    assert.ok(!f.events.some((e) => e.args[0] === 'patch'));
    assert.equal(f.source.spec.template.spec.volumes[0].secret.secretName, 'original');
    assert.ok(!f.events.some((e) => ['delete', 'reset'].includes(e.args[0])));
  }
});

test('resume preserves prepared credentials and rejects broadened IAM policies or extra runtime containers', async () => {
  const f = fixture();
  await enableAnalytics(options, f.dependencies);
  const state = [...f.objects.values()].find((o) =>
    o.metadata?.name?.startsWith('analytics-state-'),
  );
  const before = digest(state.data);
  const role = [...f.roles.values()][0];
  role.policy.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*' });
  await assert.rejects(enableAnalytics(options, f.dependencies), /storage boundary/);
  role.policy.Statement.pop();
  const deployment = [...f.objects.values()].find(
    (o) => o.kind === 'Deployment' && o.metadata.name.startsWith('analytics-'),
  );
  deployment.spec.template.spec.containers.push({ name: 'unexpected', image: 'unreviewed' });
  await assert.rejects(enableAnalytics(options, f.dependencies), /Deployment differs/);
  assert.equal(digest(state.data), before);
});

test('inspection is read-only and emits no private configuration, and failed Jobs are not retried', async () => {
  const f = fixture();
  const report = await enableAnalytics(
    { ...options, operation: 'inspect-analytics' },
    f.dependencies,
  );
  assert.equal(report.analyticsPrepared, false);
  assert.ok(!JSON.stringify(report).includes('canary'));
  assert.equal(f.events.length, 0);
  let calls = 0;
  await assert.rejects(
    waitForInitialization('job', () => {
      calls++;
      return { status: { failed: 1 } };
    }),
    /initialization failed/,
  );
  assert.equal(calls, 1);
});

test('analytics enablement retains protected main-only exact-commit gates and deployment serialization', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/global-configure.yml', import.meta.url), 'utf8'),
  );
  assert.equal(workflow.concurrency.group, 'dev-cd-deploy-target');
  assert.equal(workflow.jobs.configure.environment, 'dev');
  assert.equal(workflow.jobs.configure.needs, 'verify');
  assert.ok(
    workflow.jobs.verify.steps.some(
      (s) => s.run === 'node scripts/require-ci.mjs full "$SOURCE_SHA"',
    ),
  );
  assert.ok(workflow.on.workflow_dispatch.inputs.operation.options.includes('enable-analytics'));
  assert.ok(
    workflow.jobs.configure.steps
      .find((s) => s.run === 'node scripts/enable-analytics-cloud.mjs')
      .if.includes('enable-analytics'),
  );
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(managedBy, 'studio-product-analytics');
});
