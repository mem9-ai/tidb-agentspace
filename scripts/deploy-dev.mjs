import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

class DeploymentError extends Error {}

const dns = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const digestImage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function imageTarget(target, container) {
  const pod = target.spec?.template?.spec;
  const matches = (pod?.containers || []).filter((item) => item.name === container);
  if (matches.length !== 1)
    throw new DeploymentError('Expected exactly one selected API container.');
  if (
    (pod.containers || []).some((item) =>
      (item.env || []).some((env) => env.name === 'WORKSPACE_RETIRE_LEGACY'),
    )
  )
    throw new DeploymentError('Legacy retirement requires separate reconciliation.');
  if (target.spec?.replicas !== 1 || target.spec?.strategy?.type !== 'Recreate')
    throw new DeploymentError('Expected exactly one Recreate replica for the SlateDB writer.');
  if (
    !target.metadata?.uid ||
    !target.metadata?.resourceVersion ||
    !Number.isInteger(target.metadata?.generation)
  )
    throw new DeploymentError('Deployment identity and revision are required.');
  return matches[0];
}

function matchesCandidate(original, actual, container, image, generation) {
  if (actual.metadata?.uid !== original.metadata.uid || actual.metadata?.generation !== generation)
    return false;
  const template = structuredClone(original.spec.template);
  template.spec.containers.find((item) => item.name === container).image = image;
  return (
    actual.spec?.replicas === 1 &&
    actual.spec?.strategy?.type === 'Recreate' &&
    same(actual.spec.template, template)
  );
}

function rollbackApproved(policyText, sourceSha, previousImage) {
  if (!policyText) return false;
  try {
    const policy = JSON.parse(policyText);
    return (
      Array.isArray(policy) &&
      policy.some(
        (entry) =>
          entry &&
          entry.sourceSha === sourceSha &&
          entry.previousDigest === previousImage.split('@')[1] &&
          entry.storageCompatible === true,
      )
    );
  } catch {
    throw new DeploymentError('The protected rollback policy is invalid.');
  }
}

async function publicHealth(request, pause, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const health = await request('https://drive9.ai/studio/api/health', {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (health.status === 200 && (await health.json()).status === 'ok') {
        const config = await request('https://drive9.ai/studio/api/auth/config', {
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        const anonymous = await request('https://drive9.ai/studio/api/v1/workspaces', {
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (
          config.status === 200 &&
          (await config.json()).enabled === true &&
          anonymous.status === 401
        )
          return true;
      }
    } catch {
      /* Retry read-only public checks only. */
    }
    if (i + 1 < attempts) await pause(5000);
  }
  return false;
}

// Explicit operator recovery after inspecting metadata ownership and confirming that the
// selected old image is compatible with all writes the failed image may have performed.
export async function recoverDev(
  { namespace, deployment, container, failedImage, image, confirmation },
  kubectl,
  request,
  pause = delay,
) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new DeploymentError('Namespace, deployment and container must be DNS labels.');
  if (
    !digestImage.test(image ?? '') ||
    !digestImage.test(failedImage ?? '') ||
    image === failedImage ||
    confirmation !== 'storage-compatible'
  )
    throw new DeploymentError(
      'Exact failed and recovery images and storage compatibility confirmation are required.',
    );
  const target = `deployment/${deployment}`;
  const read = () => JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const before = read();
  const selected = imageTarget(before, container);
  if (
    selected.image !== failedImage ||
    !selected.readinessProbe ||
    before.status?.observedGeneration !== before.metadata.generation ||
    (before.status?.readyReplicas ?? 0) !== 0 ||
    (before.status?.availableReplicas ?? 0) !== 0
  )
    throw new DeploymentError(
      'The exact failed image must be observed and unavailable before recovery.',
    );
  try {
    kubectl([
      'patch',
      target,
      '-n',
      namespace,
      '--type=strategic',
      '--patch',
      JSON.stringify({
        metadata: { resourceVersion: before.metadata.resourceVersion },
        spec: { template: { spec: { containers: [{ name: container, image }] } } },
      }),
      '-o',
      'name',
    ]);
  } catch {
    throw new DeploymentError('Recovery update outcome is uncertain; inspect writer ownership.');
  }
  try {
    kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
  } catch {
    throw new DeploymentError('Recovery did not become ready; inspect writer ownership.');
  }
  const after = read();
  const generation = before.metadata.generation + 1;
  if (
    !matchesCandidate(before, after, container, image, generation) ||
    after.status?.observedGeneration !== generation ||
    after.status?.availableReplicas !== 1 ||
    after.status?.readyReplicas !== 1 ||
    after.status?.updatedReplicas !== 1
  )
    throw new DeploymentError(
      'Recovered deployment identity and readiness could not be confirmed.',
    );
  if (!(await publicHealth(request, pause, 6)))
    throw new DeploymentError('Recovery is ready but public verification failed.');
}

// The optional protected policy explicitly attests the old binary can read any metadata
// the candidate may write. Missing/ambiguous evidence never authorizes a downgrade.
export async function deployDev(
  { namespace, deployment, container, image, sourceSha, rollbackPolicy },
  kubectl,
  request,
  pause = delay,
) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new DeploymentError('Namespace, deployment and container must be DNS labels.');
  if (!digestImage.test(image ?? '') || !sha.test(sourceSha ?? ''))
    throw new DeploymentError('An immutable image and exact source SHA are required.');
  const target = `deployment/${deployment}`;
  const read = () => JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const original = read();
  const selected = imageTarget(original, container);
  const previous = selected.image;
  if (!digestImage.test(previous ?? '') || !selected.readinessProbe)
    throw new DeploymentError('An immutable current image and readiness probe are required.');
  if (
    original.status?.observedGeneration !== original.metadata.generation ||
    original.status?.availableReplicas !== 1 ||
    original.status?.updatedReplicas !== 1 ||
    original.status?.readyReplicas !== 1
  )
    throw new DeploymentError('The existing deployment is not fully observed and ready.');
  if (!(await publicHealth(request, pause, 2)))
    throw new DeploymentError('Public health baseline failed; deployment was not changed.');
  if (previous === image) return;
  const approved = rollbackApproved(rollbackPolicy, sourceSha, previous);
  console.log(
    `Previous image digest: ${previous.split('@')[1]}; candidate: ${image.split('@')[1]}.`,
  );
  const patchImage = (version, next) =>
    kubectl([
      'patch',
      target,
      '-n',
      namespace,
      '--type=strategic',
      '--patch',
      JSON.stringify({
        metadata: { resourceVersion: version },
        spec: { template: { spec: { containers: [{ name: container, image: next }] } } },
      }),
      '-o',
      'name',
    ]);
  try {
    patchImage(original.metadata.resourceVersion, image);
  } catch {
    throw new DeploymentError('Deployment update outcome is uncertain; inspect before recovery.');
  }
  let updated;
  try {
    updated = read();
    imageTarget(updated, container);
  } catch {
    throw new DeploymentError('Updated deployment is unavailable; inspect before recovery.');
  }
  const generation = original.metadata.generation + 1;
  if (!matchesCandidate(original, updated, container, image, generation))
    throw new DeploymentError('Deployment changed unexpectedly; no recovery attempted.');
  try {
    kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
  } catch {
    if (!approved)
      throw new DeploymentError(
        'Rollout failed; no compatible rollback is approved. Inspect the target and writer ownership.',
      );
    let failed;
    try {
      failed = read();
      imageTarget(failed, container);
    } catch {
      throw new DeploymentError(
        'Rollout failed and target state is uncertain; no rollback attempted.',
      );
    }
    if (
      !matchesCandidate(original, failed, container, image, generation) ||
      failed.status?.observedGeneration !== generation ||
      (failed.status?.availableReplicas ?? 0) !== 0 ||
      (failed.status?.readyReplicas ?? 0) !== 0
    )
      throw new DeploymentError(
        'Rollout failure or target identity is uncertain; no rollback attempted.',
      );
    try {
      patchImage(failed.metadata.resourceVersion, previous);
    } catch {
      throw new DeploymentError(
        'Rollback outcome is uncertain; inspect writer ownership before action.',
      );
    }
    try {
      kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=300s']);
    } catch {
      throw new DeploymentError('Rollback did not become ready; inspect writer ownership.');
    }
    const recovered = read();
    if (
      !matchesCandidate(original, recovered, container, previous, generation + 1) ||
      recovered.status?.observedGeneration !== generation + 1 ||
      recovered.status?.availableReplicas !== 1 ||
      recovered.status?.updatedReplicas !== 1 ||
      recovered.status?.readyReplicas !== 1
    )
      throw new DeploymentError('Rollback state could not be confirmed; inspect before action.');
    if (!(await publicHealth(request, pause, 6)))
      throw new DeploymentError('Rollback is ready but public verification failed.');
    throw new DeploymentError(
      'Candidate rollout failed; approved previous image restored and verified.',
    );
  }
  const confirmed = read();
  if (
    !matchesCandidate(original, confirmed, container, image, generation) ||
    confirmed.status?.observedGeneration !== generation ||
    confirmed.status?.availableReplicas !== 1 ||
    confirmed.status?.updatedReplicas !== 1 ||
    confirmed.status?.readyReplicas !== 1
  )
    throw new DeploymentError('Candidate readiness or deployment identity could not be confirmed.');
  if (!(await publicHealth(request, pause, 6)))
    throw new DeploymentError(
      'Candidate is ready but public verification failed; no rollback attempted.',
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const kubectl = (args) =>
      execFileSync(
        'kubectl',
        [args[0] === 'rollout' ? '--request-timeout=0' : '--request-timeout=30s', ...args],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 330_000,
        },
      );
    if (process.argv[2] === '--recover') {
      const base = `${process.env.ECR_REGISTRY}/${process.env.ECR_REPOSITORY}`;
      await recoverDev(
        {
          namespace: process.env.DEPLOY_NAMESPACE,
          deployment: process.env.K8S_DEPLOYMENT,
          container: process.env.K8S_CONTAINER,
          failedImage: `${base}@${process.env.FAILED_IMAGE_DIGEST}`,
          image: `${base}@${process.env.RECOVERY_IMAGE_DIGEST}`,
          confirmation: process.env.RECOVERY_CONFIRMATION,
        },
        kubectl,
        fetch,
      );
      console.log('Recovery readiness and public API checks verified.');
    } else {
      await deployDev(
        {
          namespace: process.env.DEPLOY_NAMESPACE,
          deployment: process.env.K8S_DEPLOYMENT,
          container: process.env.K8S_CONTAINER,
          image: process.env.IMAGE_REF,
          sourceSha: process.env.SOURCE_SHA,
          rollbackPolicy: process.env.DEV_ROLLBACK_POLICY,
        },
        kubectl,
        fetch,
      );
      console.log('Deployment readiness and public API checks verified.');
    }
  } catch (error) {
    // Never print kubectl output or private deployment material.
    console.error(
      error instanceof DeploymentError
        ? error.message
        : 'A Kubernetes operation failed; inspect before action.',
    );
    process.exitCode = 1;
  }
}
