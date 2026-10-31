import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

export const nativeSecret = 'private-native-token-not-for-public-output';

export async function providerFixture({ isolatedTenants = false } = {}) {
  const files = new Map();
  let statements = [];
  let creates = 0;
  let calls = 0;
  let lost = false;
  const databases = [];
  const fileTenants = new Map();
  const deleted = [];
  let nativeCreates = { zero: 0, db9: 0, account: 0 };
  const reset = () => {
    files.clear();
    files.set('/live.csv', Buffer.from('name,n\nalice,1\nbob,2\n'));
    files.set('/binary.bin', Buffer.from([0, 255, 13, 10]));
    statements = [];
    creates = 0;
    calls = 0;
  };
  reset();
  const sql = (binding, statement) => {
    statements.push(statement);
    if (/FROM pg_roles/i.test(statement))
      return {
        columns: ['rolsuper', 'rolcreatedb', 'rolcreaterole'],
        rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }],
        rowCount: 1,
        affectedRows: 0,
      };
    if (statement.includes('AS owned'))
      return { columns: ['owned'], rows: [{ owned: true }], rowCount: 1, affectedRows: 0 };
    if (statement.includes('AS recordKind')) {
      assert.equal(statement.match(/TABLE_SCHEMA = DATABASE\(\)/g)?.length, 3);
      return {
        columns: ['recordKind', 'name', 'type'],
        rows: [
          {
            recordKind: 'column',
            name: 'id',
            type: 'integer',
            nullable: 'NO',
            defaultValue: null,
            columnKey: 'PRI',
            extra: '',
            position: 1,
          },
          {
            recordKind: 'index',
            name: 'PRIMARY',
            nonUnique: 0,
            columnName: 'id',
            position: 1,
            prefixLength: null,
          },
          { recordKind: 'table', name: 'demo_table', type: 'BASE TABLE' },
        ],
        rowCount: 3,
        affectedRows: 0,
      };
    }
    if (/information_schema\.(TABLES|tables)/.test(statement))
      return {
        columns: ['name', 'type'],
        rows: [{ name: 'demo_table', type: 'BASE TABLE' }],
        rowCount: 1,
        affectedRows: 0,
      };
    if (/information_schema\.(COLUMNS|columns)/.test(statement))
      return {
        columns: ['name', 'type', 'nullable', 'defaultValue', 'columnKey', 'extra', 'position'],
        rows: [
          {
            name: 'id',
            type: 'integer',
            nullable: 'NO',
            defaultValue: null,
            columnKey: 'PRI',
            extra: '',
            position: 1,
          },
        ],
        rowCount: 1,
        affectedRows: 0,
      };
    if (statement.includes('information_schema.STATISTICS'))
      return {
        columns: ['name', 'nonUnique', 'columnName', 'position', 'prefixLength'],
        rows: [
          { name: 'PRIMARY', nonUnique: 0, columnName: 'id', position: 1, prefixLength: null },
        ],
        rowCount: 1,
        affectedRows: 0,
      };
    if (statement.includes('pg_catalog.pg_index'))
      return {
        columns: ['name', 'uniqueValue', 'primaryValue', 'positionKeys'],
        rows: [{ name: 'demo_pkey', uniqueValue: true, primaryValue: true, positionKeys: '1' }],
        rowCount: 1,
        affectedRows: 0,
      };
    if (/^\s*SELECT\s+1/i.test(statement)) {
      const alias = /\bAS\s+([a-z_]+)/i.exec(statement)?.[1] || '?column?';
      return { columns: [alias], rows: [{ [alias]: 1 }], rowCount: 1, affectedRows: 0 };
    }
    if (/^\s*SELECT\s+\*/i.test(statement))
      return { columns: ['id'], rows: [{ id: 1 }], rowCount: 1, affectedRows: 0 };
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: /^\s*INSERT/i.test(statement) ? 1 : 0,
    };
  };
  const server = http.createServer(async (req, res) => {
    calls++;
    const url = new URL(req.url, 'http://localhost');
    const respond = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      if (url.pathname === '/zero') {
        nativeCreates.zero++;
        if (lost) return req.socket.destroy();
        return respond(200, {
          instance: {
            id: 'mysql-created',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            connection: {
              host: 'created.tidbcloud.com',
              port: 4000,
              username: 'prefix.root',
              password: nativeSecret,
            },
          },
        });
      }
      if (url.pathname === '/customer/anonymous-register') {
        nativeCreates.account++;
        return respond(200, {
          anonymous_id: 'account',
          anonymous_secret: nativeSecret,
          token: 'account-token',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
        });
      }
      if (url.pathname === '/customer/databases' && req.method === 'POST') {
        nativeCreates.db9++;
        let chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks));
        const id = 'pg' + databases.length;
        databases.push({
          id,
          name: body.name,
          connection_string: `postgresql://${id}.admin@pg.db9.io:5432/postgres`,
          admin_password: body.admin_password,
        });
        if (lost) return req.socket.destroy();
        return respond(200, databases.at(-1));
      }
      if (url.pathname === '/customer/databases') return respond(200, databases);
      if (url.pathname.startsWith('/customer/databases/') && req.method === 'DELETE') {
        if (req.headers.authorization !== 'Bearer account-token') return respond(403, {});
        deleted.push({ kind: 'db9', id: url.pathname.split('/').at(-1) });
        return respond(200, { message: 'Database disabled' });
      }
      if (url.pathname.startsWith('/customer/databases/'))
        return respond(
          200,
          databases.find((d) => d.id === url.pathname.split('/').at(-1)),
        );
      if (url.pathname === '/sql') {
        let chunks = [];
        for await (const c of req) chunks.push(c);
        const input = JSON.parse(Buffer.concat(chunks));
        return respond(200, sql(input.binding, input.sql));
      }
      if (url.pathname === '/v1/status')
        return respond(200, {
          status: 'active',
          max_upload_bytes: 1048576,
          inline_threshold: 1048576,
        });
      if (url.pathname === '/v1/provision') {
        creates++;
        if (lost) return req.socket.destroy();
        const key = isolatedTenants ? `file-token-${creates}` : nativeSecret;
        const tenant = isolatedTenants ? `created-tenant-${creates}` : 'created-tenant';
        fileTenants.set(key, tenant);
        return respond(200, { api_key: key, tenant_id: tenant });
      }
      if (url.pathname === '/v1/tenant' && req.method === 'DELETE') {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const tenant = fileTenants.get(token);
        if (!tenant) return respond(403, {});
        deleted.push({ kind: 'drive9', id: tenant });
        return respond(202, { status: 'deleting' });
      }
      if (url.pathname.startsWith('/v1/fs')) {
        const path = decodeURIComponent(url.pathname.slice(6)) || '/';
        if (url.searchParams.get('list') === '1') {
          return respond(200, {
            entries: [...files]
              .filter(([p]) => (p.slice(0, p.lastIndexOf('/')) || '/') === path)
              .map(([p, b]) => ({
                name: p.split('/').pop(),
                size: b.length,
                isDir: false,
                mtime: 1770000000,
              })),
          });
        }
        if (req.method === 'PUT') {
          let chunks = [];
          for await (const c of req) chunks.push(c);
          if (req.headers['x-dat9-expected-revision'] === '0' && files.has(path))
            return respond(409, { error: 'exists' });
          files.set(path, Buffer.concat(chunks));
          return respond(200, {});
        }
        if (req.method === 'DELETE') {
          if (!files.has(path)) return respond(404, {});
          files.delete(path);
          return respond(200, {});
        }
        const b = files.get(path);
        if (!b) return respond(404, {});
        const revision = '"' + createHash('sha256').update(b).digest('hex') + '"';
        if (req.headers['if-match'] && req.headers['if-match'] !== revision)
          return respond(412, {});
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': b.length,
          'X-Dat9-IsDir': 'false',
          ETag: revision,
        });
        return res.end(req.method === 'HEAD' ? undefined : b);
      }
      return respond(404, {});
    } catch {
      respond(500, {});
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    reset,
    set lost(value) {
      lost = value;
    },
    get nativeCreates() {
      return nativeCreates;
    },
    get deleted() {
      return [...deleted];
    },
    get statements() {
      return statements;
    },
    get creates() {
      return creates;
    },
    get calls() {
      return calls;
    },
    close: () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  };
}
