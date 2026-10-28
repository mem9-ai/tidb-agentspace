import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sqlError, sqlLimits } from './sql-common.mjs';

// Only server-generated catalog/preview SELECTs enter this runner. Never route customer SQL here.
export function createDuckdbCatalog({
  disposable,
  idleMs = 15_000,
  maxAgeMs = 60_000,
  launch = fork,
} = {}) {
  let current, closing;
  function session(input) {
    const child = launch(fileURLToPath(new URL('./duckdb-worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
      env: { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8' },
    });
    const entry = { key: input.key, born: performance.now(), busy: false };
    let pending,
      idleTimer,
      dead = false;
    const fail = (error) => {
      if (dead) return;
      dead = true;
      clearTimeout(idleTimer);
      if (current === entry) current = undefined;
      child.kill('SIGKILL');
      pending?.finish(error);
    };
    child.on('error', () =>
      fail(sqlError(503, 'DUCKDB_WORKER_FAILED', 'Catalog worker could not start.')),
    );
    child.on('exit', () =>
      fail(sqlError(502, 'DUCKDB_WORKER_FAILED', 'Catalog worker stopped. Refresh to try again.')),
    );
    child.on('message', (message) => {
      if (!pending) return;
      if (message.error)
        fail(sqlError(message.error.status, message.error.code, message.error.message));
      else pending.finish(null, message.result);
    });
    const request = (message, signal, timeoutMs) =>
      new Promise((resolve, reject) => {
        const abort = () => fail(sqlError(499, 'SQL_CANCELED', 'Catalog request canceled.'));
        const timer = setTimeout(
          () => fail(sqlError(504, 'SQL_TIMEOUT', 'Catalog request exceeded 15 seconds.')),
          timeoutMs,
        );
        pending = {
          finish(error, result) {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            pending = undefined;
            if (error) reject(error);
            else resolve(result);
          },
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        child.send(message, (error) => {
          if (error) fail(sqlError(502, 'DUCKDB_WORKER_FAILED', 'Catalog worker disconnected.'));
        });
      });
    entry.query = async (next) => {
      clearTimeout(idleTimer);
      entry.busy = true;
      try {
        const { connection, extensionPath, sql, limits, signal } = next;
        return await request(
          { connection, extensionPath, sql, limits, catalog: true, readOnly: true },
          signal,
          limits?.timeoutMs ?? sqlLimits.timeoutMs,
        );
      } finally {
        entry.busy = false;
        if (!dead) {
          idleTimer = setTimeout(
            () => {
              if (current === entry) void invalidateIdle();
            },
            Math.max(1, Math.min(idleMs, maxAgeMs - (performance.now() - entry.born))),
          );
          idleTimer.unref();
        }
      }
    };
    entry.close = async () => {
      clearTimeout(idleTimer);
      try {
        await request({ close: true }, undefined, sqlLimits.timeoutMs);
      } finally {
        fail(sqlError(499, 'SQL_CANCELED', 'Catalog reader closed.'));
      }
    };
    entry.abort = () => fail(sqlError(499, 'SQL_CANCELED', 'Catalog reader closed.'));
    return entry;
  }
  async function invalidateIdle() {
    if (current && !current.busy) {
      const previous = current;
      current = undefined;
      closing = previous.close().catch(() => {});
    }
    await closing;
  }
  return {
    invalidateIdle,
    async query(input) {
      for (;;) {
        await closing;
        if (current?.busy) return disposable({ ...input, readOnly: true });
        if (
          current &&
          (current.key !== input.key || performance.now() - current.born >= maxAgeMs)
        ) {
          await invalidateIdle();
          continue;
        }
        current ??= session(input);
        return current.query(input);
      }
    },
    async close() {
      if (current?.busy) current.abort();
      await invalidateIdle();
    },
  };
}
