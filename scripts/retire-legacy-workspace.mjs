import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dns = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const digestImage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const marker = 'Legacy Workspace live metadata and credentials removed.';

// Explicit owner-authorized one-time retirement. A failure never rolls back to code that
// expects the deleted Workspace; preserve the flag and let the operator inspect/retry.
export async function retireLegacy(
  { namespace, deployment, container, image, origin },
  kubectl,
  request,
) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new Error('Invalid deployment target.');
  if (!digestImage.test(image ?? ''))
    throw new Error('An exact immutable image digest is required.');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw new Error('Invalid public origin.');
  const target = `deployment/${deployment}`;
  const current = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const selected = current.spec?.template?.spec?.containers?.find(
    (item) => item.name === container,
  );
  if (
    current.spec?.replicas !== 1 ||
    current.spec?.strategy?.type !== 'Recreate' ||
    selected?.image !== image
  )
    throw new Error('Expected one Recreate replica running the exact verified image.');
  const flags = (selected.env || []).filter((item) => item.name === 'WORKSPACE_RETIRE_LEGACY');
  if (flags.length > 1 || flags[0]?.valueFrom || (flags.length && flags[0].value !== 'ws_agentlab'))
    throw new Error('Unexpected legacy retirement configuration.');
  if (!flags.length)
    kubectl([
      'set',
      'env',
      target,
      '-n',
      namespace,
      `--containers=${container}`,
      'WORKSPACE_RETIRE_LEGACY=ws_agentlab',
    ]);
  kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
  const logs = kubectl(['logs', target, '-n', namespace, `--container=${container}`]);
  if (!logs.split(/\r?\n/).includes(marker))
    throw new Error('Legacy retirement completion was not confirmed.');
  const health = await request(`${origin}/studio/api/health`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!health.ok) throw new Error('API health verification failed after retirement.');
  kubectl([
    'set',
    'env',
    target,
    '-n',
    namespace,
    `--containers=${container}`,
    'WORKSPACE_RETIRE_LEGACY-',
  ]);
  kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
  const after = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const final = after.spec?.template?.spec?.containers?.find((item) => item.name === container);
  if (
    final?.image !== image ||
    (final.env || []).some((item) => item.name === 'WORKSPACE_RETIRE_LEGACY')
  )
    throw new Error('Final deployment verification failed.');
  const finalHealth = await request(`${origin}/studio/api/health`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!finalHealth.ok) throw new Error('API health verification failed after removing the flag.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await retireLegacy(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
        image: process.env.IMAGE_REF,
        origin: 'https://drive9.ai',
      },
      (args) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 330_000,
        }),
      fetch,
    );
    console.log('Legacy Workspace retirement verified; temporary flag removed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
