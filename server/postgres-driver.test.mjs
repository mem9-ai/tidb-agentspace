import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { executePostgres, postgresError } from './providers/postgres-driver.mjs';
import { sqlLimits } from './providers/sql-common.mjs';
const binding = {
  kind: 'postgresql',
  host: 'pg.db9.io',
  port: 5432,
  user: 'tenant.w1234567890ab',
  password: 'private-password',
  database: 'postgres',
};
function driver({
  rows = [[1]],
  columns = ['connected'],
  rowCount = rows.length,
  error,
  connectError,
  hold = false,
} = {}) {
  const clients = [];
  class Query extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
    }
  }
  class Client extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.calls = [];
      this.closed = false;
      clients.push(this);
    }
    async connect() {
      if (connectError) throw connectError;
    }
    async end() {
      this.closed = true;
    }
    query(query) {
      this.calls.push(query);
      assert.equal((query.config || query).queryMode, 'extended');
      if (!(query instanceof Query)) return Promise.resolve({ fields: [], rows: [] });
      queueMicrotask(() => {
        if (hold) return;
        if (error) return query.emit('error', error);
        const result = { fields: columns.map((name) => ({ name })), rowCount };
        for (const row of rows) {
          if (this.closed) return;
          query.emit('row', row, result);
        }
        if (!this.closed) query.emit('end', result);
      });
      return query;
    }
  }
  return {
    clients,
    loadDriver: async () => ({ Client, Query, types: { getTypeParser: () => (value) => value } }),
  };
}
test('PostgreSQL: fresh verified TLS sessions use extended protocol and preserve exact values/duplicates/binary/null', async () => {
  const f = driver({
    columns: ['value', 'value', 'date', 'json', 'bytes', 'missing'],
    rows: [
      [
        '9007199254740993',
        '0.1234567890123456789',
        '2026-10-28 12:00:00.123456',
        '{"n":9007199254740993}',
        Buffer.from('ab'),
        null,
      ],
    ],
  });
  const result = await executePostgres(binding, 'SELECT values', {
    limits: sqlLimits,
    loadDriver: f.loadDriver,
  });
  assert.deepEqual(result.columns, ['value', 'value_2', 'date', 'json', 'bytes', 'missing']);
  assert.equal(result.rows[0].value, '9007199254740993');
  assert.equal(result.rows[0].value_2, '0.1234567890123456789');
  assert.equal(result.rows[0].missing, null);
  assert.equal(result.rows[0].bytes, 'YWI=');
  const client = f.clients[0];
  assert.equal(client.closed, true);
  assert.equal(client.config.ssl.rejectUnauthorized, true);
  assert.equal(client.config.ssl.servername, binding.host);
  assert.equal(client.calls[0].text, 'SET search_path TO workspace, pg_catalog');
  assert.equal(
    client.config.types.getTypeParser(1184)('2026-10-28 01:02:03.123456+00'),
    '2026-10-28 01:02:03.123456+00',
  );
  await executePostgres(binding, 'SELECT 1', { limits: sqlLimits, loadDriver: f.loadDriver });
  assert.equal(f.clients.length, 2);
});
test('PostgreSQL: empty rowsets retain fields and DML reports affected rows', async () => {
  const empty = driver({ columns: ['id'], rows: [] });
  assert.deepEqual(
    await executePostgres(binding, 'SELECT id FROM empty', {
      limits: sqlLimits,
      loadDriver: empty.loadDriver,
    }),
    { columns: ['id'], rows: [], rowCount: 0, affectedRows: 0 },
  );
  const update = driver({ columns: [], rows: [], rowCount: 7 });
  assert.equal(
    (
      await executePostgres(binding, 'UPDATE notes SET value=1', {
        limits: sqlLimits,
        loadDriver: update.loadDriver,
      })
    ).affectedRows,
    7,
  );
});
test('PostgreSQL: row/byte overflow, native failures, timeouts and cancellation close sessions with safe errors', async () => {
  for (const limits of [
    { ...sqlLimits, rows: 1 },
    { ...sqlLimits, bytes: 12 },
  ]) {
    const f = driver({ columns: ['value'], rows: [['a'.repeat(30)], ['b']] });
    await assert.rejects(
      executePostgres(binding, 'SELECT value', { limits, loadDriver: f.loadDriver }),
      { code: 'RESULT_TOO_LARGE' },
    );
    assert.equal(f.clients[0].closed, true);
  }
  for (const code of ['42601', '42501', '42P01', '23505', '57014', 'ECONNRESET']) {
    const f = driver({ error: Object.assign(new Error('private-password SQL text'), { code }) });
    await assert.rejects(
      executePostgres(binding, 'SELECT secret', { limits: sqlLimits, loadDriver: f.loadDriver }),
      (e) => !e.message.includes('private-password') && !e.message.includes('SELECT secret'),
    );
    assert.equal(f.clients[0].closed, true);
  }
  const waiting = driver({ hold: true });
  await assert.rejects(
    executePostgres(binding, 'SELECT slow', {
      limits: { ...sqlLimits, timeoutMs: 10 },
      loadDriver: waiting.loadDriver,
    }),
    { code: 'SQL_TIMEOUT' },
  );
  assert.equal(waiting.clients[0].closed, true);
  const f = driver({ hold: true }),
    controller = new AbortController();
  const pending = executePostgres(binding, 'SELECT wait', {
    limits: sqlLimits,
    loadDriver: f.loadDriver,
    signal: controller.signal,
  });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(pending, { code: 'SQL_CANCELED' });
  assert.equal(f.clients[0].closed, true);
  const failed = driver({ connectError: new Error('private-password') });
  await assert.rejects(
    executePostgres(binding, 'SELECT 1', { limits: sqlLimits, loadDriver: failed.loadDriver }),
    { code: 'SQL_EXECUTION_FAILED' },
  );
  assert.equal(failed.clients[0].closed, true);
  assert.equal(postgresError({ code: '42501' }).status, 403);
});
