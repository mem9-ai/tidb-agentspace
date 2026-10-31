import { fileExportSchemas } from './file-export-schemas.mjs';

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
    fields: fileExportSchemas.Preparation.properties.fields,
  }),
  DatabaseImportResult: fileExportSchemas.FileExportOutput.oneOf[2],
};
