import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dns = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function enableGuest({ namespace, deployment, container, origin }, kubectl, request) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new Error('Namespace, deployment and container must be DNS labels.');
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Public origin must be an exact HTTPS origin.');
  const target = `deployment/${deployment}`;
  const deploymentJson = JSON.parse(kubectl(['get', target, '-n', namespace, '-o', 'json']));
  const selected = deploymentJson.spec?.template?.spec?.containers?.find(
    (item) => item.name === container,
  );
  if (!selected) throw new Error('Deployment container was not found.');
  const existing = (selected.env || []).filter((entry) => entry.name === 'WORKSPACE_GUEST_ENABLED');
  if (
    existing.length > 1 ||
    existing[0]?.valueFrom ||
    (existing.length && !['true', 'false'].includes(existing[0].value))
  )
    throw new Error('Guest setting is not a plain supported value.');
  const changed = existing[0]?.value !== 'true';
  let attempted = false;
  try {
    if (changed) {
      try {
        kubectl([
          'set',
          'env',
          target,
          '-n',
          namespace,
          `--containers=${container}`,
          'WORKSPACE_GUEST_ENABLED=true',
        ]);
      } catch {
        throw new Error('Guest configuration update outcome is uncertain; inspect the deployment.');
      }
      attempted = true;
      kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=180s']);
    }
    const call = (path, options = {}) =>
      request(`${origin}/studio${path}`, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Origin: origin, ...options.headers },
      });
    const config = await call('/api/auth/config');
    if (!config.ok || (await config.json()).guestEnabled !== true)
      throw new Error('Guest API is not enabled.');
    const signup = await call('/api/auth/guest', { method: 'POST' });
    const header = signup.headers.get('set-cookie') || '';
    if (
      !signup.ok ||
      !header.includes('HttpOnly') ||
      !header.includes('Secure') ||
      !header.includes('SameSite=Strict') ||
      !header.includes('Expires=') ||
      !header.includes('Path=/studio/') ||
      /(?:^|;)\s*Domain=/i.test(header)
    )
      throw new Error('Guest signup or cookie policy verification failed.');
    const expiry = Date.parse(header.match(/(?:^|;)\s*Expires=([^;]+)/i)?.[1] || '');
    const remaining = expiry - Date.now();
    if (!Number.isFinite(expiry) || remaining < 23 * 3600_000 || remaining > 24 * 3600_000 + 60_000)
      throw new Error('Guest Cookie expiry verification failed.');
    const guest = await signup.json();
    if (typeof guest.workspaceId !== 'string')
      throw new Error('Guest signup returned no Workspace.');
    const workspace = await call('/api/v1/workspaces', {
      headers: { Cookie: header.split(';')[0] },
    });
    const listing = await workspace.json();
    if (!workspace.ok || listing.data?.length !== 1 || listing.data[0]?.id !== guest.workspaceId)
      throw new Error('Guest Workspace verification failed.');
  } catch (failure) {
    if (
      !attempted &&
      failure.message === 'Guest configuration update outcome is uncertain; inspect the deployment.'
    )
      throw failure;
    if (attempted) {
      try {
        kubectl(['rollout', 'undo', target, '-n', namespace]);
        kubectl(['rollout', 'status', target, '-n', namespace, '--timeout=180s']);
      } catch {
        throw new Error(
          'Guest enablement failed and rollback could not be confirmed; inspect the deployment.',
        );
      }
      throw new Error('Guest enablement verification failed; the deployment was rolled back.', {
        cause: failure,
      });
    }
    throw new Error('Guest verification failed; the existing deployment was not changed.', {
      cause: failure,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await enableGuest(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
        origin: process.env.PUBLIC_ORIGIN,
      },
      (args) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 210_000,
        }),
      fetch,
    );
    console.log('Guest enabled; regional Workspace and cookie verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
