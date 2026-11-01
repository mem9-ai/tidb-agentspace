import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

// Operator tooling only. Existing Meta roots, encryption keys and provider bindings are untouched.
export async function globalApiProfile({
  directory,
  mountDirectory,
  api,
  clockDirectory = '/var/lib/workspace/security',
  initializeClock = false,
  globalMetadata = { transport: 'inProcess', authorityId: 'global' },
}) {
  const own = (name) => resolve(directory, name),
    runtime = (name) => resolve(mountDirectory, name);
  await mkdir(directory, { mode: 0o700 });
  const save = (name, value) => writeFile(own(name), value, { mode: 0o600, flag: 'wx' });
  const run = promisify(execFile);
  for (const name of ['global', 'region']) {
    const pair = generateKeyPairSync('ed25519');
    await save(name + '-signing.der', pair.privateKey.export({ format: 'der', type: 'pkcs8' }));
    await save(
      name + '-signing.pub',
      Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'),
    );
  }
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-keyout',
    own('control-ca.key'),
    '-out',
    own('control-ca.crt'),
    '-days',
    '365',
    '-subj',
    '/CN=workspace-control-ca',
  ]);
  await chmod(own('control-ca.key'), 0o600);
  for (const name of ['server', 'client']) {
    await run('openssl', [
      'req',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-keyout',
      own(`control-${name}.key`),
      '-out',
      own(`control-${name}.csr`),
      '-subj',
      `/CN=workspace-control-${name}`,
    ]);
    await chmod(own(`control-${name}.key`), 0o600);
    await save(
      `control-${name}.ext`,
      `extendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`,
    );
    await run('openssl', [
      'x509',
      '-req',
      '-in',
      own(`control-${name}.csr`),
      '-CA',
      own('control-ca.crt'),
      '-CAkey',
      own('control-ca.key'),
      '-CAcreateserial',
      '-out',
      own(`control-${name}.crt`),
      '-days',
      '365',
      '-extfile',
      own(`control-${name}.ext`),
    ]);
  }
  const publicOrigin = api.publicOrigins?.[0];
  if (!publicOrigin) throw new Error('Explicit Region public origin required.');
  const path = (api.publicPath || '') + '/api/global';
  const globalBase = publicOrigin + path;
  const authority = api.authorityId;
  const controls = {
    bind: '127.0.0.1:7444',
    certificateFile: runtime('control-server.crt'),
    privateKeyFile: runtime('control-server.key'),
    clientCaFile: runtime('control-ca.crt'),
    globalClientCertificates: [runtime('control-client.crt')],
  };
  const global = {
    bind: api.bind,
    metadata: globalMetadata,
    publicOrigin,
    publicPath: path,
    sharedListener: true,
    consoleOrigins: api.consoleOrigins || [],
    environment: 'test',
    signerId: 'global-primary',
    signingKeyFile: runtime('global-signing.der'),
    verificationKeyFile: runtime('global-signing.pub'),
    clockDirectory: resolve(clockDirectory, 'global'),
    initializeClock,
    regions: [
      { regionId: authority, apiOrigin: publicOrigin, apiPathPrefix: api.publicPath || '' },
    ],
    regionControls: [
      {
        regionId: authority,
        origin: 'https://127.0.0.1:7444',
        tls: {
          caFile: runtime('control-ca.crt'),
          certificateFile: runtime('control-client.crt'),
          privateKeyFile: runtime('control-client.key'),
        },
      },
    ],
    // Hosted Portal uses its existing verified callback for both sessions.
    ...(!api.sso ? { localWorkspace: { workspaceId: api.workspaceId, regionId: authority } } : {}),
  };
  const security = {
    publicOrigin,
    environment: 'test',
    globalIssuer: globalBase,
    globalSignerId: 'global-primary',
    globalPublicKeyFile: runtime('global-signing.pub'),
    regionalSignerId: 'region-primary',
    regionalSigningKeyFile: runtime('region-signing.der'),
    regionalPublicKeyFile: runtime('region-signing.pub'),
    clockDirectory: resolve(clockDirectory, 'region'),
    initializeClock,
    accessTokenTtl: 900,
    control: controls,
  };
  return {
    global,
    api: { ...api, security, globalEntry: { apiOrigin: publicOrigin, apiPathPrefix: path } },
  };
}
