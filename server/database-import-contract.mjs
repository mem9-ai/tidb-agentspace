import { fileExportSchemas } from './file-export-contract.mjs';
import { sqlError } from './providers/sql-common.mjs';

const str = { type: 'string', minLength: 1 };
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const databaseImportSchemas = {
  DatabaseImportParsing: {
    oneOf: [
      object({
        format: { const: 'csv' },
        header: { type: 'boolean' },
        delimiter: { enum: [',', '\t', ';', '|'] },
      }),
      object({ format: { const: 'parquet' } }),
    ],
  },
  DatabaseImportPreparationInput: object({
    resourceId: str,
    source: object({ resourceId: str, path: str }),
    parsing: { $ref: '#/components/schemas/DatabaseImportParsing' },
  }),
  DatabaseImportInput: object({
    resourceId: str,
    preparationId: str,
    confirmed: { const: true },
    table: str,
    fields: fileExportSchemas.FileExportPreparation.properties.fields,
  }),
  DatabaseImportResult: fileExportSchemas.FileExportOutput.oneOf[2],
};
export const importInvalid = () => {
  throw sqlError(
    400,
    'INVALID_IMPORT',
    'Choose a database, a CSV/Parquet source and explicit parsing options.',
  );
};
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const string = (value) => typeof value === 'string' && value.length > 0 && value.isWellFormed();
export function importParsing(parsing) {
  if (
    parsing?.format === 'csv' &&
    exact(parsing, ['format', 'header', 'delimiter']) &&
    typeof parsing.header === 'boolean' &&
    [',', '\t', ';', '|'].includes(parsing.delimiter)
  )
    return parsing;
  if (parsing?.format === 'parquet' && exact(parsing, ['format'])) return parsing;
  importInvalid();
}
export function prepareImportInput(input, cleanPath) {
  if (
    !exact(input, ['resourceId', 'source', 'parsing']) ||
    !string(input.resourceId) ||
    !exact(input.source, ['resourceId', 'path']) ||
    !string(input.source.resourceId) ||
    !string(input.source.path)
  )
    importInvalid();
  return {
    resourceId: input.resourceId,
    source: {
      kind: 'original',
      resourceId: input.source.resourceId,
      path: cleanPath(input.source.path),
    },
    parsing: importParsing(input.parsing),
  };
}
export function uploadImportInput(query) {
  const csv = query.format === 'csv';
  if (
    !exact(
      query,
      csv
        ? ['resourceId', 'filename', 'format', 'header', 'delimiter']
        : ['resourceId', 'filename', 'format'],
    ) ||
    !string(query.resourceId) ||
    !string(query.filename) ||
    Buffer.byteLength(query.filename) > 255 ||
    Array.from(query.filename).some(
      (char) => char < ' ' || char === String.fromCharCode(127) || char === '/' || char === '\\',
    ) ||
    ['.', '..'].includes(query.filename)
  )
    importInvalid();
  if (csv && !['true', 'false'].includes(query.header)) importInvalid();
  return {
    resourceId: query.resourceId,
    filename: query.filename,
    parsing: importParsing(
      csv
        ? { format: 'csv', header: query.header === 'true', delimiter: query.delimiter }
        : { format: query.format },
    ),
  };
}
export function commitImportInput(input) {
  if (
    !exact(input, ['resourceId', 'preparationId', 'confirmed', 'table', 'fields']) ||
    !string(input.resourceId) ||
    !string(input.preparationId) ||
    input.confirmed !== true ||
    !string(input.table) ||
    !Array.isArray(input.fields)
  )
    importInvalid();
  return input;
}
