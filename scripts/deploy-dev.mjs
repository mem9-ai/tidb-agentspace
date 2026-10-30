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
  const read = () => JSON.parse(kubectl(['get', target, ...scope, '-o', 'json']));
  const runtime = (value) =>
    value.spec?.template?.spec?.containers?.find((c) => c.name === container);
  let initial;
  try {
    initial = read();
  } catch {
    throw new Error('Cannot read the existing Deployment; no resources were changed.');
  }
  const previous = runtime(initial);
  if (!previous) throw new Error('Existing container is missing.');
  if (previous.readinessProbe?.httpGet?.path !== '/api/health')
    throw new Error('Existing container must have an HTTP readiness probe for /api/health.');
  if (initial.spec.template.metadata?.annotations?.['workspace.tidb.ai/runtime'] !== 'rust-v1')
    throw new Error(
      'Bootstrap the native target and its private configuration before image-only delivery.',
    );
  if (!initial.metadata?.uid || !initial.metadata.resourceVersion)
    throw new Error('Deployment identity is missing; no resources were changed.');

  if (image !== previous.image) {
    const index = initial.spec.template.spec.containers.findIndex((c) => c.name === container);
    const path = `/spec/template/spec/containers/${index}/image`;
    const patch = [
      { op: 'test', path: '/metadata/uid', value: initial.metadata.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: initial.metadata.resourceVersion },
      { op: 'test', path, value: previous.image },
      { op: 'replace', path, value: image },
    ];
    try {
      kubectl(['patch', target, ...scope, '--type=json', '--patch', JSON.stringify(patch)]);
    } catch {
      throw new Error('Image update failed; inspect the deployment before retrying.');
    }
  }
  let current;
  try {
    kubectl(['rollout', 'status', target, ...scope, '--timeout=300s']);
    current = read();
  } catch {
    throw new Error('Deployment readiness could not be verified; inspect the deployment.');
  }
  if (current.metadata?.uid !== initial.metadata.uid || runtime(current)?.image !== image)
    throw new Error('Deployment changed during readiness verification.');
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
