import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, withFreshStore } from '../store.mjs';
import { createDuckdbCatalog } from './duckdb-catalog.mjs';
import { sqlError, sqlLimits } from './sql-common.mjs';

export const duckdbProvider = 'duckdb-drive9';
export const duckdbRegion = 'aws-ap-southeast-1';
export async function verifyDuckdbRuntime(path, digest) {
  if (!path || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(digest || '')) return false;
  try {
    return (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') === digest
    );
  } catch {
    return false;
  }
}
export function runDuckdbWorker({
  connection,
  extensionPath,
  sql,
  signal,
  probe = false,
  sources,
  readOnly,
  limits = sqlLimits,
}) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./duckdb-worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
      env: { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8' },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () =>
      finish(
        sqlError(499, 'SQL_CANCELED', 'Request canceled. Check any write outcome before retrying.'),
      );
    const timer = setTimeout(
      () =>
        finish(
          sqlError(
            504,
            'SQL_TIMEOUT',
            'DuckDB exceeded 15 seconds. Check any write outcome and allow storage locks to expire before retrying.',
          ),
        ),
      limits.timeoutMs,
    );
    child.on('error', () =>
      finish(sqlError(503, 'DUCKDB_WORKER_FAILED', 'DuckDB worker could not start.')),
    );
    child.on('exit', () =>
      finish(
        sqlError(
          502,
          'DUCKDB_WORKER_FAILED',
          'DuckDB worker stopped. Check any write outcome before retrying.',
        ),
      ),
    );
    child.once('message', (message) => {
      if (message.error)
        finish(sqlError(message.error.status, message.error.code, message.error.message));
      else finish(null, message.result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    child.send({ connection, extensionPath, sql, limits, probe, sources, readOnly });
  });
}
export async function createDuckdb({
  credentialsFile,
  storeFactory = createStore,
  drive9,
  extensionPath = process.env.WORKSPACE_DUCKDB_EXTENSION,
  extensionSha256 = process.env.WORKSPACE_DUCKDB_EXTENSION_SHA256,
  execute = runDuckdbWorker,
}) {
  if (storeFactory === createStore) {
    try {
      if ((await stat(credentialsFile)).mode & 0o077)
        throw new Error('DuckDB bindings require owner-only permissions.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const vault = await storeFactory(credentialsFile, () => ({ bindings: {} }));
  let available = await verifyDuckdbRuntime(extensionPath, extensionSha256);
  if (available) {
    try {
      await execute({ extensionPath, probe: true });
    } catch {
      available = false;
    }
  }
  const catalog =
    execute === runDuckdbWorker ? createDuckdbCatalog({ disposable: execute }) : undefined;
  const provisioning = new Map(),
    active = new Set();
  const get = (id) => vault.read().bindings[id];
  const requireRuntime = () => {
    if (!available)
      throw sqlError(
        503,
        'DUCKDB_RUNTIME_UNAVAILABLE',
        'DuckDB requires a verified native runtime. Contact the workspace operator.',
      );
  };
  const verifyRuntime = async () => {
    requireRuntime();
    if (!(await verifyDuckdbRuntime(extensionPath, extensionSha256)))
      throw sqlError(503, 'DUCKDB_RUNTIME_UNAVAILABLE', 'DuckDB runtime verification failed.');
  };
  const run = async (binding, sql, signal, sources, limits, catalogRead = false) => {
    requireRuntime();
    // Recheck the operator-pinned artifact before every native process launch.
    if (!(await verifyDuckdbRuntime(extensionPath, extensionSha256)))
      throw sqlError(503, 'DUCKDB_RUNTIME_UNAVAILABLE', 'DuckDB runtime verification failed.');
    if (!catalogRead) await catalog?.invalidateIdle();
    signal?.throwIfAborted();
    const input = {
      connection: await drive9.internalConnection(binding.storageId),
      extensionPath,
      sql,
      signal,
      sources,
      limits,
      readOnly: catalogRead,
    };
    return catalogRead && catalog
      ? catalog.query({ ...input, key: binding.storageId })
      : execute(input);
  };
  async function status(id) {
    const binding = get(id);
    if (!binding)
      return { status: 'failed', connectionError: 'DuckDB storage needs operator recovery.' };
    if (binding.state !== 'ready')
      return {
        status: 'provisioning',
        connectionError: 'Database setup is incomplete. Retry setup to use its existing storage.',
      };
    return { status: 'active' };
  }
  async function provisionOnce(resource) {
    await verifyRuntime();
    let binding = get(resource.id);
    if (!binding) {
      binding = { storageId: 'duckdb_' + randomBytes(12).toString('hex'), state: 'requested' };
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = binding;
      });
    }
    if (binding.state === 'ready') return status(resource.id);
    const info = await drive9.provision(binding.storageId);
    if (info.status !== 'active')
      return {
        status: 'provisioning',
        connectionError: 'Database storage is not ready. Retry setup later.',
      };
    await run(binding, 'SELECT 1 AS connected');
    await vault.mutate((draft) => {
      draft.bindings[resource.id].state = 'ready';
    });
    return status(resource.id);
  }
  async function executeQuery(
    resource,
    sql,
    signal,
    loadSources,
    catalogRead = false,
    timeoutMs = sqlLimits.timeoutMs,
  ) {
    requireRuntime();
    if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > sqlLimits.sqlBytes)
      throw sqlError(400, 'INVALID_SQL', 'Enter one SQL statement, up to 64 KiB.');
    const binding = get(resource.id);
    if (binding?.state !== 'ready')
      throw sqlError(409, 'DATABASE_UNAVAILABLE', 'DuckDB is not ready for queries.');
    if (active.size >= 4 || active.has(resource.id))
      throw sqlError(429, 'SQL_BUSY', 'DuckDB is busy. Wait for the current query to finish.');
    active.add(resource.id);
    const started = performance.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const workSignal = AbortSignal.any([deadline, ...[signal].filter(Boolean)]);
    let staged;
    try {
      if (loadSources) staged = await loadSources(workSignal);
      workSignal?.throwIfAborted();
      return {
        ...(await run(
          binding,
          sql,
          workSignal,
          staged?.sources,
          {
            ...sqlLimits,
            timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)),
          },
          catalogRead,
        )),
        mode: 'live',
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (workSignal?.aborted)
        throw sqlError(
          signal?.aborted ? 499 : 504,
          signal?.aborted ? 'SQL_CANCELED' : 'SQL_TIMEOUT',
          loadSources
            ? 'File query canceled or exceeded 15 seconds. No source query is retried automatically.'
            : `DuckDB request canceled or exceeded ${timeoutMs / 1000} seconds. Check any write outcome before retrying.`,
        );
      throw error;
    } finally {
      try {
        await staged?.cleanup();
      } finally {
        active.delete(resource.id);
      }
    }
  }
  return withFreshStore(
    {
      available,
      requireRuntime,
      verifyRuntime,
      status,
      provision(resource) {
        if (!provisioning.has(resource.id))
          provisioning.set(
            resource.id,
            provisionOnce(resource).finally(() => provisioning.delete(resource.id)),
          );
        return provisioning.get(resource.id);
      },
      execute: executeQuery,
      importStatement(resource, sql, signal) {
        return executeQuery(resource, sql, signal, undefined, false, 30000);
      },
      catalog(resource, sql, signal) {
        return executeQuery(resource, sql, signal, undefined, true);
      },
      close() {
        return catalog?.close();
      },
    },
    vault,
  );
}
