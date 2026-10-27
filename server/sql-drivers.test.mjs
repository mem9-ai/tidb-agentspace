import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { executeNativeSql } from './providers/sql-drivers.mjs';
import { sqlLimits } from './providers/sql-common.mjs';

function fakeDriver(behavior) {
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
      this.closed = false;
      clients.push(this);
    }
    async connect() {}
    query(input) {
      const query = new Query({ text: input });
      this.queryConfig = query.config;
      queueMicrotask(() => behavior(query));
      return query;
    }
    destroy() {
      this.closed = true;
    }
    async end() {
      this.closed = true;
    }
  }
  return {
    clients,
    loadDriver: async () => ({ Client, Query, createConnection: (config) => new Client(config) }),
  };
}

for (const kind of ['mysql']) {
  const binding = {
    kind,
    host: 'gateway.test.tidbcloud.com',
    port: 4000,
    user: 'app',
    password: 'private',
    database: 'app',
  };
  test(`${kind}: fresh TLS sessions stream results, preserve values and close after each query`, async () => {
    const driver = fakeDriver((query) => {
      const fields = [{ name: 'n' }, { name: 'n' }];
      query.emit('fields', fields);
      query.emit('result', ['9007199254740993', null]);
      query.emit('end');
    });
    for (let i = 0; i < 2; i++) {
      const result = await executeNativeSql(binding, "SELECT ';', NULL", {
        limits: sqlLimits,
        loadDriver: driver.loadDriver,
      });
      assert.deepEqual(result.rows, [{ n: '9007199254740993', n_2: null }]);
      const client = driver.clients[i];
      assert.equal(client.closed, true);
      assert.equal(client.config.ssl.rejectUnauthorized, true);
      assert.equal(client.config.ssl.verifyIdentity, true);
      assert.equal(client.config.multipleStatements, false);
      assert.ok(client.config.flags.includes('-LOCAL_FILES'));
    }
    assert.equal(driver.clients.length, 2);
  });
  test(`${kind}: row limits, errors, timeouts and canceled requests always close the session`, async () => {
    const overflow = fakeDriver((query) => {
      const fields = [{ name: 'data' }];
      query.emit('fields', fields);
      query.emit('result', ['x'.repeat(200)]);
    });
    await assert.rejects(
      executeNativeSql(binding, 'SELECT data', {
        limits: { ...sqlLimits, bytes: 100 },
        loadDriver: overflow.loadDriver,
      }),
      { code: 'RESULT_TOO_LARGE' },
    );
    assert.ok(overflow.clients[0].closed);
    const error = fakeDriver((query) =>
      query.emit('error', {
        code: 'ER_PARSE_ERROR',
        message: 'private',
      }),
    );
    await assert.rejects(
      executeNativeSql(binding, 'broken', { limits: sqlLimits, loadDriver: error.loadDriver }),
      { code: 'SQL_SYNTAX_ERROR' },
    );
    assert.ok(error.clients[0].closed);
    const waiting = fakeDriver(() => {});
    await assert.rejects(
      executeNativeSql(binding, 'SELECT slow()', {
        limits: { ...sqlLimits, timeoutMs: 20 },
        loadDriver: waiting.loadDriver,
      }),
      { code: 'SQL_TIMEOUT' },
    );
    assert.ok(waiting.clients[0].closed);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeNativeSql(binding, 'SELECT 1', {
        limits: sqlLimits,
        signal: controller.signal,
        loadDriver: waiting.loadDriver,
      }),
      { code: 'SQL_CANCELED' },
    );
    assert.equal(waiting.clients.length, 1);
  });
}

test('MySQL DDL/DML completion accepts the driver undefined fields event and affected rows', async () => {
  const driver = fakeDriver((query) => {
    query.emit('fields', undefined);
    query.emit('result', { affectedRows: 2 });
    query.emit('end');
  });
  const result = await executeNativeSql({ kind: 'mysql' }, 'UPDATE tasks SET done = true', {
    limits: sqlLimits,
    loadDriver: driver.loadDriver,
  });
  assert.deepEqual(result, { columns: [], rows: [], rowCount: 0, affectedRows: 2 });
  assert.ok(driver.clients[0].closed);
});
