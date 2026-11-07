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
  const f = await open(temporary, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temporary, path);
  const d = await open(dirname(path), 'r');
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
async function retry(fn) {
  for (let i = 0; i < 200; i++) {
    try {
      return await fn();
    } catch {
      if (i === 199) throw new Error('Local service startup failed; inspect private runtime logs.');
      await delay(100);
    }
  }
}
export async function initializeLocalRuntime({
  directory,
  regions = ['local-compat', 'local-secondary'],
  apiPort = 4318,
  binary = resolve(repository, 'meta-service/target/debug/workspace-backend'),
  workspaceId = 'ws_agentlab',
}) {
  if (
    !regions.length ||
    new Set(regions).size !== regions.length ||
    regions.some((r) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r)) ||
    !Number.isInteger(apiPort) ||
    apiPort < 1 ||
    apiPort > 65535 ||
    !/^ws_[a-z0-9_-]{1,60}$/.test(workspaceId)
  )
    throw new Error('Use distinct Region IDs, a valid port and Workspace identity.');
  directory = resolve(directory);
  binary = resolve(binary);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(resolve(directory, 'objects'), { mode: 0o700 });
  const accessKeyId = 'local' + randomBytes(10).toString('hex'),
    secretAccessKey = randomBytes(32).toString('hex');
  const accessKeyFile = resolve(directory, 's3-access'),
    secretKeyFile = resolve(directory, 's3-secret');
  await writeFile(accessKeyFile, accessKeyId, { mode: 0o600 });
  await writeFile(secretKeyFile, secretAccessKey, { mode: 0o600 });
  const storage = {
    endpoint: `http://127.0.0.1:${await freePort()}`,
    region: 'us-east-1',
    accessKeyId,
    secretAccessKey,
  };
  const services = [];
  for (const authorityId of ['global', ...regions.map((r) => `region:${r}`)]) {
    const name = authorityId.replace(':', '-'),
      installationId = 'meta-' + name + '-' + randomBytes(6).toString('hex');
    const tokenFile = resolve(directory, name + '-token'),
      encryptionKeyFile = resolve(directory, name + '-key');
    await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    await writeFile(encryptionKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const port = await freePort(),
      configFile = resolve(directory, name + '.json'),
      planFile = resolve(directory, name + '-plan.json');
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
    await privateWrite(configFile, config);
    services.push({
      authorityId,
      configFile,
      planFile,
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
        engine: 'slatedb',
        engineRelease: '0.18.0',
        formatVersion: 2,
        mainStorage: {
          provider: 'rustfs',
          endpoint: storage.endpoint,
          region: 'local',
          signingRegion: storage.region,
          bucket: config.s3.bucket,
          prefix: config.s3.prefix,
        },
        encryptionKeyRef: config.encryptionKeyId,
      },
    });
  }
  const apiConfigFile = resolve(directory, 'rust-api.json'),
    apiPlanFile = resolve(directory, 'rust-api-plan.json');
  await privateWrite(apiConfigFile, {
    bind: `127.0.0.1:${apiPort}`,
    workspaceId,
    authorityId: services[1].authorityId,
    initializeWorkspace: true,
    metadata: { transport: 'remote', client: services[1].client },
    insecureLoopback: true,
    consoleOrigins: [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ],
    product: {},
  });
  await privateWrite(apiPlanFile, {
    format: 1,
    services: [{ kind: 'workspace', configFile: apiConfigFile }],
  });
  const topology = {
    format: 2,
    binary,
    storage,
    accessKeyFile,
    secretKeyFile,
    services,
    apiConfigFile,
    apiPlanFile,
    workspaceInitialized: false,
  };
  await privateWrite(resolve(directory, 'topology.json'), topology);
  return {
    directory,
    apiConfigFile,
    apiPlanFile,
    services: services.map((s) => ({ authorityId: s.authorityId, origin: s.client.origin })),
  };
}
export async function serveLocalRuntime({ directory }) {
  directory = resolve(directory);
  const topologyFile = resolve(directory, 'topology.json'),
    topology = await privateJson(topologyFile);
  if (topology.format !== 2)
    throw new Error('Fresh record metadata is required; legacy imports are unsupported.');
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
      console.error('A local role could not start; inspect private configuration.');
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    children.push(child);
    return child;
  };
  const close = async () => {
    for (const c of clients) c.close();
    for (const child of children.toReversed()) {
      if (failed.has(child) || child.exitCode !== null || child.signalCode) continue;
      const done = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const timeout = new AbortController();
      try {
        await Promise.race([
          done,
          delay(45000, undefined, { signal: timeout.signal }).then(() => {
            throw new Error('Graceful drain is incomplete; preserve storage and ownership.');
          }),
        ]);
      } finally {
        timeout.abort();
      }
    }
    await rm(lock, { recursive: true });
  };
  try {
    const rustfs = process.env.RUSTFS_BINARY || 'rustfs';
    const { stdout } = await promisify(execFile)(rustfs, ['--version']);
    if (!stdout.includes('rustfs 1.0.4')) throw new Error('RustFS 1.0.4 is required.');
    start(
      rustfs,
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
      await privateWrite(service.planFile, {
        format: 1,
        services: [
          { kind: 'metadata', configFile: service.configFile, initialize: !service.initialized },
        ],
      });
      start(
        topology.binary,
        ['serve', '--config', service.planFile],
        service.authorityId.replace(':', '-'),
      );
    }
    let writes = Promise.resolve();
    const saveTopology = () => {
      writes = writes.then(() => privateWrite(topologyFile, topology));
      return writes;
    };
    const readiness = topology.services.map(async (service) => {
      const client = await retry(() => createMetaClient(service.client));
      clients.push(client);
      service.initialized = true;
      await privateWrite(service.planFile, {
        format: 1,
        services: [{ kind: 'metadata', configFile: service.configFile }],
      });
      await saveTopology();
      return client;
    });
    // Start the regional API as soon as its own metadata is ready, independently of Global.
    const apiReady = (async () => {
      await readiness[1];
      const config = await privateJson(topology.apiConfigFile);
      config.initializeWorkspace = !topology.workspaceInitialized;
      await privateWrite(topology.apiConfigFile, config);
      start(topology.binary, ['serve', '--config', topology.apiPlanFile], 'rust-api');
      await retry(async () => {
        const r = await fetch('http://' + config.bind + '/api/health', {
          signal: AbortSignal.timeout(1000),
        });
        if (!r.ok) throw new Error('Regional API unavailable.');
        await r.body?.cancel();
      });
      topology.workspaceInitialized = true;
      config.initializeWorkspace = false;
      await privateWrite(topology.apiConfigFile, config);
      await saveTopology();
    })();
    const [results, apiResult] = await Promise.all([
      Promise.allSettled(readiness),
      Promise.allSettled([apiReady]),
    ]);
    if (apiResult[0].status === 'rejected')
      console.error('Regional API unavailable; other roles remain independent.');
    if (results[0].status === 'fulfilled') {
      const global = results[0].value;
      for (const service of topology.services.slice(1)) {
        try {
          const scope = {
            authorityId: 'global',
            ownerKind: 'system',
            ownerId: 'regions',
            family: 'metadata-deployment',
            partitionId: service.descriptor.regionId,
          };
          const existing = await global.call({ op: 'get', scope, keys: ['descriptor'] });
          const descriptor = existing.records.descriptor;
          if (!descriptor)
            await global.call({
              op: 'commit',
              scope,
              mutationId: randomUUID(),
              changes: [{ key: 'descriptor', expectedVersion: null, value: service.descriptor }],
            });
          else if (!isDeepStrictEqual(descriptor.value, service.descriptor))
            console.error(
              'Reconcile Global storage descriptors explicitly; regional serving continues.',
            );
        } catch {
          console.error('Global storage directory unavailable; regional serving continues.');
        }
      }
    }
    if (results.every((r) => r.status === 'rejected'))
      throw new Error('No metadata authority could start.');
    console.log('Local metadata runtime ready. Fresh record storage; no legacy import.');
    for (let i = 0; i < results.length; i++)
      console.log(
        `${topology.services[i].authorityId}: ${results[i].status === 'fulfilled' ? 'ready' : 'unavailable'}`,
      );
    await stopped;
  } finally {
    await close();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      'api-port': { type: 'string' },
      binary: { type: 'string' },
      workspace: { type: 'string' },
    },
  });
  try {
    if (positionals[0] === 'init')
      console.log(
        JSON.stringify(
          await initializeLocalRuntime({
            directory: values.directory,
            apiPort: Number(values['api-port'] || 4318),
            binary: values.binary,
            workspaceId: values.workspace,
          }),
        ),
      );
    else if (positionals[0] === 'serve') await serveLocalRuntime({ directory: values.directory });
    else throw new Error('Use init or serve with an explicit private directory.');
  } catch {
    console.error(
      'Local runtime failed; inspect private logs and preserve ownership until reconciled.',
    );
    process.exitCode = 1;
  }
}
