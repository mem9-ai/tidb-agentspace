import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { executeNativeSql } from './providers/sql-drivers.mjs';
import { sqlLimits } from './providers/starter-sql.mjs';

function fakeDriver(kind, behavior) {
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
      const query = kind === 'mysql' ? new Query({ text: input }) : input;
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

for (const kind of ['mysql', 'postgresql']) {
  const binding = {
    kind,
    host: 'gateway.test.tidbcloud.com',
    port: 4000,
    user: 'app',
    password: 'private',
    database: 'app',
  };
  test(`${kind}: fresh TLS sessions stream results, preserve values and close after each query`, async () => {
    const driver = fakeDriver(kind, (query) => {
      const fields = [{ name: 'n' }, { name: 'n' }];
      if (kind === 'mysql') {
        query.emit('fields', fields);
        query.emit('result', ['9007199254740993', null]);
        query.emit('end');
      } else {
        query.emit('row', ['9007199254740993', null], { fields });
        query.emit('end', { fields, command: 'SELECT', rowCount: 1 });
      }
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
      if (kind === 'mysql') {
        assert.equal(client.config.ssl.verifyIdentity, true);
        assert.equal(client.config.multipleStatements, false);
        assert.ok(client.config.flags.includes('-LOCAL_FILES'));
      } else {
        assert.equal(client.queryConfig.queryMode, 'extended');
        assert.equal(client.config.statement_timeout, 15_000);
      }
    }
    assert.equal(driver.clients.length, 2);
  });
  test(`${kind}: row limits, errors, timeouts and canceled requests always close the session`, async () => {
    const overflow = fakeDriver(kind, (query) => {
      const fields = [{ name: 'data' }];
      if (kind === 'mysql') {
        query.emit('fields', fields);
        query.emit('result', ['x'.repeat(200)]);
      } else query.emit('row', ['x'.repeat(200)], { fields });
    });
    await assert.rejects(
      executeNativeSql(binding, 'SELECT data', {
        limits: { ...sqlLimits, bytes: 100 },
        loadDriver: overflow.loadDriver,
      }),
      { code: 'RESULT_TOO_LARGE' },
    );
    assert.ok(overflow.clients[0].closed);
    const error = fakeDriver(kind, (query) =>
      query.emit('error', {
        code: kind === 'mysql' ? 'ER_PARSE_ERROR' : '42601',
        message: 'private',
      }),
    );
    await assert.rejects(
      executeNativeSql(binding, 'broken', { limits: sqlLimits, loadDriver: error.loadDriver }),
      { code: 'SQL_SYNTAX_ERROR' },
    );
    assert.ok(error.clients[0].closed);
    const waiting = fakeDriver(kind, () => {});
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
