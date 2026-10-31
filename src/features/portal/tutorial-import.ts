import type { workspaceApi } from '../../api/client';
import { orderRows, ordersCsv, tutorialSample } from './tutorial-data.ts';

type ImportApi = Pick<
  typeof workspaceApi,
  'createDatabaseImportPreparationUpload' | 'createDatabaseImport'
>;

// The tutorial's explicit Load action confirms only this fixed, visible dataset. Arbitrary
// customer uploads continue to use the import dialog's parsing/schema confirmation flow.
export async function loadDatabaseSample(
  api: ImportApi,
  resourceId: string,
  sampleId: string,
  onBeforeWrite: () => void,
) {
  const { table } = tutorialSample(sampleId);
  const fields = [
    { source: 'id', name: 'id', type: 'BIGINT' as const },
    { source: 'region', name: 'region', type: 'TEXT' as const },
    { source: 'amount', name: 'amount', type: 'BIGINT' as const },
  ];
  const preparation = await api.createDatabaseImportPreparationUpload(
    resourceId,
    new File([ordersCsv], 'tutorial-orders.csv', { type: 'text/csv' }),
    { format: 'csv', header: true, delimiter: ',' },
    () => {},
  );
  if (
    preparation.rowCount !== orderRows.length ||
    preparation.rows.length !== orderRows.length ||
    preparation.fields.length !== fields.length ||
    !fields.every((field, i) => {
      const actual = preparation.fields[i];
      return (
        actual.source === field.source && actual.name === field.name && actual.type === field.type
      );
    }) ||
    !orderRows.every((row, i) => {
      const actual = preparation.rows[i];
      return (
        Number(actual.id) === row.id &&
        actual.region === row.region &&
        Number(actual.amount) === row.amount
      );
    })
  )
    throw new Error(
      'The parsed sample does not match the six tutorial orders. No table was created.',
    );
  // Reuse the create-only import operation: TiDB does not support CREATE TABLE AS SELECT.
  // Record an uncertain write before issuing it; callers must inspect before retrying.
  onBeforeWrite();
  return api.createDatabaseImport({
    resourceId,
    preparationId: preparation.id,
    confirmed: true,
    table,
    fields,
  });
}
