import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dns = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const digestImage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;

// An incident rollback is authorized only for the exact known failed deployment image.
export async function recover({ namespace, deployment, container, image }, kubectl, request) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new Error('Invalid deployment target.');
  if (!digestImage.test(image ?? ''))
    throw new Error('A verified failed image digest is required.');
  const target = `deployment/${deployment}`;
  const current = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const selected = current.spec?.template?.spec?.containers?.find(
    (item) => item.name === container,
  );
  if (selected?.image !== image)
    throw new Error('Deployment has changed since the failed release; no rollback attempted.');
  if ((selected.env || []).some((item) => item.name === 'WORKSPACE_RETIRE_LEGACY'))
    throw new Error('Legacy retirement state requires manual reconciliation before rollback.');
  kubectl(['rollout', 'undo', target, '-n', namespace]);
  kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
  const after = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const actual = after.spec?.template?.spec?.containers?.find(
    (item) => item.name === container,
  )?.image;
  if (!digestImage.test(actual ?? '') || actual === image)
    throw new Error('Rollback image was not confirmed.');
  const health = await request('https://drive9.ai/studio/api/health', {
    signal: AbortSignal.timeout(20_000),
  });
  if (!health.ok)
    throw new Error('Rollback was applied but public API health remains unavailable.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await recover(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
        image: process.env.FAILED_IMAGE,
      },
      (args) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 330_000,
        }),
      fetch,
    );
    console.log('Previous image restored and public API health verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
