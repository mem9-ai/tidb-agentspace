import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// One-time private configuration tooling, never part of the serving image.
export async function initializeHostedConfig({ directory, mountDirectory, input }) {
  if (!isAbsolute(directory) || !isAbsolute(mountDirectory))
    throw new Error('Use absolute private configuration directories.');
  const endpoint = new URL(input.s3?.endpoint);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    !input.s3?.bucket ||
    !input.s3?.region
  )
    throw new Error('Supply the existing HTTPS S3 bucket and region in private input.');
  const publicOrigin = new URL(input.publicOrigin);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== input.publicOrigin)
    throw new Error('Supply an exact public HTTPS origin.');
  if (
    !input.sso?.issuer ||
    !input.sso?.clientId ||
    !(input.sso.ownerSubjects?.length || input.sso.ownerEmailRules?.length)
  )
    throw new Error('Supply an SSO client and explicit owner grants.');
  const prefix = input.prefix || 'studio-native';
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(prefix) ||
    prefix.split('/').some((s) => s === '.' || s === '..')
  )
    throw new Error('Supply a non-root S3 prefix.');
  // mkdir is exclusive: rerunning cannot overwrite keys or silently point at an existing root.
  await mkdir(directory, { mode: 0o700 });
  const installation = randomUUID();
  const runtimePath = (name) => resolve(mountDirectory, name);
  const save = (name, value) =>
    writeFile(
      resolve(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  const services = [];
  for (const [role, bind] of [
    ['global', '127.0.0.1:7442'],
    ['region', '127.0.0.1:7443'],
  ]) {
    const authorityId = role === 'global' ? 'global' : 'region:studio-dev';
    await save(role + '-token', randomBytes(32).toString('hex'));
    await save(role + '-key', randomBytes(32).toString('hex'));
    await save(role + '.json', {
      authorityId,
      installationId: `${role}-${installation}`,
      environment: 'test',
      bind,
      s3: { ...input.s3, prefix: `${prefix}/${installation}/${role}` },
      tokenFile: runtimePath(role + '-token'),
      encryptionKeyFile: runtimePath(role + '-key'),
      encryptionKeyId: `${role}-${installation}`,
      insecureLoopback: true,
    });
    services.push({ kind: 'metadata', configFile: runtimePath(role + '.json') });
  }
  const api = {
    bind: '0.0.0.0:4318',
    workspaceId: input.workspaceId || 'ws_agentlab',
    authorityId: 'region:studio-dev',
    initializeWorkspace: true,
    insecureLoopback: false,
    consoleOrigins: [],
    publicOrigins: [input.publicOrigin],
    publicPath: '/studio',
    metadata: { transport: 'inProcess', authorityId: 'region:studio-dev' },
    sso: {
      ...input.sso,
      redirectUri: input.publicOrigin + '/studio/api/auth/tidbcloud/callback',
      allowLoopbackHttp: false,
    },
    product: input.product || {
      providers: {
        filesProvider: 'drive9-anonymous',
        mysqlProvider: 'tidb-cloud-zero',
        postgresProvider: 'local',
      },
    },
  };
  await save('api-bootstrap.json', api);
  await save('api.json', { ...api, initializeWorkspace: false });
  services.push({ kind: 'workspace', configFile: runtimePath('api.json') });
  await save('deployment.json', { format: 1, services });
  await save('bootstrap.json', {
    format: 1,
    services: services.map((s) =>
      s.kind === 'metadata'
        ? { ...s, initialize: true }
        : { ...s, configFile: runtimePath('api-bootstrap.json') },
    ),
  });
  return {
    installation,
    files: [
      'deployment.json',
      'bootstrap.json',
      'api-bootstrap.json',
      'api.json',
      'global.json',
      'region.json',
      'global-token',
      'global-key',
      'region-token',
      'region-key',
    ],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const info = await lstat(process.argv[2]);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error('Private input required.');
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const result = await initializeHostedConfig({
      input,
      directory: resolve(process.argv[3]),
      mountDirectory: '/run/workspace',
    });
    console.log(
      `Prepared fresh private native configuration (${result.files.length} files). No cloud resources were changed.`,
    );
  } catch {
    console.error(
      'Cannot prepare native configuration. Check private input and use a new output directory.',
    );
    process.exitCode = 1;
  }
}
