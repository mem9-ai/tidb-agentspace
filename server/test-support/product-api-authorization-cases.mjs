import assert from 'node:assert/strict';

export async function authorizationCases(
  t,
  { request, key, token, resources, parsing, provider, f },
) {
  await t.test(
    'action/resource/credential denial matrix has no upstream reads or writes',
    async () => {
      const actionOnly = await key('coverage-no-actions', resources, ['resources:read']);
      const resourceOnly = await key('coverage-other-resource', ['fs_shared']);
      const routes = [
        [
          '/queries',
          {
            method: 'POST',
            body: { resourceId: 'db_live', sql: 'INSERT INTO forbidden VALUES (1)' },
          },
        ],
        ['/resources/db_live/tables'],
        ['/resources/db_live/tables/demo_table'],
        ['/resources/db_live/tables/demo_table/rows'],
        ['/files?resourceId=fs_live'],
        [
          '/files',
          {
            method: 'PUT',
            body: {
              resourceId: 'fs_live',
              path: '/forbidden.txt',
              type: 'file',
              content: 'forbidden',
            },
          },
        ],
        [
          '/files/entry?' + new URLSearchParams({ resourceId: 'fs_live', path: '/live.csv' }),
          { method: 'DELETE' },
        ],
        ['/files/content?resourceId=fs_live&path=/binary.bin'],
        [
          '/files/content?resourceId=fs_live&path=/forbidden.bin',
          {
            method: 'PUT',
            raw: Buffer.from('forbidden'),
            headers: { 'Content-Type': 'application/octet-stream' },
          },
        ],
        ['/files/tabular-preview?resourceId=fs_live&path=/live.csv'],
        ['/file-analyses/capabilities?resourceId=fs_live&path=/live.csv'],
        [
          '/file-analyses',
          {
            method: 'POST',
            body: {
              resourceId: 'fs_live',
              path: '/live.csv',
              engine: 'duckdb',
              sql: 'SELECT * FROM file',
            },
          },
        ],
        [
          '/database-import-preparations',
          {
            method: 'POST',
            body: {
              resourceId: 'db_live',
              source: { resourceId: 'fs_live', path: '/live.csv' },
              parsing,
            },
          },
        ],
        [
          '/database-import-preparations?' +
            new URLSearchParams({ resourceId: 'db_live', filename: 'x.csv', ...parsing }),
          {
            method: 'POST',
            raw: Buffer.from('n\n1\n'),
            headers: { 'Content-Type': 'application/octet-stream' },
          },
        ],
        [
          '/result-exports',
          {
            method: 'POST',
            body: {
              sourceResourceId: 'db_live',
              result: { columns: ['n'], rows: [{ n: 1 }] },
              target: {
                kind: 'filesystem',
                resourceId: 'fs_live',
                path: '/forbidden.csv',
                format: 'csv',
              },
            },
          },
        ],
        [
          '/file-exports',
          {
            method: 'POST',
            body: {
              source: { kind: 'original', resourceId: 'fs_live', path: '/live.csv' },
              target: { kind: 'filesystem', resourceId: 'fs_shared', path: '/forbidden.csv' },
            },
          },
        ],
        [
          '/file-export-preparations',
          {
            method: 'POST',
            body: {
              source: { kind: 'original', resourceId: 'fs_live', path: '/live.csv' },
              parsing,
            },
          },
        ],
      ];
      const before = provider.calls;
      for (const [path, options] of routes) {
        await request(path, { ...options, token: actionOnly.secret }, 403, 'INSUFFICIENT_SCOPE');
        await request(
          path,
          { ...options, token: resourceOnly.secret },
          403,
          'RESOURCE_ACCESS_DENIED',
        );
        // These routes share credential parsing. Legacy string keys all fail the same
        // malformed-credential path; real token expiry and revocation are tested separately.
        for (const denied of [null, 'invalid-coverage-key'])
          await request(
            path,
            { ...options, token: denied },
            401,
            denied === null ? 'AGENT_TOKEN_REQUIRED' : 'INVALID_CREDENTIAL',
          );
      }
      await request(
        '/resources',
        {
          method: 'POST',
          token: resourceOnly.secret,
          body: { kind: 'filesystem', name: 'forbidden-resource', region: 'aws-ap-southeast-1' },
        },
        403,
        'WORKSPACE_GRANT_REQUIRED',
      );
      assert.equal(provider.calls, before);
      assert.equal(provider.statements.length, 0);
      assert.deepEqual(
        (await request('/files?resourceId=fs_shared')).body.data.map((file) => file.path),
        ['/identity.txt'],
      );
    },
  );

  await t.test(
    'colliding resource IDs stay isolated across real Workspaces and discovery',
    async () => {
      const selected = await key(
        'coverage-selected',
        ['fs_shared'],
        ['resources:read', 'files:read', 'usage:read'],
      );
      assert.deepEqual(
        (await request('/resources', { token: selected.secret })).body.data.map((r) => r.id),
        ['fs_shared'],
      );
      assert.deepEqual(
        (await request('/usage', { token: selected.secret })).body.data.map((r) => r.resourceId),
        ['fs_shared'],
      );
      assert.equal(
        (await request('/files?resourceId=fs_shared', { token: selected.secret })).body.data[0]
          .content,
        'ws_agentlab',
      );
      assert.equal(
        (await request('/files?resourceId=fs_shared', {}, 200, undefined, 1)).body.data[0].content,
        'ws_other',
      );
      const before = provider.calls;
      await request('/files?resourceId=fs_live', { token }, 401, 'INVALID_CREDENTIAL', 1);
      await request(
        '/api/v1/workspaces/ws_other/files?resourceId=fs_live',
        { token },
        404,
        'NOT_FOUND',
      );
      await request('/keys', { token }, 404, 'NOT_FOUND');
      assert.equal(provider.calls, before);
      const listed = JSON.stringify((await f.listKeys()).body);
      assert.equal(listed.includes(token), false);
      assert.equal(listed.includes('digest'), false);
    },
  );

  await t.test(
    'DuckDB selected sources require independent read/analyze grants and private storage stays hidden',
    async () => {
      const sql = {
        resourceId: 'db_duck',
        sql: 'SELECT * FROM input',
        sources: [{ name: 'input', resourceId: 'fs_live', path: '/live.csv' }],
      };
      const unselected = await key('coverage-db-only', ['db_duck']);
      const readOnly = await key(
        'coverage-source-readonly',
        ['db_duck', 'fs_live'],
        ['queries:execute', 'files:read'],
      );
      const wildcard = await key('coverage-wildcard', ['*']);
      const before = provider.calls;
      await request(
        '/queries',
        { method: 'POST', token: unselected.secret, body: sql },
        403,
        'RESOURCE_ACCESS_DENIED',
      );
      await request(
        '/queries',
        { method: 'POST', token: readOnly.secret, body: sql },
        403,
        'INSUFFICIENT_SCOPE',
      );
      await request(
        '/files?resourceId=hidden-storage',
        { token: wildcard.secret },
        404,
        'NOT_FOUND',
      );
      // Global grants contain explicit IDs; Region validates resource ownership before I/O.
      const privateGrant = await f.issueKey({
        name: 'private-store',
        resourceIds: ['hidden-storage'],
        scopes: ['files:read'],
        expiresInDays: 7,
      });
      assert.equal(privateGrant.status, 503);
      assert.equal(privateGrant.body.error.code, 'POLICY_DELIVERY_UNKNOWN');
      assert.equal(provider.calls, before);
    },
  );
}
