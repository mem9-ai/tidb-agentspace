import assert from 'node:assert/strict';

export async function exportCases(t, { request, key, token, resources, provider }) {
  await t.test(
    'exports preserve CSV/JSON/JSONL precision, column order and create-only destinations',
    async () => {
      const result = {
        columns: ['z', 'a', 'blank'],
        rows: [
          { z: '9007199254740993', a: '"quoted"\nline', blank: null },
          { z: '=SUM(A1)', a: '😀', blank: '' },
        ],
      };
      const csv =
        '"z","a","blank"\r\n"9007199254740993","""quoted""\nline",\r\n"\'=SUM(A1)","😀",""\r\n';
      const expected = {
        csv,
        json: '[{"z":"9007199254740993","a":"\\"quoted\\"\\nline","blank":null},\n{"z":"=SUM(A1)","a":"😀","blank":""}]\n',
        jsonl:
          '{"z":"9007199254740993","a":"\\"quoted\\"\\nline","blank":null}\n{"z":"=SUM(A1)","a":"😀","blank":""}\n',
      };
      for (const format of ['csv', 'json', 'jsonl']) {
        const exported = await request('/result-exports', {
          method: 'POST',
          token,
          body: { sourceResourceId: 'db_live', result, target: { kind: 'download', format } },
        });
        assert.equal(exported.body.content, expected[format]);
        assert.equal(exported.body.bytes, Buffer.byteLength(expected[format]));
      }
      const numeric = await request('/result-exports', {
        method: 'POST',
        token,
        raw: '{"sourceResourceId":"db_live","result":{"columns":["n"],"rows":[{"n":9007199254740993}]},"target":{"kind":"download","format":"csv"}}',
      });
      assert.equal(numeric.body.content, '"n"\r\n"9007199254740993"\r\n');
      const target = {
        kind: 'filesystem',
        resourceId: 'fs_live',
        path: '/coverage-export.csv',
        format: 'csv',
      };
      await request('/result-exports', {
        method: 'POST',
        token,
        body: { sourceResourceId: 'db_live', result, target },
      });
      await request(
        '/result-exports',
        {
          method: 'POST',
          token,
          body: {
            sourceResourceId: 'db_live',
            result: { columns: ['n'], rows: [{ n: 2 }] },
            target,
          },
        },
        409,
        'EXPORT_TARGET_EXISTS',
      );
      assert.deepEqual(
        (await request('/files/content?resourceId=fs_live&path=/coverage-export.csv', { token }))
          .body,
        Buffer.from(csv),
      );
      const readonly = await key('coverage-export-readonly', resources, [
        'queries:execute',
        'files:read',
      ]);
      const before = provider.calls;
      await request(
        '/result-exports',
        {
          method: 'POST',
          token: readonly.secret,
          body: {
            sourceResourceId: 'db_live',
            result,
            target: { ...target, path: '/denied-export.csv' },
          },
        },
        403,
        'INSUFFICIENT_SCOPE',
      );
      assert.equal(provider.calls, before);
    },
  );
}
