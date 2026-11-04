import assert from 'node:assert/strict';

export async function importCases(
  t,
  { request, key, token, resources, scopes, parsing, provider, upload, commit, f, faults },
) {
  await t.test(
    'imports bind actor, destination, source version and single-use concurrent confirmation',
    async () => {
      const review = (await upload()).body;
      assert.deepEqual(review.rows, [{ id: '001', value: '9007199254740993' }]);
      const other = await key('coverage-second-actor');
      const otherWorkspace = await key('coverage-other-workspace', resources, scopes, 1);
      const body = commit(review, 'coverage_import');
      const before = provider.calls;
      await request(
        '/database-imports',
        { method: 'POST', token: otherWorkspace.secret, body },
        409,
        'IMPORT_PREPARATION_UNAVAILABLE',
        1,
      );
      await request(
        '/database-imports',
        { method: 'POST', token: other.secret, body },
        409,
        'IMPORT_PREPARATION_UNAVAILABLE',
      );
      await request(
        '/database-imports',
        { method: 'POST', token, body: { ...body, resourceId: 'db_pg' } },
        409,
        'IMPORT_TARGET_MISMATCH',
      );
      await request(
        '/database-imports',
        { method: 'POST', token, body: { ...body, confirmed: false } },
        400,
        'INVALID_IMPORT',
      );
      await request(
        '/database-imports',
        {
          method: 'POST',
          token,
          body: {
            ...body,
            fields: review.fields.map((field) => ({ ...field, name: 'duplicate' })),
          },
        },
        400,
        'INVALID_IMPORT_FIELDS',
      );
      assert.equal(provider.calls, before);
      const writes = provider.statements.length;
      const outcomes = await Promise.all([
        f.request('/database-imports', { method: 'POST', token, body }),
        f.request('/database-imports', { method: 'POST', token, body }),
      ]);
      assert.deepEqual(outcomes.map((response) => response.status).sort(), [200, 409]);
      assert.equal(
        outcomes.find((response) => response.status === 409).body.error.code,
        'IMPORT_ALREADY_COMMITTED',
      );
      assert.equal(provider.statements.length - writes, 2);
      for (const id of ['fs_shared', 'fs_live']) {
        const path = '/mutable.csv';
        await request('/files', {
          method: 'PUT',
          token,
          body: { resourceId: id, path, type: 'file', content: 'n\n1\n' },
        });
        const prepared = (
          await request('/database-import-preparations', {
            method: 'POST',
            token,
            body: { resourceId: 'db_live', source: { resourceId: id, path }, parsing },
          })
        ).body;
        await request('/files', {
          method: 'PUT',
          token,
          body: { resourceId: id, path, type: 'file', content: 'n\n2\n' },
        });
        const sqlCount = provider.statements.length;
        await request(
          '/database-imports',
          { method: 'POST', token, body: commit(prepared, 'changed_source') },
          409,
          'FILE_CHANGED',
        );
        assert.equal(provider.statements.length, sqlCount);
      }
    },
  );

  await t.test(
    'import row bounds and reviewed dialect-safe field mappings are enforced before SQL',
    async () => {
      const path =
        '/database-import-preparations?' +
        new URLSearchParams({ resourceId: 'db_live', filename: 'source.csv', ...parsing });
      const before = provider.calls;
      await request(
        path,
        {
          method: 'POST',
          token,
          raw: Buffer.from('n\n' + '1\n'.repeat(1001)),
          headers: { 'Content-Type': 'application/octet-stream' },
        },
        413,
        'IMPORT_ROW_LIMIT',
      );
      assert.equal(provider.calls, before);
      for (const [id, quote] of [
        ['db_live', '"'],
        ['db_pg', '"'],
      ]) {
        const review = (
          await upload(
            id,
            token,
            'text,precise,flag\n"Robert\'); DROP TABLE victims;--",9007199254740993,true\n',
          )
        ).body;
        const fields = review.fields.map((field) => ({
          ...field,
          name: field.source === 'text' ? 'quoted"`field' : field.name,
        }));
        const table = 'quoted"`table';
        const sqlCount = provider.statements.length;
        await request('/database-imports', {
          method: 'POST',
          token,
          body: { ...commit(review, table, id), fields },
        });
        const statements = provider.statements.slice(sqlCount);
        assert.equal(statements.length, 2);
        assert.ok(
          statements[0].startsWith(
            `CREATE TABLE ${quote}${table.replaceAll(quote, quote + quote)}${quote} (`,
          ),
        );
        assert.ok(statements[1].includes('9007199254740993'));
        assert.ok(statements[1].includes('TRUE'));
        assert.equal(
          statements.some((sql) => sql.includes('DROP TABLE victims')),
          false,
        );
        assert.ok(
          statements[1].includes(Buffer.from("Robert'); DROP TABLE victims;--").toString('hex')),
        );
      }
    },
  );

  await t.test(
    'import failures retain unknown outcomes, table-conflict recovery and revocation checks',
    async () => {
      const review = (await upload()).body;
      const body = commit(review, 'partial_import');
      faults.sql = (sql) => (sql.startsWith('INSERT INTO') ? { disconnect: true } : undefined);
      const before = provider.statements.length;
      await request('/database-imports', { method: 'POST', token, body }, 502, 'EXPORT_INCOMPLETE');
      assert.equal(provider.statements.length - before, 2);
      faults.sql = undefined;
      await request(
        '/database-imports',
        { method: 'POST', token, body },
        409,
        'IMPORT_ALREADY_COMMITTED',
      );
      assert.equal(provider.statements.length - before, 2);
      const conflict = (await upload()).body;
      faults.sql = (sql) =>
        sql.startsWith('CREATE TABLE')
          ? { status: 409, body: { error: { code: 'SQL_TABLE_EXISTS' } } }
          : undefined;
      await request(
        '/database-imports',
        { method: 'POST', token, body: commit(conflict, 'occupied') },
        409,
        'SQL_TABLE_EXISTS',
      );
      faults.sql = undefined;
      await request('/database-imports', {
        method: 'POST',
        token,
        body: commit(conflict, 'fresh_name'),
      });
      const revoked = await key('coverage-revoked-mid-import');
      const revokedReview = (await upload('db_live', revoked.secret)).body;
      faults.afterCreate = async () => {
        const revokedAtGlobal = await f.revokeKey(revoked.data.id);
        assert.equal(revokedAtGlobal.status, 202);
        assert.equal(revokedAtGlobal.body.regionalStatus, 'pending');
      };
      const sqlCount = provider.statements.length;
      await request(
        '/database-imports',
        { method: 'POST', token: revoked.secret, body: commit(revokedReview, 'revoked_import') },
        200,
      );
      faults.afterCreate = undefined;
      // The admitted HTTP operation drains before policy applies. No later admission may pass.
      assert.equal(provider.statements.length, sqlCount + 2);
      // The in-flight operation can hold the policy transition until the control
      // connection reconnects. Require the same durable revocation to converge.
      let applied;
      const deadline = Date.now() + 30_000;
      do {
        applied = await f.deliver(revoked.data.id, 2);
        assert.equal(applied.status, 201, JSON.stringify(applied.body));
        if (applied.body.data.regionalStatus === 'applied') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert.equal(applied.body.data.regionalStatus, 'applied');
      await request(
        '/queries',
        { method: 'POST', token: revoked.secret, body: { resourceId: 'db_live', sql: 'SELECT 1' } },
        401,
        'INVALID_CREDENTIAL',
      );
    },
  );
}
