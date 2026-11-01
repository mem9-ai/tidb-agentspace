import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globalApiProfile } from './global-api-profile.mjs';

const label = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
const checkpointMount = '/var/lib/workspace-security';

// Resolve only the selected runtime's explicit references. Never enumerate unrelated Secrets.
export function readTarget({ namespace, deployment, container }, kubectl) {
  if (![namespace, deployment, container].every((v) => label.test(v || '')))
    throw new Error('Invalid deployment target.');
  const get = (kind, name) =>
    JSON.parse(kubectl(['get', kind, name, '-n', namespace, '-o', 'json']));
  const source = get('deployment', deployment);
  const pod = source.spec?.template?.spec;
  const runtime = pod?.containers?.find((c) => c.name === container);
  if (
    !source.metadata?.resourceVersion ||
    source.spec?.replicas !== 1 ||
    source.spec?.strategy?.type !== 'Recreate' ||
    pod.containers.length !== 1 ||
    !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(runtime?.image || '')
  )
    throw new Error('Expected one native container, Recreate replica and immutable image.');
  const cache = new Map();
  const object = (kind, name) => {
    const key = `${kind}/${name}`;
    if (!cache.has(key)) cache.set(key, get(kind, name));
    return cache.get(key);
  };
  const candidates = (pod.volumes || [])
    .filter((v) => v.secret?.secretName)
    .map((v) => ({ volume: v, secret: object('secret', v.secret.secretName) }))
    .filter((v) => v.secret.data?.['deployment.json'] && v.secret.data?.['api.json']);
  if (candidates.length !== 1) throw new Error('Expected one referenced native configuration.');
  const { volume, secret } = candidates[0];
  const plan = decode(secret.data['deployment.json']);
  const api = decode(secret.data['api.json']);
  const args = [
    ...(runtime.command || []),
    ...(runtime.args || ['serve', '--config', '/run/workspace/deployment.json']),
  ];
  const path = args[args.indexOf('--config') + 1];
  if (
    !args.includes('--config') ||
    path !== '/run/workspace/deployment.json' ||
    !runtime.volumeMounts?.some((m) => m.mountPath === dirname(path)) ||
    plan.format !== 1
  )
    throw new Error('Expected the private native deployment mount and plan.');
  const environment = {};
  for (const ref of runtime.envFrom || []) {
    const kind = ref.secretRef ? 'secret' : 'configmap';
    const name = ref.secretRef?.name || ref.configMapRef?.name;
    if (!name || ref.prefix) throw new Error('Unsupported environment reference.');
    for (const [key, value] of Object.entries(object(kind, name).data || {}))
      environment[key] = kind === 'secret' ? Buffer.from(value, 'base64').toString() : value;
  }
  for (const entry of runtime.env || []) {
    if (typeof entry.value === 'string') environment[entry.name] = entry.value;
    else {
      const ref = entry.valueFrom?.secretKeyRef || entry.valueFrom?.configMapKeyRef;
      if (!ref) continue; // Downward API fields are not SSO inputs.
      const kind = entry.valueFrom.secretKeyRef ? 'secret' : 'configmap';
      const value = object(kind, ref.name).data?.[ref.key];
      if (value === undefined) throw new Error('Referenced environment value missing.');
      environment[entry.name] = kind === 'secret' ? Buffer.from(value, 'base64').toString() : value;
    }
  }
  return { source, pod, runtime, volume, secret, plan, api, environment };
}

function hostedSso(api, env) {
  if (api.sso) return api.sso;
  const csv = (name) =>
    (env[name] || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  if (!env.TIDB_SSO_ISSUER || !env.TIDB_SSO_CLIENT_ID || !env.TIDB_SSO_REDIRECT_URI)
    throw new Error('Hosted SSO configuration is required.');
  return {
    issuer: env.TIDB_SSO_ISSUER,
    clientId: env.TIDB_SSO_CLIENT_ID,
    redirectUri: env.TIDB_SSO_REDIRECT_URI,
    scopes: env.TIDB_SSO_SCOPES || 'openid profile email',
    ownerSubjects: csv('TIDB_SSO_OWNER_SUBJECTS'),
    ownerEmailRules: csv('TIDB_SSO_OWNER_EMAIL_RULES'),
    allowedOrgs: csv('TIDB_SSO_ALLOWED_ORGS'),
    orgClaim: env.TIDB_SSO_ORG_CLAIM || 'org_id',
    ...(env.TIDB_SSO_POST_LOGIN_URL ? { postLoginUrl: env.TIDB_SSO_POST_LOGIN_URL } : {}),
    ...Object.fromEntries(
      [
        ['authorizeUrl', 'TIDB_SSO_AUTHORIZE_URL'],
        ['tokenUrl', 'TIDB_SSO_TOKEN_URL'],
        ['jwksUrl', 'TIDB_SSO_JWKS_URL'],
      ]
        .filter(([, name]) => env[name])
        .map(([key, name]) => [key, env[name]]),
    ),
    allowLoopbackHttp: false,
  };
}

// This reset is explicit: new roots and credentials, never delete a bucket or old Secret.
// Bootstrap completes and releases ownership before the existing Deployment is changed.
export async function prepareCutover(target, { namespace, deployment, container }) {
  const { api, plan, secret, volume, pod, runtime, environment } = target;
  if (api.security || api.globalEntry || plan.services.some((s) => s.kind === 'global'))
    throw new Error('Global already configured; do not rotate identities or reset storage again.');
  if (
    plan.services.length !== 3 ||
    plan.services.filter((s) => s.kind === 'workspace').length !== 1 ||
    plan.services.filter((s) => s.kind === 'metadata').length !== 2 ||
    api.publicPath !== '/studio' ||
    api.publicOrigins?.[0] !== 'https://drive9.ai' ||
    api.metadata?.transport !== 'inProcess' ||
    runtime.volumeMounts.some((m) => m.mountPath.startsWith(checkpointMount)) ||
    (pod.securityContext?.fsGroup !== undefined && pod.securityContext.fsGroup !== 1000)
  )
    throw new Error('Unsupported cloud composition; inspect without modifying it.');
  const id = randomUUID();
  const name = `${deployment.slice(0, 32)}-global-${id.slice(0, 12)}`;
  const mount = '/run/workspace';
  const data = { ...secret.data };
  const authorities = [];
  for (const role of plan.services.filter((s) => s.kind === 'metadata')) {
    if (dirname(role.configFile) !== mount) throw new Error('Unexpected metadata path.');
    const key = basename(role.configFile);
    const meta = decode(data[key]);
    if (!['global', api.authorityId].includes(meta.authorityId) || !meta.s3?.prefix)
      throw new Error('Unexpected metadata authority or storage root.');
    authorities.push(meta.authorityId);
    for (const file of [meta.tokenFile, meta.encryptionKeyFile]) {
      if (dirname(file) !== mount) throw new Error('Unexpected metadata credential path.');
      data[basename(file)] = Buffer.from(randomBytes(32).toString('hex')).toString('base64');
    }
    data[key] = encode({
      ...meta,
      installationId: `${meta.authorityId.replaceAll(':', '-')}-${id}`,
      encryptionKeyId: `${meta.authorityId.replaceAll(':', '-')}-${id}`,
      s3: { ...meta.s3, prefix: `${meta.s3.prefix}-global-${id}` },
    });
  }
  if (new Set(authorities).size !== 2) throw new Error('Independent Meta authorities required.');
  const temporary = await mkdtemp(resolve(tmpdir(), 'workspace-global-'));
  try {
    const profile = await globalApiProfile({
      directory: resolve(temporary, 'security'),
      mountDirectory: mount,
      api: { ...api, sso: hostedSso(api, environment), initializeWorkspace: false },
      clockDirectory: `${checkpointMount}/checkpoints`,
    });
    // CA signing key and CSRs are not runtime credentials and never enter the cluster.
    for (const file of await readdir(resolve(temporary, 'security'))) {
      if (file === 'control-ca.key' || /\.(csr|ext|srl)$/.test(file)) continue;
      data[file] = (await readFile(resolve(temporary, 'security', file))).toString('base64');
    }
    data['api.json'] = encode(profile.api);
    data['api-bootstrap.json'] = encode({
      ...profile.api,
      initializeWorkspace: true,
      security: { ...profile.api.security, initializeClock: true },
    });
    data['global-api.json'] = encode(profile.global);
    data['global-api-bootstrap.json'] = encode({ ...profile.global, initializeClock: true });
    const services = [
      ...plan.services.map((s) => {
        const { initialize: _initialize, recoverOwner: _owner, ...steady } = s;
        return steady;
      }),
      { kind: 'global', configFile: `${mount}/global-api.json` },
    ];
    data['deployment.json'] = encode({ format: 1, services });
    data['bootstrap.json'] = encode({
      format: 1,
      services: services.map((s) =>
        s.kind === 'metadata'
          ? { ...s, initialize: true }
          : {
              ...s,
              configFile: `${mount}/${s.kind === 'global' ? 'global-api' : 'api'}-bootstrap.json`,
            },
      ),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const newPod = structuredClone(pod);
  const projection = newPod.volumes.find((v) => v.name === volume.name);
  projection.secret = { ...projection.secret, secretName: name };
  delete projection.secret.items; // The private-copy init container needs every new identity file.
  newPod.volumes.push({ name: 'global-security', persistentVolumeClaim: { claimName: name } });
  newPod.securityContext = { ...newPod.securityContext, fsGroup: 1000 };
  const next = newPod.containers.find((c) => c.name === container);
  next.volumeMounts.push({ name: 'global-security', mountPath: checkpointMount });
  const bootstrap = structuredClone(newPod);
  bootstrap.restartPolicy = 'Never';
  const init = bootstrap.containers[0];
  init.command = ['workspace-backend'];
  init.args = ['initialize', '--config', `${mount}/bootstrap.json`];
  for (const key of ['readinessProbe', 'livenessProbe', 'startupProbe', 'ports', 'lifecycle'])
    delete init[key];
  return {
    name,
    secret: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace },
      immutable: true,
      type: 'Opaque',
      data,
    },
    pvc: {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name, namespace },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
    },
    job: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace },
      spec: { backoffLimit: 0, activeDeadlineSeconds: 300, template: { spec: bootstrap } },
    },
    patch: {
      metadata: { resourceVersion: target.source.metadata.resourceVersion },
      spec: {
        template: {
          metadata: { annotations: { 'workspace.tidb.ai/global-cutover': id } },
          spec: newPod,
        },
      },
    },
  };
}

export async function verifyGlobal(request = fetch) {
  const base = 'https://drive9.ai/studio';
  const get = (path) =>
    request(base + path, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  const health = await get('/api/health');
  const global = await get('/api/global/api/health');
  const auth = await get('/api/auth/config');
  const info = await auth.json();
  if (
    !health.ok ||
    !global.ok ||
    !auth.ok ||
    info.globalApi?.apiPathPrefix !== '/studio/api/global'
  )
    throw new Error('Global discovery or regional health verification failed.');
  for (const path of ['/api/v1/workspaces', '/api/global/api/v1/workspaces/ws_agentlab/keys']) {
    if ((await get(path)).status !== 401)
      throw new Error('Unauthenticated API access was not denied.');
  }
}

export async function cutover(options, kubectl, request = fetch, report = () => {}) {
  const target = readTarget(options, kubectl);
  if (options.operation === 'inspect') {
    return {
      globalConfigured: !!target.api.security,
      privateMount: target.runtime.volumeMounts.map((m) => ({ path: m.mountPath, name: m.name })),
      initializationContainers: (target.pod.initContainers || []).map((c) => ({
        name: c.name,
        mounts: c.volumeMounts,
      })),
      storage: target.pod.volumes.map((v) => ({
        name: v.name,
        persistent: !!v.persistentVolumeClaim,
        secret: !!v.secret,
        memory: v.emptyDir?.medium === 'Memory',
      })),
      ssoConfigured: !!(target.api.sso || target.environment.TIDB_SSO_CLIENT_ID),
    };
  }
  if (options.operation !== 'reset-and-enable-global')
    throw new Error('Explicit reset operation required.');
  const prepared = await prepareCutover(target, options);
  const { namespace, deployment } = options;
  const create = (object) =>
    kubectl(['create', '-f', '-', '-n', namespace, '-o', 'name'], JSON.stringify(object));
  create(prepared.secret);
  create(prepared.pvc);
  report('Private configuration and checkpoint PVC created. Starting one-time native bootstrap.');
  create(prepared.job);
  // A failed/uncertain bootstrap never changes the running Deployment or retries an initialization.
  kubectl([
    'wait',
    `job/${prepared.name}`,
    '-n',
    namespace,
    '--for=condition=complete',
    '--timeout=330s',
  ]);
  report(
    'Native bootstrap completed and released ownership. Checking the Deployment precondition.',
  );
  const current = JSON.parse(
    kubectl(['get', `deployment/${deployment}`, '-n', namespace, '-o', 'json']),
  );
  if (current.metadata?.resourceVersion !== target.source.metadata.resourceVersion)
    throw new Error('Deployment changed during bootstrap; inspect before switching configuration.');
  kubectl(
    [
      'patch',
      `deployment/${deployment}`,
      '-n',
      namespace,
      '--type=merge',
      '--patch-file=/dev/stdin',
      '-o',
      'name',
    ],
    JSON.stringify(prepared.patch),
  );
  report('Configuration switched. Waiting for readiness and public API verification.');
  kubectl(['rollout', 'status', `deployment/${deployment}`, '-n', namespace, '--timeout=300s']);
  await verifyGlobal(request);
  return {
    globalEnabled: true,
    checkpointPersistent: true,
    bootstrapComplete: true,
    priorConfigurationRetained: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await cutover(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
        operation: process.env.CUTOVER_OPERATION,
      },
      (args, input) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          input,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 350000,
        }),
      fetch,
      (message) => console.log(message),
    );
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error(
      'Global cutover not confirmed. Inspect the protected target and bootstrap status; never repeat initialization or expose private configuration.',
    );
    process.exitCode = 1;
  }
}
