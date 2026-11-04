import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readTarget, verifyGlobal } from './cutover-global-cloud.mjs';
import {
  AnalyticsCloudError,
  digest,
  managedBy,
  prepareAnalytics,
} from './analytics-cloud-profile.mjs';

const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString());
const absent = (error) => /\(NotFound\)/.test(String(error.stderr || ''));
function optional(read) {
  try {
    return read();
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}
function managed(object, owner) {
  if (
    object.metadata?.labels?.['app.kubernetes.io/managed-by'] !== managedBy ||
    object.metadata?.labels?.['workspace.tidb.ai/analytics-owner'] !== owner
  )
    throw new AnalyticsCloudError('Existing analytics resource has different ownership.');
}
// Use the existing cluster storage provider. No bucket, IAM or cloud identity operations.
export function clusterStorage(kubectl) {
  const classes = JSON.parse(kubectl(['get', 'storageclass', '-o', 'json'])).items || [];
  const defaults = classes.filter(
    (entry) =>
      entry.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
  );
  if (defaults.length !== 1)
    throw new AnalyticsCloudError(
      'Exactly one existing default cluster storage class is required.',
    );
  return defaults[0].metadata.name;
}

// API-server defaults may add fields, but every supplied field and complete list must
// match. Refuse added containers/env/volumes, privilege changes and host namespaces.
function matchesManifest(actual, desired) {
  if (Array.isArray(desired))
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((v, i) => matchesManifest(actual[i], v))
    );
  if (desired && typeof desired === 'object')
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(desired).every(([k, v]) => matchesManifest(actual[k], v))
    );
  return actual === desired;
}

function resourceReader(namespace, kubectl) {
  return (kind, name) => JSON.parse(kubectl(['get', kind, name, '-n', namespace, '-o', 'json']));
}
function ensureResource(object, owner, get, kubectl, namespace) {
  const existing = optional(() => get(object.kind.toLowerCase(), object.metadata.name));
  if (!existing) {
    kubectl(['create', '-f', '-', '-n', namespace, '-o', 'name'], JSON.stringify(object));
    return;
  }
  managed(existing, owner);
  if (
    object.kind === 'Secret' &&
    (existing.immutable !== true || !isDeepStrictEqual(existing.data, object.data))
  )
    throw new AnalyticsCloudError('Existing private analytics configuration differs.');
  if (
    object.kind === 'Deployment' &&
    (!matchesManifest(existing.spec.template.spec, object.spec.template.spec) ||
      ['hostNetwork', 'hostPID', 'hostIPC'].some((k) => existing.spec.template.spec[k] === true) ||
      existing.spec.replicas !== 1 ||
      existing.spec.strategy?.type !== 'Recreate')
  )
    throw new AnalyticsCloudError(
      'Existing analytics Deployment differs; inspect before updating.',
    );
  if (
    object.kind === 'Service' &&
    (!isDeepStrictEqual(existing.spec.selector, object.spec.selector) ||
      existing.spec.ports?.length !== 1 ||
      existing.spec.ports[0].port !== 7446 ||
      existing.spec.ports[0].targetPort !== 7446)
  )
    throw new AnalyticsCloudError('Existing analytics Service differs.');
  if (object.kind === 'PersistentVolumeClaim' && !matchesManifest(existing.spec, object.spec))
    throw new AnalyticsCloudError('Existing analytics volume differs from its prepared storage.');
  if (object.kind === 'ServiceAccount' && existing.automountServiceAccountToken !== false)
    throw new AnalyticsCloudError('Unexpected analytics service-account permissions.');
}

export async function waitForInitialization(name, get, pause = delay, now = Date.now) {
  const deadline = now() + 210_000;
  while (now() < deadline) {
    const job = get('job', name);
    if (
      job.status?.conditions?.some((c) => c.type === 'Complete' && c.status === 'True') &&
      !job.status.active &&
      !job.status.failed
    )
      return;
    if (
      job.status?.failed ||
      job.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True')
    )
      throw new AnalyticsCloudError(
        'Analytics initialization failed; retain configuration and inspect, never repeat uncertain initialization.',
      );
    await pause(2000);
  }
  throw new AnalyticsCloudError(
    'Analytics initialization outcome is uncertain; retain existing Job and inspect.',
  );
}

async function switchConfiguration(target, prepared, options, kubectl) {
  const { namespace, deployment } = options;
  const get = resourceReader(namespace, kubectl);
  const current = get('deployment', deployment);
  if (
    current.metadata.uid !== target.source.metadata.uid ||
    !isDeepStrictEqual(current.spec, target.source.spec)
  )
    throw new AnalyticsCloudError('Business Deployment changed during analytics preparation.');
  const pod = structuredClone(target.pod);
  const sourceVolume = pod.volumes.find((v) => v.name === target.volume.name);
  sourceVolume.secret.secretName = prepared.apiSecret.metadata.name;
  delete sourceVolume.secret.items;
  const patch = {
    metadata: { resourceVersion: current.metadata.resourceVersion },
    spec: {
      template: {
        metadata: { annotations: { 'workspace.tidb.ai/analytics': prepared.owner } },
        spec: pod,
      },
    },
  };
  const temporary = await mkdtemp(join(tmpdir(), 'analytics-activate-'));
  try {
    const path = join(temporary, 'patch.json');
    await writeFile(path, JSON.stringify(patch), { mode: 0o600 });
    kubectl([
      'patch',
      `deployment/${deployment}`,
      '-n',
      namespace,
      '--type=merge',
      `--patch-file=${path}`,
      '-o',
      'name',
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  kubectl(['rollout', 'status', `deployment/${deployment}`, '-n', namespace, '--timeout=300s']);
}

export async function verifyAnalyticsPublic(request = fetch) {
  await verifyGlobal(request);
  const base = 'https://drive9.ai/studio/api/global';
  for (const path of ['/operator/session', '/operator/analytics/summary']) {
    const response = await request(base + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 401)
      throw new AnalyticsCloudError(
        'Admin must deny unauthenticated access with a sign-in response.',
      );
  }
  const response = await request(base + '/analytics/config', {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || (await response.json()).enabled !== true)
    throw new AnalyticsCloudError('Public product capture is not enabled.');
}

// Explicit operator action. New analytics resources are prepared/initialized before the
// business config changes. Source metadata, SSO, provider bindings and image are preserved.
export async function enableAnalytics(
  options,
  { kubectl, request = fetch, pause = delay, report = () => {}, prepare = prepareAnalytics },
) {
  const target = readTarget(options, kubectl);
  const { namespace, deployment } = options;
  const get = resourceReader(namespace, kubectl);
  const expectedOwner = digest({ namespace, deployment, uid: target.source.metadata.uid }).slice(
    0,
    12,
  );
  const stateName = `analytics-volume-state-${expectedOwner}`;
  const state = optional(() => get('secret', stateName));
  if (options.operation === 'inspect-analytics') {
    return {
      globalConfigured: Boolean(target.api.security),
      storageClass: clusterStorage(kubectl),
      analyticsPrepared: Boolean(state),
      regionalCapture: target.api.analytics?.enabled === true,
      globalCapture: target.plan.services.some(
        (s) =>
          s.kind === 'global' &&
          decode(target.secret.data[s.configFile.split('/').at(-1)]).analytics?.browserEnabled ===
            true,
      ),
      immutableImage: /@sha256:[a-f0-9]{64}$/.test(target.runtime.image),
    };
  }
  if (!['enable-analytics', 'verify-analytics', 'restart-analytics'].includes(options.operation))
    throw new AnalyticsCloudError('Explicit analytics operator action required.');
  let prepared;
  if (state) {
    managed(state, expectedOwner);
    if (state.immutable !== true)
      throw new AnalyticsCloudError('Analytics preparation state must be immutable.');
    prepared = decode(state.data['prepared.json']);
    if (
      prepared.format !== 2 ||
      prepared.sourceUid !== target.source.metadata.uid ||
      prepared.image !== target.runtime.image ||
      prepared.owner !== expectedOwner
    )
      throw new AnalyticsCloudError('Prepared analytics state does not match the target runtime.');
  } else {
    if (options.operation !== 'enable-analytics')
      throw new AnalyticsCloudError('Analytics has not been prepared.');
    prepared = await prepare(target, options, clusterStorage(kubectl));
    const record = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: stateName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': managedBy,
          'workspace.tidb.ai/analytics-owner': prepared.owner,
        },
      },
      immutable: true,
      type: 'Opaque',
      data: { 'prepared.json': Buffer.from(JSON.stringify(prepared)).toString('base64') },
    };
    kubectl(['create', '-f', '-', '-n', namespace, '-o', 'name'], JSON.stringify(record));
    report('Private analytics preparation retained. No business configuration changed.');
  }
  const enabled = target.secret.metadata.name === prepared.apiSecret.metadata.name;
  if (
    enabled
      ? !isDeepStrictEqual(target.secret.data, prepared.apiSecret.data)
      : target.secret.metadata.name !== prepared.sourceSecret ||
        digest(target.secret.data) !== prepared.sourceHash
  )
    throw new AnalyticsCloudError(
      'Business configuration differs from the retained analytics preparation.',
    );
  if (options.operation !== 'enable-analytics' && !enabled)
    throw new AnalyticsCloudError('Prepared analytics configuration is not active.');
  if (options.operation === 'enable-analytics') {
    for (const entry of prepared.entries) {
      for (const object of [entry.volume, entry.account, entry.secret, entry.service])
        ensureResource(object, prepared.owner, get, kubectl, namespace);
      if (!enabled) {
        const job = optional(() => get('job', entry.job.metadata.name));
        if (job) {
          managed(job, prepared.owner);
          if (!matchesManifest(job.spec.template.spec, entry.job.spec.template.spec))
            throw new AnalyticsCloudError(
              'Existing analytics initializer differs from the retained preparation.',
            );
        } else ensureResource(entry.job, prepared.owner, get, kubectl, namespace);
        await waitForInitialization(entry.job.metadata.name, get, pause);
      }
      ensureResource(entry.deployment, prepared.owner, get, kubectl, namespace);
      kubectl(['rollout', 'status', `deployment/${entry.name}`, '-n', namespace, '--timeout=240s']);
      report(
        `Independent ${entry.authority === 'global' ? 'Global' : 'Region'} analytics is ready.`,
      );
    }
    ensureResource(prepared.apiSecret, prepared.owner, get, kubectl, namespace);
    if (!enabled) await switchConfiguration(target, prepared, options, kubectl);
  }
  for (const entry of prepared.entries) {
    const live = get('deployment', entry.name);
    managed(live, prepared.owner);
    if (!matchesManifest(live.spec.template.spec, entry.deployment.spec.template.spec))
      throw new AnalyticsCloudError('Analytics runtime differs from its prepared identity.');
    if (options.operation === 'restart-analytics') {
      kubectl(['rollout', 'restart', `deployment/${entry.name}`, '-n', namespace]);
      kubectl(['rollout', 'status', `deployment/${entry.name}`, '-n', namespace, '--timeout=240s']);
    }
    if (live.status?.availableReplicas !== 1)
      throw new AnalyticsCloudError('An independent analytics deployment is unavailable.');
  }
  await verifyAnalyticsPublic(request);
  return {
    analyticsEnabled: true,
    authorities: prepared.entries.length,
    adminPolicy: 'verified-pingcap-only',
    collection: 'best-effort-asynchronous',
    businessMetadataPreserved: true,
    realAccountLoginVerified: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = (binary, args, input) => {
    try {
      return execFileSync(binary, args, {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 330000,
      });
    } catch (error) {
      error.analyticsCommand = 'kubernetes-operation';
      throw error;
    }
  };
  try {
    const result = await enableAnalytics(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
        operation: process.env.CUTOVER_OPERATION,
      },
      {
        kubectl: (args, input) => command('kubectl', ['--request-timeout=30s', ...args], input),
        report: (message) => console.log(message),
      },
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    // Command errors can contain credential-bearing configuration; never print their output.
    const category = /AccessDenied|Unauthorized|forbidden/i.test(String(error.stderr || ''))
      ? 'operator-permission-denied'
      : 'analytics-operation-unconfirmed';
    console.error(category);
    if (error.analyticsCommand) console.error(error.analyticsCommand);
    if (error instanceof AnalyticsCloudError) console.error(error.message);
    process.exitCode = 1;
  }
}
