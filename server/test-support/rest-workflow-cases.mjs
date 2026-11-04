import assert from 'node:assert/strict';
import { productApiFixture } from './product-api-fixture.mjs';
import { nativeSecret } from './provider-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { revokeAndConfirmRegion } from './revoke-confirm.mjs';

export async function restWorkflowCases(t, transport) {
  let tableName = 'demo_table';
  const f = await productApiFixture(
    t,
    transport,
    async ({ sql }) => {
      if (/FROM information_schema\.tables/i.test(sql))
        return {
          body: {
            columns: ['name', 'type'],
            rows: [{ name: tableName, type: 'BASE TABLE' }],
            rowCount: 1,
          },
        };
    },
    { missingBinding: true },
  );
  const request = async (path, options = {}, status = 200, code) => {
    const before = f.provider.calls;
    let r = await f.request(path, options);
    // This fixture seeds legacy records without resource indexes. Backfill is bounded by
    // the API, not guaranteed to finish within its first 250 ms budget on a shared runner.
    // Only the explicit pre-effect migration response permits this same-intent retry.
    for (
      let attempt = 0;
      attempt < 200 &&
      path === '/resources' &&
      options.method === 'POST' &&
      status === 201 &&
      r.status === 503 &&
      r.body.error?.code === 'RESOURCE_INDEX_MIGRATING';
      attempt++
    ) {
      assert.ok(options.headers?.['Idempotency-Key']);
      assert.equal(f.provider.calls, before, 'Migration must not perform provider I/O');
      await delay(25);
      r = await f.request(path, options);
    }
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
      const otherKey = await f.issueKey(
        {
          name: 'other-workspace-reader',
          scopes: ['resources:read'],
          resourceIds: ['*'],
          expiresInDays: 7,
        },
        1,
      );
      assert.equal(otherKey.status, 201);
      const cross = await f.request(
        location.replace('ws_agentlab', 'ws_other'),
        { token: otherKey.body.secret },
        1,
      );
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
    await revokeAndConfirmRegion(f, restricted.data);
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
    'PostgreSQL setup resumes saved bindings and reconciles unknown creation without replacement',
    async (child) => {
      let failSetup = true;
      const fixture = await productApiFixture(
        child,
        transport,
        async ({ sql }) => {
          if (failSetup && sql.startsWith('CREATE SCHEMA'))
            return { status: 503, body: { error: { code: 'SQL_EXECUTION_FAILED' } } };
        },
        { fresh: true },
      );
      const create = (name, idempotency) =>
        fixture.request('/resources', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotency },
          body: { name, kind: 'postgresql', region: 'automatic' },
        });
      const setup = (id, idempotency) =>
        fixture.request(`/resources/${id}/setup-attempts`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotency },
        });
      const resource = await create('partial-setup', 'partial-resource');
      assert.equal(resource.status, 201, JSON.stringify(resource.body));
      assert.notEqual(resource.body.data.status, 'active');
      const id = resource.body.data.id;
      const keys = [`bindings/db9/${id}`, `credentials/db9/${id}`];
      const saved = await fixture.records(keys);
      const creations = { ...fixture.provider.nativeCreates };
      failSetup = false;
      const completed = await setup(id, 'resume');
      assert.equal(completed.status, 201, JSON.stringify(completed.body));
      assert.equal(completed.body.data.status, 'succeeded');
      const after = await fixture.records(keys);
      assert.deepEqual(after[keys[1]].value.connection, saved[keys[1]].value.connection);
      assert.equal(after[keys[0]].value.instanceId, saved[keys[0]].value.instanceId);
      assert.deepEqual(fixture.provider.nativeCreates, creations);
      fixture.provider.lost = true;
      const unknown = await create('lost-setup', 'lost-resource');
      fixture.provider.lost = false;
      assert.equal(unknown.status, 201, JSON.stringify(unknown.body));
      assert.notEqual(unknown.body.data.status, 'active');
      const recovered = await setup(unknown.body.data.id, 'reconcile');
      assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
      assert.equal(recovered.body.data.status, 'succeeded');
      const before = fixture.provider.calls;
      await fixture.restart({ crash: true });
      assert.deepEqual((await setup(unknown.body.data.id, 'reconcile')).body, recovered.body);
      assert.equal(fixture.provider.calls, before);
    },
  );

  await t.test(
    'a crash during PostgreSQL setup never replays an uncertain write',
    async (child) => {
      let setupFault = () => ({ status: 503, body: { error: { code: 'SQL_EXECUTION_FAILED' } } });
      const fixture = await productApiFixture(
        child,
        transport,
        async ({ sql }) => {
          if (setupFault && sql.startsWith('CREATE SCHEMA')) return setupFault();
        },
        { fresh: true },
      );
      const resource = await fixture.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'crash-resource' },
        body: { name: 'crash-setup', kind: 'postgresql', region: 'automatic' },
      });
      assert.equal(resource.status, 201, JSON.stringify(resource.body));
      const id = resource.body.data.id;
      const setup = (key) =>
        fixture.request(`/resources/${id}/setup-attempts`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
        });
      let entered, release;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      setupFault = async () => {
        entered();
        await blocked;
        return undefined;
      };
      const active = setup('crashed').catch((error) => ({ error }));
      await started;
      const observed = await fixture.request(`/resources/${id}/setup-attempts`);
      assert.equal(observed.status, 200);
      assert.equal(observed.body.data.length, 1);
      assert.equal(observed.body.data[0].status, 'outcome-unknown');
      const before = fixture.provider.statements.length;
      try {
        await fixture.restart({ crash: true });
      } finally {
        release();
      }
      await active;
      setupFault = undefined;
      const replay = await setup('crashed');
      assert.deepEqual(replay.body.data, observed.body.data[0]);
      assert.equal(fixture.provider.statements.length, before);
      const next = await setup('explicit-new-attempt');
      assert.equal(next.body.data.status, 'succeeded');
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
        'quote" /百分号',
      ]) {
        tableName = name;
        const details = await request(`/resources/db_live/tables/${encodeURIComponent(name)}`, {
          token,
        });
        assert.equal(details.body.name, name);
        assert.equal(
          details.body.query,
          `SELECT * FROM "workspace"."${name.replaceAll('"', '""')}" LIMIT 100;`,
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
