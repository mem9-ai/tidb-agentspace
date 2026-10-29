import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, open, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify, isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { privateJson, createMetaClient } from './client.mjs';
import { localS3 } from './local-s3.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function privateWrite(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function retry(fn) {
  for (let i = 0; i < 200; i++) {
    try {
      return await fn();
    } catch {
      if (i === 199)
        throw new Error('Local metadata startup failed; inspect private runtime logs.');
      await delay(100);
    }
  }
}
export async function initializeLocalRuntime({
  directory,
  sourceFile,
  regions = ['local-compat', 'local-secondary'],
}) {
  directory = resolve(directory);
  sourceFile = resolve(sourceFile);
  if (
    !regions.length ||
    new Set(regions).size !== regions.length ||
    regions.some((r) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r))
  )
    throw new Error('Use distinct explicit local Region IDs.');
  const source = await privateJson(sourceFile);
  if (source.workspace?.id !== 'ws_agentlab')
    throw new Error('The compatibility gateway currently supports the existing ws_agentlab only.');
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(resolve(directory, 'objects'), { mode: 0o700 });
  const s3port = await freePort();
  const accessKeyId = 'local' + randomBytes(10).toString('hex'),
    secretAccessKey = randomBytes(32).toString('hex');
  const accessKeyFile = resolve(directory, 's3-access'),
    secretKeyFile = resolve(directory, 's3-secret');
  await writeFile(accessKeyFile, accessKeyId, { mode: 0o600 });
  await writeFile(secretKeyFile, secretAccessKey, { mode: 0o600 });
  const storage = {
    endpoint: `http://127.0.0.1:${s3port}`,
    region: 'us-east-1',
    accessKeyId,
    secretAccessKey,
  };
  const services = [];
  for (const authorityId of ['global', ...regions.map((r) => `region:${r}`)]) {
    const name = authorityId.replace(':', '-');
    const installationId = 'meta-' + name + '-' + randomBytes(6).toString('hex');
    const port = await freePort();
    const tokenFile = resolve(directory, name + '-token'),
      encryptionKeyFile = resolve(directory, name + '-key');
    await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    await writeFile(encryptionKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const config = {
      authorityId,
      installationId,
      environment: 'local',
      bind: `127.0.0.1:${port}`,
      s3: { ...storage, bucket: installationId, prefix: 'metadata' },
      tokenFile,
      encryptionKeyFile,
      encryptionKeyId: installationId + '-key-v1',
      insecureLoopback: true,
    };
    const configFile = resolve(directory, name + '.json');
    await privateWrite(configFile, config);
    services.push({
      authorityId,
      configFile,
      initialized: false,
      client: {
        origin: `http://127.0.0.1:${port}`,
        authorityId,
        installationId,
        tokenFile,
        insecureLoopback: true,
      },
      descriptor: {
        regionId: authorityId.replace('region:', ''),
        metaDeploymentId: installationId,
        environmentId: 'local',
        engine: 'slatedb',
        engineRelease: '0.17.0',
        formatVersion: 1,
        mainStorage: {
          provider: 'rustfs',
          endpoint: storage.endpoint,
          region: 'local',
          signingRegion: storage.region,
          bucket: config.s3.bucket,
          prefix: config.s3.prefix,
        },
        walStorage: { sameAsMain: true },
        catalogKey: 'control/installation.json',
        encryptionKeyRef: config.encryptionKeyId,
        runtimeIdentityRef: 'local-loopback-runtime',
        recoveryIdentityRef: 'local-operator',
        configGeneration: 1,
      },
    });
  }
  const bridgeFile = resolve(directory, 'node-bridge.json');
  const servingFile = resolve(directory, 'node-serving.json');
  const importId = randomUUID();
  await privateWrite(servingFile, {
    format: 1,
    importId,
    workspaceId: source.workspace.id,
    region: services[1].client,
  });
  await privateWrite(bridgeFile, {
    format: 1,
    importId,
    workspaceId: source.workspace.id,
    global: services[0].client,
    region: services[1].client,
    regionStorage: services[1].descriptor,
  });
  const topology = {
    format: 1,
    sourceFile,
    bridgeFile,
    servingFile,
    storage,
    accessKeyFile,
    secretKeyFile,
    services,
  };
  await privateWrite(resolve(directory, 'topology.json'), topology);
  return {
    directory,
    bridgeFile,
    servingFile,
    services: services.map((s) => ({ authorityId: s.authorityId, origin: s.client.origin })),
  };
}

export async function serveLocalRuntime({ directory }) {
  directory = resolve(directory);
  const topologyFile = resolve(directory, 'topology.json');
  const topology = await privateJson(topologyFile);
  if (topology.format !== 1) throw new Error('Unsupported local metadata topology.');
  const lock = resolve(directory, 'runtime.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
    mode: 0o600,
  });
  const children = [],
    clients = [];
  const failed = new WeakSet();
  const stopped = new Promise((r) => {
    process.once('SIGTERM', r);
    process.once('SIGINT', r);
  });
  const start = (binary, args, name, env = {}) => {
    const log = createWriteStream(resolve(directory, name + '.log'), { mode: 0o600 });
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', () => {
      failed.add(child);
      console.error('A local role could not start; inspect its private configuration.');
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    children.push(child);
    return child;
  };
  const close = async () => {
    for (const client of clients) client.close();
    for (const child of children.toReversed()) {
      if (failed.has(child) || child.exitCode !== null || child.signalCode) continue;
      const stopped = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await stopped;
      clearTimeout(timer);
    }
    await rm(lock, { recursive: true });
  };
  try {
    const { stdout } = await promisify(execFile)(process.env.RUSTFS_BINARY || 'rustfs', [
      '--version',
    ]);
    if (!stdout.includes('rustfs 1.0.4'))
      throw new Error('This local runtime is verified with RustFS 1.0.4.');
    start(
      process.env.RUSTFS_BINARY || 'rustfs',
      [
        'server',
        '--address',
        new URL(topology.storage.endpoint).host,
        '--access-key-file',
        topology.accessKeyFile,
        '--secret-key-file',
        topology.secretKeyFile,
        '--region',
        topology.storage.region,
        resolve(directory, 'objects'),
      ],
      'rustfs',
      { RUSTFS_CONSOLE_ENABLE: 'false' },
    );
    const s3 = localS3(topology.storage);
    await retry(async () => {
      const r = await fetch(topology.storage.endpoint, { signal: AbortSignal.timeout(500) });
      await r.body?.cancel();
    });
    for (const service of topology.services) {
      const config = await privateJson(service.configFile);
      if (!service.initialized)
        await retry(async () => {
          const r = await s3('PUT', '/' + config.s3.bucket);
          if (!r.ok && r.status !== 409) throw new Error('Local bucket unavailable.');
          await r.body?.cancel();
        });
      start(
        resolve(repository, 'meta-service/target/debug/workspace-meta-service'),
        ['--config', service.configFile, ...(service.initialized ? [] : ['--initialize'])],
        service.authorityId.replace(':', '-'),
      );
    }
    const results = await Promise.allSettled(
      topology.services.map(async (service) => {
        const client = await retry(() => createMetaClient(service.client));
        clients.push(client);
        service.initialized = true;
        return client;
      }),
    );
    await privateWrite(topologyFile, topology);
    const global = results[0].status === 'fulfilled' ? results[0].value : undefined;
    if (global)
      for (let i = 1; i < topology.services.length; i++) {
        if (results[i].status !== 'fulfilled') continue;
        const service = topology.services[i];
        const scope = {
          authorityId: 'global',
          ownerKind: 'system',
          ownerId: 'regions',
          family: 'metadata-deployment',
          partitionId: service.descriptor.regionId,
        };
        const existing = await global.call({ op: 'snapshot', scope });
        if (!existing.revision)
          await global.call({
            op: 'commit',
            scope,
            expectedRevision: null,
            mutationId: randomUUID(),
            changes: [{ key: 'descriptor', value: service.descriptor }],
          });
        else if (!isDeepStrictEqual(existing.records.descriptor, service.descriptor))
          console.error(
            'Regional metadata remains available; reconcile the differing Global deployment descriptor explicitly.',
          );
      }
    if (results.every((r) => r.status === 'rejected'))
      throw new Error('No metadata authority could start.');
    console.log(
      'Local metadata runtime ready. Failed roles do not stop healthy regional services.',
    );
    for (let i = 0; i < results.length; i++)
      console.log(
        `${topology.services[i].authorityId}: ${results[i].status === 'fulfilled' ? 'ready' : 'unavailable'}`,
      );
    console.log(`Node serving configuration: ${topology.servingFile}`);
    await stopped;
  } finally {
    await close();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { directory: { type: 'string' }, source: { type: 'string' } },
  });
  try {
    if (positionals[0] === 'init')
      console.log(
        JSON.stringify(
          await initializeLocalRuntime({ directory: values.directory, sourceFile: values.source }),
        ),
      );
    else if (positionals[0] === 'serve') await serveLocalRuntime({ directory: values.directory });
    else throw new Error('Use init or serve with an explicit private directory.');
  } catch {
    console.error(
      'Local metadata runtime did not start; preserve its configuration and inspect private logs.',
    );
    process.exitCode = 1;
  }
}
