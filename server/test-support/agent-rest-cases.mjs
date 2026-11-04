import assert from 'node:assert/strict';
import { productApiFixture } from './product-api-fixture.mjs';
import { nativeSecret } from './provider-fixture.mjs';
import { revokeAndConfirmRegion } from './revoke-confirm.mjs';

export async function agentRestCases(t, transport) {
  const f = await productApiFixture(t, transport);
  const request = async (
    path,
    options = {},
    status = options.method === 'POST' && path.split('?')[0].endsWith('-preparations') ? 201 : 200,
    code,
  ) => {
    const r = await f.request(path, options);
    assert.equal(r.status, status, `${options.method || 'GET'} ${path}: ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body.error.code, code);
    assert.equal(JSON.stringify(r.body).includes(nativeSecret), false);
    return r;
  };
  const key = async (
    scopes,
    resourceIds = ['fs_shared', 'fs_live', 'db_live', 'db_pg', 'db_duck'],
  ) => {
    const r = await f.issueKey({ name: 'agent-p0', scopes, resourceIds, expiresInDays: 7 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const reader = await key(['queries:read', 'resources:read', 'files:read', 'files:write']);
  const full = await key([
    'queries:execute',
    'resources:read',
    'resources:write',
    'files:read',
    'files:write',
  ]);
  const token = reader.secret;
  const q = (resourceId, sql, access = token, extra = {}) => ({
    method: 'POST',
    token: access,
    body: { resourceId, sql, ...extra },
  });
  const metadata = (resourceId, path) =>
    '/files/metadata?' + new URLSearchParams({ resourceId, path });
  const write = (resourceId, path, content, headers = {}) => ({
    method: 'PUT',
    token,
    body: { resourceId, path, content, type: 'file' },
    headers,
  });

  await t.test('resource pages remain bounded and enforce grants on every request', async () => {
    const selected = await key(['resources:read'], ['db_live', 'fs_shared']);
    let cursor;
    const ids = [];
    do {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      const page = (await request(`/resources?${query}`, { token: selected.secret })).body;
      assert.ok(page.data.length <= 1);
      ids.push(...page.data.map((resource) => resource.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, ['db_live', 'fs_shared']);
    assert.equal(
      (await f.request('/resources?limit=1', { token: selected.secret }, 1)).status,
      401,
    );
    await request('/resources?limit=0', { token: selected.secret }, 400, 'INVALID_PAGE_LIMIT');
    await request('/resources?limit=513', { token: selected.secret }, 400, 'INVALID_PAGE_LIMIT');
    await request('/resources?cursor=!!!', { token: selected.secret }, 400, 'INVALID_PAGE_CURSOR');
    const forbidden = Buffer.from('db_pg').toString('base64url');
    await request(
      `/resources?cursor=${forbidden}`,
      { token: selected.secret },
      400,
      'INVALID_PAGE_CURSOR',
    );
    const first = (await request('/resources?limit=1', { token: selected.secret })).body;
    await revokeAndConfirmRegion(f, selected.data);
    await request(
      `/resources?cursor=${first.nextCursor}`,
      { token: selected.secret },
      401,
      'INVALID_CREDENTIAL',
    );
  });

  await t.test(
    'context discovers only the authenticated principal without widening grants',
    async () => {
      const minimal = await key(['queries:read'], ['db_live']);
      const context = (await request('/context', { token: minimal.secret })).body;
      const { expiresAt, ...principal } = context.principal;
      assert.equal(Date.parse(expiresAt), minimal.accessExpiresAt * 1000);
      assert.deepEqual(principal, {
        id: minimal.data.principalId,
        kind: 'workspaceKey',
        scopes: ['queries:read'],
        resourceIds: ['db_live'],
      });
      assert.equal(context.workspaceId, 'ws_agentlab');
      assert.equal(context.permissions.manageKeys, false);
      assert.equal(context.permissions.createResources, false);
      assert.equal(context.links.self, '/api/v1/workspaces/ws_agentlab/context');
      assert.equal(JSON.stringify(context).includes(full.data.id), false);
      assert.equal(JSON.stringify(context).includes('digest'), false);
      const implicit = (await request('/context', { token: full.secret })).body;
      assert.ok(implicit.principal.scopes.includes('queries:read'));
      for (const access of [null, 'bad-key', 'expired-coverage-key', 'revoked-coverage-key'])
        await request('/context', { token: access }, 401);
      const cross = await f.request('/context', { token: full.secret }, 1);
      assert.equal(cross.status, 401);
      await revokeAndConfirmRegion(f, minimal.data);
      await request('/context', { token: minimal.secret }, 401, 'INVALID_CREDENTIAL');
    },
  );

  await t.test(
    'read-only SQL permits reads and catalog, rejects hidden writes before I/O',
    async () => {
      await request('/result-exports', {
        method: 'POST',
        token,
        body: {
          sourceResourceId: 'db_live',
          result: { columns: ['id'], rows: [{ id: 1 }] },
          target: { kind: 'download', format: 'json' },
        },
      });
      for (const id of ['db_live', 'db_pg']) {
        await request('/queries', q(id, 'SELECT 1 AS connected'));
        await request(`/resources/${id}/tables`, { token });
        const before = f.provider.calls;
        for (const sql of [
          'INSERT INTO t VALUES (1)',
          'UPDATE t SET id=2',
          'DELETE FROM t',
          'CREATE TABLE t(id int)',
          'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
          'SELECT * INTO copied FROM t',
          'SELECT * FROM t FOR UPDATE',
          "SELECT nextval('s')",
          "SELECT set_config('transaction_read_only','off',false)",
          'SELECT 1; DELETE FROM t',
          "SELECT 1 /*! INTO OUTFILE '/tmp/file' */",
        ])
          await request('/queries', q(id, sql), 403, 'READ_ONLY_SQL_REQUIRED');
        assert.equal(f.provider.calls, before);
        await request(
          '/queries',
          q(id, 'DELETE FROM t', full.secret, { readOnly: true }),
          403,
          'READ_ONLY_SQL_REQUIRED',
        );
        await request(
          '/queries',
          q(id, 'SELECT 1', full.secret, { readOnly: 'true' }),
          400,
          'INVALID_BODY',
        );
      }
      await request(
        '/queries',
        q('db_live', 'SELECT 1', full.secret, { readOnly: null }),
        400,
        'INVALID_BODY',
      );
      await request(
        '/database-import-preparations?resourceId=db_live&filename=x.csv&format=csv&header=true&delimiter=%2C',
        {
          method: 'POST',
          token,
          raw: Buffer.from('id\n1\n'),
          headers: { 'Content-Type': 'application/octet-stream' },
        },
        403,
        'INSUFFICIENT_SCOPE',
      );
      await request(
        '/result-exports',
        {
          method: 'POST',
          token,
          body: {
            sourceResourceId: 'db_live',
            result: { columns: ['id'], rows: [{ id: 1 }] },
            target: { kind: 'database', resourceId: 'db_pg', table: 'forbidden' },
          },
        },
        403,
        'INSUFFICIENT_SCOPE',
      );
    },
  );

  await t.test(
    'local versions compare atomically, including identical content and recreation',
    async () => {
      const path = '/p0-local.txt';
      await request('/files', write('fs_shared', path, 'original', { 'If-None-Match': '*' }));
      const preflight = await request(
        '/files',
        {
          method: 'OPTIONS',
          token: null,
          headers: {
            Origin: 'http://127.0.0.1:5173',
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'authorization, content-type, if-match',
          },
        },
        204,
      );
      assert.match(preflight.headers.get('access-control-allow-headers'), /if-match/);
      let m = await request(metadata('fs_shared', path), {
        token,
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      assert.match(m.headers.get('access-control-expose-headers'), /ETag/i);
      const original = m.body.data.version;
      assert.equal(m.headers.get('etag'), original);
      const writes = await Promise.all(
        ['one', 'two'].map((content) =>
          f.request('/files', write('fs_shared', path, content, { 'If-Match': original })),
        ),
      );
      assert.deepEqual(writes.map((r) => r.status).sort(), [200, 412]);
      m = await request(metadata('fs_shared', path), { token });
      assert.notEqual(m.body.data.version, original);
      await request(
        '/files',
        write('fs_shared', path, 'stale', { 'If-Match': original }),
        412,
        'PRECONDITION_FAILED',
      );
      const version = m.body.data.version;
      const files = (await request('/files?resourceId=fs_shared', { token })).body.data;
      const content = files.find((f) => f.path === path).content;
      await request('/files', write('fs_shared', path, content, { 'If-Match': version }));
      assert.notEqual(
        (await request(metadata('fs_shared', path), { token })).body.data.version,
        version,
      );
      await request('/files', write('fs_shared', path, 'exists', { 'If-None-Match': '*' }), 412);
      await request('/files/entry?' + new URLSearchParams({ resourceId: 'fs_shared', path }), {
        method: 'DELETE',
        token,
      });
      await request('/files', write('fs_shared', path, 'missing', { 'If-Match': version }), 412);
      await request('/files', write('fs_shared', path, 'recreated'));
      await request(
        '/files',
        write('fs_shared', path, 'old incarnation', { 'If-Match': version }),
        412,
      );
      for (const headers of [
        { 'If-Match': '*' },
        { 'If-Match': 'W/"weak"' },
        { 'If-Match': '"one", "two"' },
        { 'If-Match': '"valid"', 'If-None-Match': '*' },
        { 'If-None-Match': 'invalid' },
      ])
        await request(
          '/files',
          write('fs_shared', path, 'invalid', headers),
          400,
          'INVALID_PRECONDITION',
        );
    },
  );

  let retainedVersion;
  await t.test('Drive9 raw and JSON writes use atomic provider revisions', async () => {
    const path = '/live.csv';
    const m = await request(metadata('fs_live', path), { token });
    const version = m.body.data.version;
    assert.equal(m.headers.get('etag'), version);
    assert.equal(m.body.data.conditionalWrites, true);
    const raw = '/files/content?' + new URLSearchParams({ resourceId: 'fs_live', path });
    await request(raw, {
      method: 'PUT',
      token,
      raw: Buffer.from('first'),
      headers: { 'Content-Type': 'application/octet-stream', 'If-Match': version },
    });
    await request('/files', write('fs_live', path, 'stale', { 'If-Match': version }), 412);
    let current = (await request(metadata('fs_live', path), { token })).body.data.version;
    f.provider.writeRace = async (path, files) => {
      files.set(path, Buffer.from('upstream concurrent change'));
    };
    await request(
      '/files',
      write('fs_live', path, 'must not overwrite', { 'If-Match': current }),
      412,
      'PRECONDITION_FAILED',
    );
    assert.equal((await request(raw, { token })).body.toString(), 'upstream concurrent change');
    current = (await request(metadata('fs_live', path), { token })).body.data.version;
    const race = await Promise.all(
      ['left', 'right'].map((content) =>
        f.request('/files', write('fs_live', path, content, { 'If-Match': current })),
      ),
    );
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 412]);
    f.provider.writeRace = async () => ({ status: 404 });
    await request(
      '/files',
      write('fs_live', '/missing-parent/child.txt', 'must not create', { 'If-None-Match': '*' }),
      404,
      'NOT_FOUND',
    );
    retainedVersion = (await request(metadata('fs_live', path), { token })).body.data.version;
    f.provider.versionsAvailable = false;
    const unsupported = await request(metadata('fs_live', path), { token });
    assert.equal(unsupported.body.data.version, null);
    assert.equal(unsupported.body.data.conditionalWrites, false);
    await request(
      '/files',
      write('fs_live', path, 'must not fall back', { 'If-Match': retainedVersion }),
      409,
      'FILE_VERSION_UNAVAILABLE',
    );
    f.provider.versionsAvailable = true;
  });

  await t.test('file validators remain usable after durable crash recovery', async () => {
    const path = '/p0-local.txt';
    const local = (await request(metadata('fs_shared', path), { token })).body.data.version;
    await f.restart({ crash: true });
    assert.equal((await request(metadata('fs_shared', path), { token })).body.data.version, local);
    assert.equal(
      (await request(metadata('fs_live', '/live.csv'), { token })).body.data.version,
      retainedVersion,
    );
    await request('/files', write('fs_shared', path, 'after restart', { 'If-Match': local }));
    await request(
      '/files',
      write('fs_live', '/live.csv', 'after restart', { 'If-Match': retainedVersion }),
    );
    retainedVersion = (await request(metadata('fs_live', '/live.csv'), { token })).body.data
      .version;
  });

  await t.test(
    'detail and deletion enforce actions, grants and Workspace isolation before I/O',
    async () => {
      const detail = (await request('/resources/db_live', { token })).body.data;
      assert.equal(detail.id, 'db_live');
      assert.equal(detail.capabilities.delete, true);
      assert.ok(detail.allowedActions.includes('queries:read'));
      assert.equal(detail.allowedActions.includes('queries:execute'), false);
      const restricted = await key(['resources:read', 'resources:write'], ['fs_shared']);
      const before = f.provider.calls;
      await request(
        '/resources/fs_live',
        { token: restricted.secret },
        403,
        'RESOURCE_ACCESS_DENIED',
      );
      await request(
        '/resources/fs_live',
        { method: 'DELETE', token: restricted.secret },
        403,
        'RESOURCE_ACCESS_DENIED',
      );
      await request('/resources/fs_live', { method: 'DELETE', token }, 403, 'INSUFFICIENT_SCOPE');
      const cross = await f.request(
        '/resources/fs_live',
        { method: 'DELETE', token: full.secret },
        1,
      );
      assert.equal(cross.status, 401);
      assert.equal(f.provider.calls, before);
      await request('/resources/missing', { token: full.secret }, 403, 'RESOURCE_ACCESS_DENIED');
      const oldKey = await key(['resources:read', 'resources:write'], ['db_retired_mysql']);
      const unsupported = await request(
        '/resources/db_retired_mysql',
        { method: 'DELETE', token: oldKey.secret },
        405,
        'RESOURCE_DELETE_UNSUPPORTED',
      );
      assert.equal(unsupported.headers.get('allow'), 'GET');
      assert.match(unsupported.body.error.message, /unchanged/);
      assert.equal((await request('/resources/db_live', { token })).body.data.status, 'active');
    },
  );

  const bindingKeys = [
    'bindings/drive9/fs_live',
    'credentials/drive9/fs_live',
    'bindings/db9/db_live',
    'credentials/db9/db_live',
  ];
  const beforeBindings = await f.records(bindingKeys);
  await t.test(
    'local deletion is repeatable and blocks data access without deleting Keys',
    async () => {
      const response = await request('/resources/fs_shared', {
        method: 'DELETE',
        token: full.secret,
      });
      assert.equal(response.body.data.status, 'deleted');
      assert.equal(response.body.data.deletion.phase, 'completed');
      assert.equal(
        (await request('/resources', { token })).body.data.some((r) => r.id === 'fs_shared'),
        false,
      );
      await request('/resources/fs_shared', { method: 'DELETE', token: full.secret });
      await request('/files?resourceId=fs_shared', { token }, 409, 'RESOURCE_DELETING');
      await request(
        '/files',
        write('fs_shared', '/blocked.txt', 'blocked'),
        409,
        'RESOURCE_DELETING',
      );
      assert.equal(
        (await request('/context', { token })).body.principal.id,
        reader.data.principalId,
      );
      assert.equal(
        (await f.request('/files?resourceId=fs_shared', {}, 1)).body.data[0].content,
        'ws_other',
      );
    },
  );
  await t.test(
    'accepted deletion is retained and never repeats across normal or crash restart',
    async () => {
      let entered, release;
      const pending = new Promise((r) => {
        entered = r;
      });
      const blocked = new Promise((r) => {
        release = r;
      });
      f.provider.writeRace = async () => {
        entered();
        await blocked;
      };
      const writing = request(
        '/files',
        write('fs_live', '/live.csv', 'drained before removal', { 'If-Match': retainedVersion }),
      );
      await pending;
      const deleting = request('/resources/fs_live', { method: 'DELETE', token: full.secret }, 202);
      try {
        const unrelated = await Promise.race([
          request('/resources/db_legacy_local', { method: 'DELETE' }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('unrelated resource deletion was blocked')), 5000),
          ),
        ]);
        assert.equal(unrelated.status, 200);
        assert.equal(
          await Promise.race([
            deleting.then(() => false),
            new Promise((r) => setTimeout(() => r(true), 100)),
          ]),
          true,
        );
        assert.equal(f.provider.deleted.length, 0);
      } finally {
        release();
      }
      await writing;
      const r = await deleting;
      assert.equal(r.body.data.deletion.phase, 'provider-accepted');
      assert.equal(r.headers.get('location'), '/api/v1/workspaces/ws_agentlab/resources/fs_live');
      assert.equal(f.provider.deleted.length, 1);
      for (const crash of [false, true]) {
        await f.restart({ crash });
        await request('/resources/fs_live', { method: 'DELETE', token: full.secret }, 202);
        assert.equal(f.provider.deleted.length, 1);
        assert.equal(
          (await request('/resources/fs_live', { token })).body.data.deletion.phase,
          'provider-accepted',
        );
        await request(
          '/files/content?resourceId=fs_live&path=/live.csv',
          { token },
          409,
          'RESOURCE_DELETING',
        );
        await request('/queries', q('db_live', 'SELECT 1 AS connected'));
        const records = await f.records(bindingKeys);
        for (const name of bindingKeys)
          assert.deepEqual(records[name].value, beforeBindings[name].value);
        assert.equal(
          (await request('/context', { token })).body.principal.id,
          reader.data.principalId,
        );
      }
      assert.equal(f.provider.nativeCreates.zero, 0);
      assert.equal(f.provider.nativeCreates.db9, 0);
      assert.equal(typeof retainedVersion, 'string');
      f.provider.fileStatus = 'deleted';
      assert.equal((await request('/resources/fs_live', { token })).body.data.status, 'deleted');
    },
  );
  await t.test(
    'db9 and private DuckDB storage delete once while retaining credentials',
    async () => {
      for (const id of ['db_pg', 'db_duck']) {
        const r = await request(`/resources/${id}`, { method: 'DELETE', token: full.secret }, 202);
        assert.equal(r.body.data.deletion.phase, 'provider-accepted');
        const before = f.provider.deleted.length;
        await request(`/resources/${id}`, { method: 'DELETE', token: full.secret }, 202);
        assert.equal(f.provider.deleted.length, before);
        await request(
          '/queries',
          q(id, 'SELECT 1'),
          id === 'db_duck' ? 404 : 409,
          id === 'db_duck' ? 'NOT_FOUND' : 'RESOURCE_DELETING',
        );
      }
      assert.ok(f.provider.deleted.some((d) => d.kind === 'db9'));
      const records = await f.records([
        'credentials/db9/db_pg',
        'credentials/drive9/hidden-storage',
        'credentials/accounts/db9',
      ]);
      assert.equal(records['credentials/db9/db_pg'].value.connection.password, nativeSecret);
      assert.equal(records['credentials/drive9/hidden-storage'].value.apiKey, nativeSecret);
      assert.equal(records['credentials/accounts/db9'].value.anonymousSecret, nativeSecret);
    },
  );
  await t.test(
    'lost provider deletion response remains unknown after crash and never retries',
    async () => {
      const uncertain = await productApiFixture(t, transport);
      uncertain.provider.deleteLost = true;
      const before = await uncertain.records([
        'bindings/drive9/fs_live',
        'credentials/drive9/fs_live',
      ]);
      let r = await uncertain.request('/resources/fs_live', { method: 'DELETE' });
      assert.equal(r.status, 202);
      assert.equal(r.body.data.deletion.phase, 'outcome-unknown');
      assert.equal(uncertain.provider.deleted.length, 1);
      await uncertain.restart({ crash: true });
      r = await uncertain.request('/resources/fs_live', { method: 'DELETE' });
      assert.equal(r.status, 202);
      assert.equal(r.body.data.deletion.phase, 'outcome-unknown');
      assert.equal(uncertain.provider.deleted.length, 1);
      const after = await uncertain.records([
        'bindings/drive9/fs_live',
        'credentials/drive9/fs_live',
      ]);
      for (const name of Object.keys(before))
        assert.deepEqual(after[name].value, before[name].value);
      assert.equal(uncertain.provider.nativeCreates.account, 0);
      assert.equal(uncertain.provider.creates, 0);
    },
  );
}
