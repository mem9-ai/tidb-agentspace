import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export async function metadataCertificates(directory) {
  const run = promisify(execFile);
  const path = (name) => resolve(directory, name);
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path('ca.key'),
    '-out',
    path('ca.crt'),
    '-days',
    '1',
    '-subj',
    '/CN=metadata-test-ca',
  ]);
  for (const name of ['server', 'client']) {
    await run('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path(name + '.key'),
      '-out',
      path(name + '.csr'),
      '-subj',
      `/CN=metadata-${name}`,
    ]);
    await writeFile(
      path(name + '.ext'),
      `extendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`,
    );
    await run('openssl', [
      'x509',
      '-req',
      '-in',
      path(name + '.csr'),
      '-CA',
      path('ca.crt'),
      '-CAkey',
      path('ca.key'),
      '-CAcreateserial',
      '-out',
      path(name + '.crt'),
      '-days',
      '1',
      '-extfile',
      path(name + '.ext'),
    ]);
    await chmod(path(name + '.key'), 0o600);
  }
  await chmod(path('ca.key'), 0o600);
  return {
    server: {
      certificateFile: path('server.crt'),
      privateKeyFile: path('server.key'),
      clientCaFile: path('ca.crt'),
    },
    client: {
      certificateFile: path('client.crt'),
      privateKeyFile: path('client.key'),
      caFile: path('ca.crt'),
    },
  };
}
