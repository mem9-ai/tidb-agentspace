import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseSample } from './tutorial-import.ts';

const sampleId = 'a'.repeat(32);
function fixture() {
  const preparation = {
    id: 'prepared-orders',
    status: 'ready',
    createdAt: '2026-10-31T00:00:00Z',
    fields: [
      { source: 'id', name: 'id', type: 'BIGINT' },
      { source: 'region', name: 'region', type: 'TEXT' },
      { source: 'amount', name: 'amount', type: 'BIGINT' },
    ],
    rows: [
      { id: 1, region: 'APAC', amount: 120 },
      { id: 2, region: 'EMEA', amount: 80 },
      { id: 3, region: 'AMER', amount: 50 },
      { id: 4, region: 'APAC', amount: 120 },
      { id: 5, region: 'EMEA', amount: 100 },
      { id: 6, region: 'AMER', amount: 40 },
    ],
    rowCount: 6,
  };
  const calls = [];
  const api = {
    async createDatabaseImportPreparationUpload(resourceId, file, parsing) {
      calls.push({ action: 'prepare', resourceId, content: await file.text(), parsing });
      return preparation;
    },
    async createDatabaseImport(body) {
      calls.push({ action: 'commit', body });
      return { kind: 'database', rowCount: 6, table: body.table, resourceId: body.resourceId };
    },
  };
  const beforeWrite = () => calls.push({ action: 'write-attempted' });
  return { preparation, calls, api, beforeWrite };
}

test('tutorial imports its reviewed six-row CSV into the exact destination through create-only import', async () => {
  const { api, calls, beforeWrite } = fixture();
  const result = await loadDatabaseSample(api, 'db_selected', sampleId, beforeWrite);
  assert.deepEqual(
    calls.map((call) => call.action),
    ['prepare', 'write-attempted', 'commit'],
  );
  assert.equal(calls[0].resourceId, 'db_selected');
  assert.deepEqual(calls[0].parsing, { format: 'csv', header: true, delimiter: ',' });
  assert.equal(calls[0].content.split('\n').filter(Boolean).length, 7);
  assert.deepEqual(calls[2].body, {
    resourceId: 'db_selected',
    preparationId: 'prepared-orders',
    confirmed: true,
    table: `tutorial_orders_${sampleId}`,
    fields: [
      { source: 'id', name: 'id', type: 'BIGINT' },
      { source: 'region', name: 'region', type: 'TEXT' },
      { source: 'amount', name: 'amount', type: 'BIGINT' },
    ],
  });
  assert.equal(result.rowCount, 6);
});

test('unexpected parsing cannot silently confirm a different schema or dataset', async () => {
  for (const change of [
    (value) => {
      value.fields[2].type = 'DOUBLE';
    },
    (value) => {
      value.fields[0].source = 'other';
    },
    (value) => {
      value.rows[5].amount = 41;
    },
    (value) => {
      value.rows.pop();
    },
    (value) => {
      value.rowCount = 7;
    },
  ]) {
    const { api, preparation, calls, beforeWrite } = fixture();
    change(preparation);
    await assert.rejects(
      loadDatabaseSample(api, 'db_selected', sampleId, beforeWrite),
      /No table was created/,
    );
    assert.deepEqual(
      calls.map((call) => call.action),
      ['prepare'],
    );
  }
});

test('invalid sample names and preparation failures perform no write; uncertain commits are never retried', async () => {
  const { api, calls, beforeWrite } = fixture();
  await assert.rejects(
    loadDatabaseSample(api, 'db_selected', '../other', beforeWrite),
    /Invalid tutorial sample/,
  );
  assert.equal(calls.length, 0);
  const failedPreparation = {
    ...api,
    createDatabaseImportPreparationUpload: async () => {
      throw new Error('Parse unavailable');
    },
  };
  await assert.rejects(
    loadDatabaseSample(failedPreparation, 'db_selected', sampleId, beforeWrite),
    /Parse unavailable/,
  );
  assert.equal(calls.length, 0);
  api.createDatabaseImport = async () => {
    calls.push({ action: 'unknown-commit' });
    throw new Error('Write outcome unknown');
  };
  await assert.rejects(
    loadDatabaseSample(api, 'db_selected', sampleId, beforeWrite),
    /Write outcome unknown/,
  );
  assert.deepEqual(
    calls.map((call) => call.action),
    ['prepare', 'write-attempted', 'unknown-commit'],
  );
});
