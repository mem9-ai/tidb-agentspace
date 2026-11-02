import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMetaClient } from '../meta/client.mjs';
import { localS3 } from '../meta/local-s3.mjs';

export async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const result = server.address().port;
  await new Promise((r) => server.close(r));
  return result;
}
// Hold each selected port until its service is ready to bind. Otherwise another fixture
// service can acquire a recently released port and answer the wrong readiness probe.
export async function reservePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
      servers.push(server);
    }
    return servers.map((server) => ({
      port: server.address().port,
      async release() {
        if (!server.listening) return;
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    }));
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    throw error;
  }
}
export async function until(fn) {
  let error;
  for (let i = 0; i < 200; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await delay(100);
    }
  }
  throw error;
}
export async function metaFixture({ directory, persistent = false } = {}) {
  directory ||= await mkdtemp(resolve(tmpdir(), 'workspace-meta-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const children = [];
  const secret = randomBytes(32).toString('hex');
  const access = 'test' + randomBytes(8).toString('hex');
  const s3port = await port();
  const endpoint = `http://127.0.0.1:${s3port}`;
  const region = 'us-east-1';
  const start = (binary, args, env, name) => {
    const log = createWriteStream(resolve(directory, `${name}-${randomUUID()}.log`), {
      mode: 0o600,
    });
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    children.push(child);
    return child;
  };
  const stop = async (child, signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill(signal);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  };
  await mkdir(resolve(directory, 'objects'), { recursive: true, mode: 0o700 });
  const storage = start(
    process.env.RUSTFS_BINARY || 'rustfs',
    [
      'server',
      '--address',
      `127.0.0.1:${s3port}`,
      '--region',
      region,
      resolve(directory, 'objects'),
    ],
    {
      RUSTFS_ACCESS_KEY: access,
      RUSTFS_SECRET_KEY: secret,
      RUSTFS_CONSOLE_ENABLE: 'false',
    },
    'rustfs',
  );
  const s3 = localS3({ endpoint, region, accessKeyId: access, secretAccessKey: secret });
  await until(async () => {
    const r = await fetch(endpoint, { signal: AbortSignal.timeout(500) });
    await r.body?.cancel();
    return true;
  });
  async function service(
    name,
    { previous, recoverOwner, initialize = !previous, tls, clientTls } = {},
  ) {
    const bucket = previous?.server.s3.bucket || `meta-${randomBytes(8).toString('hex')}`;
    if (!previous)
      await until(async () => {
        const r = await s3('PUT', '/' + bucket);
        if (!r.ok) throw new Error('S3 bucket initialization failed.');
      });
    const listen = await port();
    const tokenFile = previous?.server.tokenFile || resolve(directory, name + '-token');
    const encryptionKeyFile =
      previous?.server.encryptionKeyFile || resolve(directory, name + '-key');
    if (!previous) {
      await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      await writeFile(encryptionKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    const server = previous
      ? { ...previous.server, bind: `127.0.0.1:${listen}`, ...tls }
      : {
          authorityId: name === 'global' ? 'global' : `region:${name}`,
          installationId: 'meta-' + name,
          environment: 'test',
          bind: `127.0.0.1:${listen}`,
          s3: {
            endpoint,
            region,
            bucket,
            prefix: 'metadata',
            accessKeyId: access,
            secretAccessKey: secret,
          },
          tokenFile,
          encryptionKeyFile,
          encryptionKeyId: 'test-key-v1',
          insecureLoopback: true,
          ...tls,
        };
    const path = resolve(directory, `${name}-${listen}.json`);
    await writeFile(path, JSON.stringify(server), { mode: 0o600 });
    const child = start(
      resolve('meta-service/target/debug/workspace-meta-service'),
      [
        '--config',
        path,
        ...(initialize ? ['--initialize'] : []),
        ...(recoverOwner ? ['--recover-owner', recoverOwner] : []),
      ],
      {},
      name,
    );
    const clientConfig = {
      authorityId: server.authorityId,
      installationId: server.installationId,
      origin: `${server.insecureLoopback ? 'http' : 'https'}://127.0.0.1:${listen}`,
      tokenFile,
      insecureLoopback: server.insecureLoopback,
      ...(clientTls ? { tls: clientTls } : {}),
    };
    const client = await until(() => createMetaClient(clientConfig));
    return { child, server, clientConfig, client, stop: (signal) => stop(child, signal) };
  }
  return {
    directory,
    service,
    s3,
    storage,
    stop,
    async close() {
      for (const child of children.toReversed()) await stop(child);
      if (!persistent) await rm(directory, { recursive: true, force: true });
    },
  };
}
