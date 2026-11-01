import assert from 'node:assert/strict';
import { productApiFixture } from './product-api-fixture.mjs';
import { nativeSecret } from './provider-fixture.mjs';

export async function restWorkflowCases(t, transport) {
  let setupFault,
    tableName = 'demo_table';
  const f = await productApiFixture(
    t,
    transport,
    async ({ sql }) => {
      if (setupFault && sql.startsWith('CREATE DATABASE')) return setupFault();
      if (sql.includes('AS recordKind'))
        return {
          body: {
            columns: ['recordKind', 'name', 'type'],
            rows: [{ recordKind: 'table', name: tableName, type: 'BASE TABLE' }],
            rowCount: 1,
          },
        };
    },
    { missingBinding: true },
  );
  const request = async (path, options = {}, status = 200, code) => {
    const r = await f.request(path, options);
    assert.equal(r.status, status, `${options.method || 'GET'} ${path}: ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body.error.code, code);
    assert.equal(JSON.stringify(r.body).includes(nativeSecret), false);
    return r;
  };
  const key = async (scopes, resourceIds = ['*']) => {
    const r = await f.issueKey({ name: 'rest-workflow', scopes, resourceIds, expiresInDays: 7 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const full = await key([
    'resources:read',
    'resources:write',
    'queries:execute',
    'files:read',
    'files:write',
    'files:analyze',
  ]);
  const token = full.secret;
  const reader = await key(['resources:read', 'queries:read', 'files:read']);
  const follow = (r) => new URL(r.headers.get('location'), r.url).pathname;
  const parsing = { format: 'csv', header: true, delimiter: ',' };
  const prep = async () =>
    request(
      '/database-import-preparations?' +
        new URLSearchParams({ resourceId: 'db_live', filename: 'input.csv', ...parsing }),
      {
        method: 'POST',
        token,
        raw: Buffer.from('id,label\n001,alice\n'),
        headers: { 'Content-Type': 'application/octet-stream' },
      },
      201,
    );
  const commit = (review) => ({
    resourceId: 'db_live',
    preparationId: review.id,
    confirmed: true,
    table: 'reviewed_import',
    fields: review.fields,
  });
  const setup = (id, idem, access = token) =>
    request(
      `/resources/${id}/setup-attempts`,
      { method: 'POST', token: access, headers: { 'Idempotency-Key': idem } },
      201,
    );

  await t.test(
    'one import collection creates both media representations with followable review identity',
    async () => {
      const uploaded = await prep();
      assert.equal(uploaded.body.status, 'ready');
      assert.equal(uploaded.body.rows[0].id, '001');
      assert.ok(Date.parse(uploaded.body.expiresAt) > Date.parse(uploaded.body.createdAt));
      const location = follow(uploaded);
      assert.equal(
        location,
        `/api/v1/workspaces/ws_agentlab/database-import-preparations/${uploaded.body.id}`,
      );
      assert.equal(
        new URL(
          uploaded.headers.get('location'),
          'https://regional.example/proxy/api/v1/workspaces/ws_agentlab/database-import-preparations',
        ).pathname,
        `/proxy/api/v1/workspaces/ws_agentlab/database-import-preparations/${uploaded.body.id}`,
      );
      let before = f.provider.calls;
      assert.deepEqual((await request(location, { token })).body, uploaded.body);
      assert.equal(f.provider.calls, before);
      await request(location, { token: reader.secret }, 404, 'PREPARATION_NOT_FOUND');
      const cross = await f.request(location.replace('ws_agentlab', 'ws_other'), {}, 1);
      assert.equal(cross.status, 404);
      const wrongCollection = location.replace(
        'database-import-preparations',
        'file-export-preparations',
      );
      await request(wrongCollection, { token }, 404, 'PREPARATION_NOT_FOUND');
      const saved = await request(
        '/database-import-preparations',
        {
          method: 'POST',
          token,
          body: {
            resourceId: 'db_live',
            source: { resourceId: 'fs_live', path: '/live.csv' },
            parsing,
          },
        },
        201,
      );
      assert.notEqual(saved.body.id, uploaded.body.id);
      before = f.provider.calls;
      await request(follow(saved), { token });
      assert.equal(f.provider.calls, before);
      await request(
        '/database-import-preparations?resourceId=db_live',
        {
          method: 'POST',
          token,
          body: {
            resourceId: 'db_live',
            source: { resourceId: 'fs_live', path: '/live.csv' },
            parsing,
          },
        },
        400,
        'INVALID_IMPORT',
      );
      await request(location, { method: 'DELETE', token }, 204);
      await request(location, { token }, 404, 'PREPARATION_NOT_FOUND');
      await request(
        '/database-imports',
        { method: 'POST', token, body: commit(uploaded.body) },
        409,
        'IMPORT_PREPARATION_UNAVAILABLE',
      );
      await request('/database-imports', { method: 'POST', token, body: commit(saved.body) });
      assert.equal((await request(follow(saved), { token })).body.status, 'consumed');
      before = f.provider.statements.length;
      await request(follow(saved), { method: 'DELETE', token }, 409, 'IMPORT_ALREADY_COMMITTED');
      await request(
        '/database-imports',
        { method: 'POST', token, body: commit(saved.body) },
        409,
        'IMPORT_ALREADY_COMMITTED',
      );
      assert.equal(f.provider.statements.length, before);
    },
  );

  await t.test('cancellation and confirmation cannot both win', async () => {
    const review = await prep();
    const before = f.provider.statements.length;
    const [cancelled, confirmed] = await Promise.all([
      f.request(follow(review), { method: 'DELETE', token }),
      f.request('/database-imports', {
        method: 'POST',
        token,
        body: { ...commit(review.body), table: 'cancel_race' },
      }),
    ]);
    if (cancelled.status === 204) {
      assert.equal(confirmed.status, 409);
      assert.equal(f.provider.statements.length, before);
    } else {
      assert.equal(cancelled.status, 409);
      assert.equal(confirmed.status, 200);
      assert.equal(f.provider.statements.length, before + 2);
    }
  });
  await t.test('export reviews are addressable, currently authorized and cancellable', async () => {
    const created = await request(
      '/file-export-preparations',
      {
        method: 'POST',
        token,
        body: {
          source: {
            kind: 'output',
            resourceId: 'fs_live',
            stream: 'stdout',
            text: 'line one\nline two\n',
          },
          parsing: { format: 'lines' },
        },
      },
      201,
    );
    const location = follow(created),
      before = f.provider.calls;
    assert.deepEqual((await request(location, { token })).body, created.body);
    assert.equal(f.provider.calls, before);
    await request(location, { token: reader.secret }, 404, 'PREPARATION_NOT_FOUND');
    await request(location, { method: 'DELETE', token }, 204);
    await request(location, { token }, 404, 'PREPARATION_NOT_FOUND');
    // Escaped JSON exceeds the ordinary 1 MiB envelope, while decoded and parsed data fit.
    const quoted = await request(
      '/file-export-preparations',
      {
        method: 'POST',
        token,
        body: {
          source: {
            kind: 'output',
            resourceId: 'fs_live',
            stream: 'stdout',
            text: 'c\n"' + '""'.repeat(270000) + '"\n',
          },
          parsing,
        },
      },
      201,
    );
    assert.equal(quoted.body.rowCount, 1);
    assert.equal(quoted.body.rows[0].c.length, 270000);
    await request(follow(quoted), { method: 'DELETE', token }, 204);
    const restricted = await key(['queries:execute'], ['db_live']);
    const review = await request(
      '/database-import-preparations?' +
        new URLSearchParams({ resourceId: 'db_live', filename: 'x.csv', ...parsing }),
      {
        method: 'POST',
        token: restricted.secret,
        raw: Buffer.from('id\n1\n'),
        headers: { 'Content-Type': 'application/octet-stream' },
      },
      201,
    );
    assert.equal((await f.revokeKey(restricted.data.id)).status, 202);
    await request(follow(review), { token: restricted.secret }, 401, 'INVALID_CREDENTIAL');
  });

  await t.test(
    'setup creates durable identities, scoped replay, permission denial and bounded history without effects',
    async () => {
      const before = f.provider.calls;
      await request(
        '/resources/db_live/setup-attempts',
        { method: 'POST', token },
        400,
        'INVALID_IDEMPOTENCY_KEY',
      );
      await request(
        '/resources/db_live/setup-attempts',
        { method: 'POST', token, headers: { 'Idempotency-Key': 'body' }, body: {} },
        400,
        'INVALID_BODY',
      );
      const missingKeys = ['bindings/db9/db_missing', 'credentials/db9/db_missing'];
      const missingBefore = await f.records(missingKeys);
      const missing = await setup('db_missing', 'missing');
      assert.equal(missing.body.data.status, 'failed');
      assert.equal(missing.body.data.errorCode, 'SETUP_NOT_RESUMABLE');
      assert.deepEqual(await f.records(missingKeys), missingBefore);
      const [first, replay] = await Promise.all([
        setup('db_live', 'same'),
        setup('db_live', 'same'),
      ]);
      assert.deepEqual(first.body, replay.body);
      assert.equal(first.body.data.status, 'succeeded');
      const location = follow(first);
      assert.equal(
        location,
        `/api/v1/workspaces/ws_agentlab/resources/db_live/setup-attempts/${first.body.data.id}`,
      );
      assert.deepEqual((await request(location, { token: reader.secret })).body, first.body);
      const second = await setup('db_live', 'second');
      assert.notEqual(second.body.data.id, first.body.data.id);
      const foreignActor = await setup(
        'db_live',
        'same',
        (await key(['resources:write'], ['db_live'])).secret,
      );
      assert.notEqual(foreignActor.body.data.id, first.body.data.id);
      assert.notEqual((await setup('db_pg', 'same')).body.data.id, first.body.data.id);
      assert.equal(f.provider.calls, before);
      const page = await request('/resources/db_live/setup-attempts?limit=1', {
        token: reader.secret,
      });
      assert.equal(page.body.data.length, 1);
      assert.equal(typeof page.body.nextCursor, 'string');
      const next = await request(
        '/resources/db_live/setup-attempts?' +
          new URLSearchParams({ limit: '100', cursor: page.body.nextCursor }),
        { token: reader.secret },
      );
      assert.equal(next.body.nextCursor, null);
      assert.equal(new Set([...page.body.data, ...next.body.data].map((a) => a.id)).size, 3);
      for (const query of ['limit=0', 'limit=101', 'cursor=bad', 'extra=value'])
        await request(
          '/resources/db_live/setup-attempts?' + query,
          { token },
          400,
          'INVALID_PAGINATION',
        );
      await request(
        '/resources/db_live/setup-attempts',
        { method: 'POST', token: reader.secret, headers: { 'Idempotency-Key': 'denied' } },
        403,
        'INSUFFICIENT_SCOPE',
      );
      const excluded = await key(['resources:read', 'resources:write'], ['fs_shared']);
      await request(location, { token: excluded.secret }, 403, 'RESOURCE_ACCESS_DENIED');
      assert.equal(
        (await f.request(location.replace('ws_agentlab', 'ws_other'), { token }, 1)).status,
        401,
      );
      assert.equal(f.provider.calls, before);
      for (const crash of [false, true]) {
        const ephemeral = await prep();
        await f.restart({ crash });
        await request(follow(ephemeral), { token }, 404, 'PREPARATION_NOT_FOUND');
        assert.deepEqual((await setup('db_live', 'same')).body, first.body);
        assert.deepEqual((await request(location, { token })).body, first.body);
        assert.equal(f.provider.calls, before);
      }
    },
  );

  await t.test(
    'safe setup resumes saved bindings and unknown creation is reconciled without replacement',
    async () => {
      setupFault = () => ({ status: 503, body: { error: { code: 'SQL_EXECUTION_FAILED' } } });
      const resource = await request(
        '/resources',
        {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': 'partial-setup-resource' },
          body: { name: 'partial-setup', kind: 'mysql', region: 'automatic' },
        },
        201,
      );
      assert.notEqual(resource.body.data.status, 'active');
      const id = resource.body.data.id;
      const keys = [`bindings/zero/${id}`, `credentials/zero/${id}`];
      const saved = await f.records(keys),
        creations = { ...f.provider.nativeCreates };
      setupFault = undefined;
      const completed = await setup(id, 'resume');
      assert.equal(completed.body.data.status, 'succeeded');
      assert.equal(completed.body.data.resource.id, id);
      const after = await f.records(keys);
      assert.deepEqual(after[keys[1]].value.connection, saved[keys[1]].value.connection);
      assert.equal(after[keys[0]].value.instanceId, saved[keys[0]].value.instanceId);
      assert.deepEqual(f.provider.nativeCreates, creations);
      f.provider.lost = true;
      const unknown = await request(
        '/resources',
        {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': 'lost-resource' },
          body: { name: 'lost-setup', kind: 'mysql', region: 'automatic' },
        },
        201,
      );
      f.provider.lost = false;
      const attempts = await setup(unknown.body.data.id, 'unknown');
      assert.equal(attempts.body.data.status, 'outcome-unknown');
      const before = f.provider.calls;
      await f.restart({ crash: true });
      assert.deepEqual((await setup(unknown.body.data.id, 'unknown')).body, attempts.body);
      assert.equal(f.provider.calls, before);
    },
  );

  await t.test(
    'a crash during setup retains the pre-effect journal and never replays it',
    async () => {
      setupFault = () => ({ status: 503, body: { error: { code: 'SQL_EXECUTION_FAILED' } } });
      const resource = await request(
        '/resources',
        {
          method: 'POST',
          token,
          headers: { 'Idempotency-Key': 'crash-resource' },
          body: { name: 'crash-setup', kind: 'mysql', region: 'automatic' },
        },
        201,
      );
      const id = resource.body.data.id;
      let entered, release;
      const started = new Promise((r) => {
        entered = r;
      });
      const blocked = new Promise((r) => {
        release = r;
      });
      setupFault = async () => {
        entered();
        await blocked;
        return undefined;
      };
      const active = setup(id, 'crashed').catch((error) => ({ error }));
      await started;
      const observed = await request(`/resources/${id}/setup-attempts`, { token });
      assert.equal(observed.body.data.length, 1);
      assert.equal(observed.body.data[0].status, 'outcome-unknown');
      const before = f.provider.statements.length;
      try {
        await f.restart({ crash: true });
      } finally {
        release();
      }
      await active;
      setupFault = undefined;
      const replay = await setup(id, 'crashed');
      assert.deepEqual(replay.body.data, observed.body.data[0]);
      assert.equal(f.provider.statements.length, before);
      assert.equal((await setup(id, 'explicit-new-attempt')).body.data.status, 'succeeded');
    },
  );

  await t.test(
    'encoded table identity is decoded exactly once, including reserved-looking names',
    async () => {
      for (const name of [
        'setup',
        'table',
        'rows',
        'report/setup',
        'literal%2Fname',
        'quote` /百分号',
      ]) {
        tableName = name;
        const details = await request(`/resources/db_live/tables/${encodeURIComponent(name)}`, {
          token,
        });
        assert.equal(details.body.name, name);
        assert.equal(
          details.body.query,
          `SELECT * FROM \`${name.replaceAll('`', '``')}\` LIMIT 100;`,
        );
      }
      const before = f.provider.calls;
      for (const encoded of ['%', '%GG', '%FF'])
        await request(`/resources/db_live/tables/${encoded}`, { token }, 400, 'INVALID_TABLE_NAME');
      assert.equal(f.provider.calls, before);
    },
  );

  await t.test(
    'removed command and DELETE-body routes return 404 before upstream I/O',
    async () => {
      const before = f.provider.calls;
      const paths = [
        ['/database-imports/prepare', 'POST'],
        ['/database-imports/prepare-upload', 'POST'],
        ['/file-exports/prepare', 'POST'],
        ['/resources/db_live/setup', 'POST'],
        ['/resources/db_live/table?name=demo_table', 'GET'],
        ['/resources/db_live/table/rows?name=demo_table', 'GET'],
        ['/files', 'DELETE'],
      ];
      for (const [path, method] of paths)
        await request(
          path,
          { method, token, ...(method === 'GET' ? {} : { body: {} }) },
          404,
          'NOT_FOUND',
        );
      await request(
        '/database-imports/prepare-upload',
        {
          method: 'POST',
          token,
          raw: Buffer.from('id\n1\n'),
          headers: { 'Content-Type': 'application/octet-stream' },
        },
        404,
        'NOT_FOUND',
      );
      assert.equal(f.provider.calls, before);
    },
  );
}
