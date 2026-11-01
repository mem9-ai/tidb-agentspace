import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { cutover, prepareCutover, readTarget, verifyGlobal } from './cutover-global-cloud.mjs';

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
    metadata: { resourceVersion: '7' },
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
    calls.push({ args, input });
    if (args[0] === 'get') {
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

test('cloud preparation isolates roots and credentials, retains one callback and initializes persistent clocks before steady startup', async () => {
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
  assert.equal(pod.volumes.at(-1).persistentVolumeClaim.claimName, prepared.name);
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

test('failed bootstrap never switches the live Deployment or deletes storage', async () => {
  const f = fixture();
  await assert.rejects(
    cutover(
      options,
      (args, input) => {
        if (args[0] === 'wait') throw new Error('Initialization failed');
        return f.kubectl(args, input);
      },
      healthy,
    ),
    /Initialization failed/,
  );
  assert.equal(f.calls.filter((c) => c.args[0] === 'create').length, 3);
  assert.ok(!f.calls.some((c) => ['patch', 'replace', 'delete', 'rollout'].includes(c.args[0])));
});

test('cutover verifies bootstrap before guarded switch and public auth denials', async () => {
  const f = fixture();
  const report = await cutover(options, f.kubectl, healthy);
  assert.equal(report.globalEnabled, true);
  assert.deepEqual(
    f.calls.filter((c) => c.args[0] !== 'get').map((c) => c.args[0]),
    ['create', 'create', 'create', 'wait', 'patch', 'rollout'],
  );
  const patch = f.calls.find((c) => c.args[0] === 'patch');
  assert.ok(patch.args.includes('--patch-file=/dev/stdin'));
  assert.equal(JSON.parse(patch.input).metadata.resourceVersion, '7');
});

test('unsafe targets, repeated resets and concurrent Deployment changes fail closed', async () => {
  assert.throws(
    () => readTarget({ ...options, namespace: '../other' }, () => assert.fail()),
    /Invalid/,
  );
  const f = fixture();
  const target = readTarget(options, f.kubectl);
  target.api.security = {};
  await assert.rejects(prepareCutover(target, options), /already configured/);
  let gets = 0;
  await assert.rejects(
    cutover(
      options,
      (args, input) => {
        if (args[0] === 'get' && args[1].startsWith('deployment')) {
          gets++;
          if (gets === 2)
            return JSON.stringify({ ...f.source, metadata: { resourceVersion: '8' } });
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
