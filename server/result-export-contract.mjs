import { exportLimits } from './result-exports.mjs';

const str = { type: 'string' };
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const format = { type: 'string', enum: ['csv', 'json', 'jsonl'] };
const rowCount = { type: 'integer', minimum: 0, maximum: exportLimits.rows };
export const resultExportSchemas = {
  ResultExportInput: object({
    sourceResourceId: str,
    result: object({
      columns: {
        type: 'array',
        minItems: 1,
        maxItems: exportLimits.columns,
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
      rows: {
        type: 'array',
        maxItems: exportLimits.rows,
        items: { type: 'object', additionalProperties: true },
      },
    }),
    target: {
      oneOf: [
        object({ kind: { const: 'download' }, format }),
        object({
          kind: { const: 'filesystem' },
          resourceId: str,
          path: { type: 'string', maxLength: 512 },
          format,
        }),
        object({
          kind: { const: 'database' },
          resourceId: str,
          table: { type: 'string', minLength: 1, maxLength: 63 },
        }),
      ],
    },
  }),
  ResultExportOutput: {
    oneOf: [
      object({
        kind: { const: 'download' },
        rowCount,
        format,
        filename: str,
        mimeType: str,
        content: str,
        bytes: { type: 'integer', minimum: 0 },
      }),
      object({
        kind: { const: 'filesystem' },
        rowCount,
        resourceId: str,
        path: str,
        format,
        bytes: { type: 'integer', minimum: 0 },
      }),
      object({
        kind: { const: 'database' },
        rowCount,
        resourceId: str,
        table: str,
        columns: { type: 'array', items: object({ name: str, type: str }) },
      }),
    ],
  },
};
