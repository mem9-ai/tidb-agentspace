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

  try {
    kubectl(['set', 'image', `deployment/${deployment}`, '-n', namespace, `${container}=${image}`]);
  } catch {
    throw new Error('Deployment image update failed; inspect the target before retrying.');
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
          timeout: 60_000,
        }),
    );
    console.log('Deployment image updated.');
  } catch (error) {
    // kubectl output may include environment identifiers. Only the bounded
    // errors above are reported in Actions logs.
    console.error(error.message);
    process.exitCode = 1;
  }
}
