import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digestImage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;

export function deployDev({ namespace, deployment, container, image }, kubectl) {
  for (const value of [namespace, deployment, container]) {
    if (typeof value !== 'string' || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))
      throw new Error('Namespace, deployment and container must be DNS labels.');
  }
  if (!digestImage.test(image ?? '')) throw new Error('Image must use an immutable digest.');

  const target = `deployment/${deployment}`;
  const scope = ['-n', namespace];
  let current;
  try {
    current = JSON.parse(kubectl(['get', target, ...scope, '-o', 'json']));
  } catch {
    throw new Error('Cannot read the existing Deployment; no resources were changed.');
  }
  const previous = current.spec?.template?.spec?.containers?.find((c) => c.name === container);
  if (!previous || !digestImage.test(previous.image))
    throw new Error('Existing container must have a digest-pinned image for rollback.');
  if (previous.readinessProbe?.httpGet?.path !== '/api/health')
    throw new Error('Existing container must have an HTTP readiness probe for /api/health.');

  const setImage = (value) => kubectl(['set', 'image', target, `${container}=${value}`, ...scope]);
  const wait = () => kubectl(['rollout', 'status', target, ...scope, '--timeout=300s']);
  try {
    if (image !== previous.image) setImage(image);
    wait();
  } catch {
    if (image === previous.image) throw new Error('Current deployment is not ready.');
    // An image update can commit even if its response is lost. Restore the
    // captured image on either update or readiness failure, without undoing
    // unrelated Pod-template configuration or modifying persistent storage.
    try {
      setImage(previous.image);
      wait();
    } catch {
      throw new Error('Deployment failed and rollback did not recover readiness.');
    }
    throw new Error('Deployment failed; the previous image is restored and ready.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    deployDev(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
        image: process.env.IMAGE_REF,
      },
      (args) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 330_000,
        }),
    );
    console.log('Deployment image is ready.');
  } catch (error) {
    // kubectl output may include environment identifiers. Only the bounded
    // stage-specific errors above are reported in Actions logs.
    console.error(error.message);
    process.exitCode = 1;
  }
}
