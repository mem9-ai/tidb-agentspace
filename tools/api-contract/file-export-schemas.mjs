const str = { type: 'string' };
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const original = object({ kind: { const: 'original' }, resourceId: str, path: str });
const output = object({
  kind: { const: 'output' },
  resourceId: str,
  stream: { enum: ['stdout', 'stderr'] },
  text: str,
});
const fileTarget = object({ kind: { const: 'filesystem' }, resourceId: str, path: str });
const databaseTarget = object({ kind: { const: 'database' }, resourceId: str, table: str });
const field = object({
  source: str,
  name: str,
  type: { enum: ['TEXT', 'BIGINT', 'DOUBLE', 'BOOLEAN'] },
});
const fields = { type: 'array', minItems: 1, maxItems: 100, items: field };
export const fileExportSchemas = {
  FileExportSource: { oneOf: [original, output] },
  FileExportParsing: {
    oneOf: [
      object({
        format: { const: 'csv' },
        header: { type: 'boolean' },
        delimiter: { enum: [',', '\t', ';', '|'] },
      }),
      object({ format: { enum: ['parquet', 'lines'] } }),
    ],
  },
  FileExportPreparationInput: object({
    source: { $ref: '#/components/schemas/FileExportSource' },
    parsing: { $ref: '#/components/schemas/FileExportParsing' },
  }),
  Preparation: object({
    id: { ...str, format: 'uuid' },
    status: { enum: ['ready', 'consumed'] },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: str,
    fields,
    rows: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: true } },
    rowCount: { type: 'integer', minimum: 0, maximum: 1000 },
    sourceVersion: str,
    inputBytes: { type: 'integer' },
    format: { enum: ['csv', 'parquet', 'lines'] },
  }),
  FileExportInput: {
    oneOf: [
      object({ source: original, target: fileTarget }),
      object({
        source: output,
        target: { oneOf: [object({ kind: { const: 'download' } }), fileTarget] },
      }),
      object({ preparationId: str, confirmed: { const: true }, fields, target: databaseTarget }),
    ],
  },
  FileExportOutput: {
    oneOf: [
      object({
        kind: { const: 'download' },
        filename: str,
        mimeType: str,
        content: str,
        bytes: { type: 'integer' },
      }),
      object({
        kind: { const: 'filesystem' },
        resourceId: str,
        path: str,
        bytes: { type: 'integer' },
      }),
      object({
        kind: { const: 'database' },
        resourceId: str,
        table: str,
        rowCount: { type: 'integer' },
        columns: { type: 'array', items: object({ name: str, type: str }) },
      }),
    ],
  },
};
