import { randomUUID } from 'node:crypto';
import { sqlError, sqlLimits } from './providers/sql-common.mjs';

export const exportLimits = Object.freeze({ rows: 1000, columns: 100, depth: 16, bytes: 1048576 });
const invalid = (message) => {
  throw sqlError(400, 'INVALID_EXPORT', message);
};
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === 'string' && value.isWellFormed();
const hasControl = (value) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const exactKeys = (value, keys) =>
  plain(value) && Object.keys(value).every((key) => keys.includes(key));

function validateCell(value, depth = 0) {
  if (depth > exportLimits.depth) invalid('Result values exceed 16 nesting levels.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (text(value)) return;
  if (Array.isArray(value)) {
    for (const cell of value) validateCell(cell, depth + 1);
    return;
  }
  if (plain(value)) {
    for (const [key, cell] of Object.entries(value)) {
      if (!text(key)) invalid('Result keys must contain valid Unicode.');
      validateCell(cell, depth + 1);
    }
    return;
  }
  invalid('Result cells must be finite JSON values.');
}

export function parseResultExport(input) {
  if (!exactKeys(input, ['sourceResourceId', 'result', 'target']) || !text(input.sourceResourceId))
    invalid('Choose a source resource and export destination.');
  const { result, target } = input;
  if (
    !exactKeys(result, ['columns', 'rows']) ||
    !Array.isArray(result.columns) ||
    !Array.isArray(result.rows)
  )
    invalid('Provide result columns and rows.');
  if (
    !result.columns.length ||
    result.columns.length > exportLimits.columns ||
    result.columns.some((name) => !text(name) || !name) ||
    new Set(result.columns).size !== result.columns.length
  )
    invalid('Provide 1–100 unique, nonempty column names.');
  if (result.rows.length > exportLimits.rows) invalid('Export up to 1,000 result rows.');
  const names = new Set(result.columns);
  for (const row of result.rows) {
    if (
      !plain(row) ||
      Object.keys(row).length !== names.size ||
      Object.keys(row).some((key) => !names.has(key))
    )
      invalid('Every row must contain exactly the result columns.');
    for (const value of Object.values(row)) validateCell(value);
  }
  if (!plain(target) || !['download', 'filesystem', 'database'].includes(target.kind))
    invalid('Choose Download, File System or Database.');
  const keys =
    target.kind === 'download'
      ? ['kind', 'format']
      : target.kind === 'filesystem'
        ? ['kind', 'format', 'resourceId', 'path']
        : ['kind', 'resourceId', 'table'];
  if (!exactKeys(target, keys) || keys.some((key) => !text(target[key])))
    invalid('Invalid export destination.');
  if (target.kind !== 'database' && !['csv', 'json', 'jsonl'].includes(target.format))
    invalid('Choose CSV, JSON or JSON Lines.');
  if (Buffer.byteLength(JSON.stringify(input)) > exportLimits.bytes)
    throw sqlError(
      413,
      'EXPORT_TOO_LARGE',
      'Export requests are limited to 1 MiB. Select fewer rows or columns.',
    );
  return {
    ...input,
    result: {
      columns: result.columns,
      rows: result.rows.map((row) =>
        Object.fromEntries(result.columns.map((name) => [name, row[name]])),
      ),
    },
  };
}

const cellText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
function csvCell(value) {
  if (value === null) return '';
  let valueText = cellText(value);
  if (typeof value === 'string' && (/^[\t\r\n]/.test(valueText) || /^\s*[=+@-]/u.test(valueText)))
    valueText = "'" + valueText;
  return '"' + valueText.replaceAll('"', '""') + '"';
}
export function serializeResult(result, format) {
  // Serialize by the explicit column list: JSON.stringify reorders integer-like object keys.
  const jsonRows = () =>
    result.rows.map(
      (row) =>
        '{' +
        result.columns
          .map((name) => JSON.stringify(name) + ':' + JSON.stringify(row[name]))
          .join(',') +
        '}',
    );
  const content =
    format === 'json'
      ? '[' + jsonRows().join(',\n') + ']\n'
      : format === 'jsonl'
        ? jsonRows()
            .map((row) => row + '\n')
            .join('')
        : [
            result.columns.map(csvCell).join(','),
            ...result.rows.map((row) => result.columns.map((name) => csvCell(row[name])).join(',')),
          ].join('\r\n') + '\r\n';
  const bytes = Buffer.byteLength(content);
  if (bytes > 4 * exportLimits.bytes)
    throw sqlError(413, 'EXPORT_TOO_LARGE', 'Encoded exports are limited to 4 MiB.');
  return {
    content,
    bytes,
    format,
    filename: `query-results.${format}`,
    mimeType:
      format === 'csv'
        ? 'text/csv;charset=utf-8'
        : format === 'jsonl'
          ? 'application/x-ndjson'
          : 'application/json',
  };
}

function identifier(value) {
  if (!text(value) || !value || Buffer.byteLength(value) > 63 || hasControl(value))
    invalid('Table and column names must contain 1–63 UTF-8 bytes without control characters.');
  return value;
}
export function databaseExportPlan(result, table, kind) {
  identifier(table);
  if (!['mysql', 'postgresql', 'duckdb'].includes(kind)) invalid('Select a supported database.');
  const folded = new Set();
  const quote = (value) =>
    kind === 'mysql'
      ? '`' + value.replaceAll('`', '``') + '`'
      : '"' + value.replaceAll('"', '""') + '"';
  const columns = result.columns.map((name) => {
    identifier(name);
    if (folded.has(name.toLowerCase()))
      invalid('Database column names must be unique ignoring case.');
    folded.add(name.toLowerCase());
    const values = result.rows.map((row) => row[name]).filter((value) => value !== null);
    const type =
      values.length && values.every((value) => typeof value === 'boolean')
        ? 'BOOLEAN'
        : values.length && values.every((value) => typeof value === 'number')
          ? values.every(Number.isSafeInteger)
            ? 'BIGINT'
            : kind === 'postgresql'
              ? 'DOUBLE PRECISION'
              : 'DOUBLE'
          : kind === 'mysql'
            ? 'LONGTEXT'
            : kind === 'duckdb'
              ? 'VARCHAR'
              : 'TEXT';
    return { name, type };
  });
  function literal(value, column) {
    if (value === null) return 'NULL';
    if (column.type === 'BOOLEAN') return value ? 'TRUE' : 'FALSE';
    if (['BIGINT', 'DOUBLE', 'DOUBLE PRECISION'].includes(column.type)) return String(value);
    const string = cellText(value);
    if (string.includes('\0'))
      invalid(
        'Database text values cannot contain NUL characters. Use a JSON download to preserve them.',
      );
    const hex = Buffer.from(string).toString('hex');
    return kind === 'mysql'
      ? `CONVERT(X'${hex}' USING utf8mb4)`
      : kind === 'postgresql'
        ? `convert_from(decode('${hex}', 'hex'), 'UTF8')`
        : `decode(from_hex('${hex}'))`;
  }
  const create = `CREATE TABLE ${quote(table)} (${columns.map((column) => `${quote(column.name)} ${column.type}${kind === 'mysql' && column.type === 'LONGTEXT' ? ' CHARACTER SET utf8mb4' : ''}`).join(', ')});`;
  const insert = result.rows.length
    ? `INSERT INTO ${quote(table)} (${columns.map((column) => quote(column.name)).join(', ')}) VALUES ${result.rows.map((row) => '(' + columns.map((column) => literal(row[column.name], column)).join(', ') + ')').join(', ')};`
    : '';
  if ([create, insert].some((sql) => Buffer.byteLength(sql) > sqlLimits.sqlBytes))
    throw sqlError(
      413,
      'EXPORT_SQL_TOO_LARGE',
      'This result exceeds the 64 KiB database export statement limit. Export fewer rows or download a file.',
    );
  return { create, insert, columns };
}

export async function createExportFile({
  resource,
  path,
  artifact,
  store,
  drive9,
  authorize,
  record,
}) {
  const limit = resource.provider === 'drive9-anonymous' ? exportLimits.bytes : 256 * 1024;
  if (artifact.bytes > limit)
    throw sqlError(
      413,
      'FILE_TOO_LARGE',
      `This File System accepts exports up to ${limit} bytes. Download the result or select fewer rows.`,
    );
  if (resource.provider === 'drive9-anonymous') {
    try {
      await drive9.write(resource.id, path, Buffer.from(artifact.content), true, authorize);
    } catch (error) {
      if (['FILE_CHANGED', 'FILE_CONFLICT'].includes(error.code))
        throw sqlError(
          409,
          'EXPORT_TARGET_EXISTS',
          'An item already exists at this path. Choose a new filename.',
        );
      throw error;
    }
    await record();
    return;
  }
  await store.mutate((draft) => {
    authorize();
    if (draft.files.some((file) => file.resourceId === resource.id && file.path === path))
      throw sqlError(
        409,
        'EXPORT_TARGET_EXISTS',
        'An item already exists at this path. Choose a new filename.',
      );
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (
      parent !== '/' &&
      !draft.files.some(
        (file) =>
          file.resourceId === resource.id && file.path === parent && file.type === 'directory',
      )
    )
      throw sqlError(404, 'PARENT_MISSING', 'Parent directory does not exist.');
    if (draft.files.filter((file) => file.resourceId === resource.id).length >= 2000)
      throw sqlError(409, 'FREE_TIER_LIMIT', 'File count limit reached.');
    draft.files.push({
      id: randomUUID(),
      resourceId: resource.id,
      path,
      type: 'file',
      content: artifact.content,
      updatedAt: new Date().toISOString(),
    });
  });
  await record();
}

export async function exportResult(
  input,
  { authorize, cleanPath, createFile, execute, record, signal },
) {
  input = parseResultExport(input);
  const resource = authorize(input);
  const { result, target } = input;
  const rowCount = result.rows.length;
  if (target.kind !== 'database') {
    const artifact = serializeResult(result, target.format);
    if (target.kind === 'download') return { kind: target.kind, rowCount, ...artifact };
    const path = cleanPath(target.path);
    if (path === '/' || hasControl(path)) invalid('Choose a filename without control characters.');
    await createFile({
      resource,
      path,
      artifact,
      authorize: () => {
        signal?.throwIfAborted();
        return authorize(input);
      },
      record: () => record(target, rowCount),
    });
    return {
      kind: target.kind,
      resourceId: resource.id,
      path,
      format: target.format,
      bytes: artifact.bytes,
      rowCount,
    };
  }
  const plan = databaseExportPlan(result, target.table, resource.kind);
  authorize(input);
  signal?.throwIfAborted();
  await execute(resource, plan.create, signal);
  try {
    if (plan.insert) {
      authorize(input);
      signal?.throwIfAborted();
      await execute(resource, plan.insert, signal);
    }
  } catch {
    throw sqlError(
      502,
      'EXPORT_INCOMPLETE',
      `Table "${target.table}" was created, but its data write did not finish successfully. Inspect the table before retrying; it may be empty or already contain the rows.`,
    );
  }
  await record(target, rowCount);
  return {
    kind: target.kind,
    resourceId: resource.id,
    table: target.table,
    columns: plan.columns,
    rowCount,
  };
}
