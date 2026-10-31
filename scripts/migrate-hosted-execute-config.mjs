import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const dns = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const digestImage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const secretName = (value) =>
  typeof value === 'string' &&
  value.length <= 253 &&
  value
    .split('.')
    .every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part));

// The callback keeps the Secret solely in memory. Only its two API configuration keys may
// change; all other keys, values, metadata and the current resourceVersion are preserved.
export async function migrate(
  { namespace, deployment, container },
  kubectl,
  request,
  pause = delay,
) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new Error('Invalid deployment target.');
  const target = `deployment/${deployment}`;
  const source = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const pod = source.spec?.template?.spec;
  const selected = pod?.containers?.find((item) => item.name === container);
  if (
    source.spec?.replicas !== 1 ||
    source.spec?.strategy?.type !== 'Recreate' ||
    !digestImage.test(selected?.image ?? '')
  )
    throw new Error('Expected one Recreate replica with an immutable image.');
  if ((selected.env || []).some((item) => item.name === 'WORKSPACE_RETIRE_LEGACY'))
    throw new Error('Legacy retirement must be resolved before configuration repair.');
  const names = [
    ...new Set((pod.volumes || []).map((volume) => volume.secret?.secretName).filter(Boolean)),
  ];
  if (names.some((name) => !secretName(name))) throw new Error('Invalid Secret reference.');
  const candidates = [];
  for (const name of names) {
    const secret = JSON.parse(kubectl(['get', 'secret', name, '-n', namespace, '-o', 'json']));
    if (secret.data?.['api.json'] && secret.data?.['api-bootstrap.json']) candidates.push(secret);
  }
  if (candidates.length !== 1)
    throw new Error('Expected exactly one referenced API configuration Secret.');
  const secret = candidates[0];
  if (!secret.metadata?.resourceVersion || !secretName(secret.metadata?.name))
    throw new Error('API configuration Secret cannot be safely updated.');
  let changes = 0;
  for (const key of ['api.json', 'api-bootstrap.json']) {
    let config;
    try {
      config = JSON.parse(Buffer.from(secret.data[key], 'base64').toString('utf8'));
    } catch {
      throw new Error('API configuration is not valid JSON.');
    }
    const product = config.product;
    if (!product || typeof product !== 'object' || Array.isArray(product))
      throw new Error('API product configuration is invalid.');
    const old = Object.hasOwn(product, 'compute');
    const current = Object.hasOwn(product, 'execute');
    if ((old && current) || (!old && !current))
      throw new Error('API execution configuration is ambiguous.');
    if (old) {
      product.execute = product.compute;
      delete product.compute;
      secret.data[key] = Buffer.from(JSON.stringify(config)).toString('base64');
      changes += 1;
    }
  }
  let updatedVolume = false;
  let replacementName;
  if (changes && secret.immutable === true) {
    if (!source.metadata?.resourceVersion)
      throw new Error('Deployment resourceVersion is required.');
    const prefix = `${secret.metadata.name}-execute-`;
    const listed = kubectl([
      'get',
      'secrets',
      '-n',
      namespace,
      '-o=jsonpath={.items[*].metadata.name}',
    ])
      .trim()
      .split(/\s+/)
      .filter(
        (name) => name.startsWith(prefix) && /^[a-f0-9]{12}$/.test(name.slice(prefix.length)),
      );
    if (listed.length > 1)
      throw new Error('Multiple replacement Secrets require operator inspection.');
    const newName = listed[0] || `${prefix}${randomBytes(6).toString('hex')}`;
    if (!secretName(newName)) throw new Error('Cannot construct a safe replacement Secret name.');
    // Immutable Secrets cannot be patched. Create a fresh copy and switch only the
    // matching Deployment volume, keeping the original intact for operator recovery.
    const replacement = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: newName, namespace },
      type: secret.type || 'Opaque',
      immutable: true,
      data: secret.data,
    };
    if (listed.length) {
      const existing = JSON.parse(
        kubectl(['get', 'secret', newName, '-n', namespace, '-o', 'json']),
      );
      const sorted = (data) =>
        JSON.stringify(Object.entries(data || {}).sort(([a], [b]) => a.localeCompare(b)));
      if (
        existing.immutable !== true ||
        (existing.type || 'Opaque') !== replacement.type ||
        sorted(existing.data) !== sorted(replacement.data)
      )
        throw new Error('Replacement Secret does not match; operator inspection is required.');
    } else {
      kubectl(['create', '-f', '-', '-n', namespace, '-o', 'name'], JSON.stringify(replacement));
    }
    const volumes = pod.volumes
      .filter((volume) => volume.secret?.secretName === secret.metadata.name)
      .map((volume) => ({ name: volume.name, secret: { secretName: newName } }));
    const patch = {
      metadata: { resourceVersion: source.metadata.resourceVersion },
      spec: { template: { spec: { volumes } } },
    };
    kubectl([
      'patch',
      target,
      '-n',
      namespace,
      '--type=strategic',
      '--patch',
      JSON.stringify(patch),
      '-o',
      'name',
    ]);
    updatedVolume = true;
    replacementName = newName;
  } else if (changes) {
    // A replace with resourceVersion provides an optimistic-concurrency precondition.
    // Secret bytes travel only via stdin; never place them in arguments, logs or a file.
    kubectl(['replace', '-f', '-', '-n', namespace, '-o', 'name'], JSON.stringify(secret));
  }
  if (changes && !updatedVolume) kubectl(['rollout', 'restart', target, '-n', namespace]);
  kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
  const after = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  if (
    after.spec?.template?.spec?.containers?.find((item) => item.name === container)?.image !==
    selected.image
  )
    throw new Error('The deployment image changed during configuration repair.');
  if (updatedVolume) {
    const finalVolumes = after.spec?.template?.spec?.volumes || [];
    for (const original of pod.volumes.filter(
      (volume) => volume.secret?.secretName === secret.metadata.name,
    )) {
      if (
        finalVolumes.find((volume) => volume.name === original.name)?.secret?.secretName !==
        replacementName
      )
        throw new Error('The replacement Secret volume was not confirmed.');
    }
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const health = await request('https://drive9.ai/studio/api/health', {
        signal: AbortSignal.timeout(15_000),
      });
      if (health.ok) return;
    } catch {
      /* Retry only the read-only health check. */
    }
    if (attempt < 11) await pause(5000);
  }
  throw new Error('Configuration was updated, but public API health remains unavailable.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await migrate(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
      },
      (args, input) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          input,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 330_000,
        }),
      fetch,
    );
    console.log('Hosted execution configuration migrated; API health verified.');
  } catch (error) {
    // Child stderr may contain private objects: report only controlled error messages.
    console.error(
      error.status === undefined
        ? error.message
        : 'A Kubernetes operation failed; inspect permissions and target state.',
    );
    process.exitCode = 1;
  }
}
