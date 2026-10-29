import { sqlError } from './providers/sql-common.mjs';
export const importTypes = ['TEXT', 'BIGINT', 'DOUBLE', 'BOOLEAN'];
const fail = (message) => {
  throw sqlError(400, 'INVALID_IMPORT_FIELDS', message);
};
export function importValue(value, type, where = 'field') {
  if (!importTypes.includes(type)) fail('Choose TEXT, BIGINT, DOUBLE or BOOLEAN.');
  if (value === null) return null;
  if (type === 'TEXT') return typeof value === 'string' ? value : JSON.stringify(value);
  if (type === 'BOOLEAN') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))
      return value.trim().toLowerCase() === 'true';
  }
  if (type === 'BIGINT') {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      fail(`${where} cannot be converted to BIGINT without losing precision.`);
    if (['string', 'number'].includes(typeof value) && /^[+-]?\d+$/.test(String(value).trim())) {
      const integer = BigInt(String(value).trim());
      if (integer >= -(2n ** 63n) && integer < 2n ** 63n) return String(integer);
    }
  }
  if (type === 'DOUBLE' && ['string', 'number'].includes(typeof value) && String(value).trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  fail(`${where} cannot be converted to ${type}. Choose TEXT to preserve its representation.`);
}
export function suggestedImportFields(parsed, format) {
  return parsed.columns.map((source, index) => {
    const values = parsed.rows.map((row) => row[source]).filter((value) => value !== null);
    const hint = parsed.columnTypes[index];
    let type = 'TEXT';
    if (
      (format === 'parquet' && hint === 'BOOLEAN') ||
      (values.length &&
        values.every((value) => typeof value === 'boolean' || ['true', 'false'].includes(value)))
    )
      type = 'BOOLEAN';
    else if (
      (values.length || format === 'parquet') &&
      (/^(U?(TINYINT|SMALLINT|INTEGER|BIGINT)|INT|HUGEINT)$/.test(hint) ||
        (values.length && values.every((value) => /^(0|-?[1-9]\d*)$/.test(String(value)))))
    ) {
      try {
        for (const value of values) importValue(value, 'BIGINT');
        type = 'BIGINT';
      } catch {
        type = 'TEXT';
      }
    } else if (
      format === 'parquet' &&
      ['FLOAT', 'DOUBLE', 'REAL'].includes(hint) &&
      values.every((value) => typeof value === 'number' && Number.isFinite(value))
    )
      type = 'DOUBLE';
    return { source, name: source, type };
  });
}
export function mapImportFields(parsed, fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 100) fail('Select 1–100 fields.');
  const sources = new Set(),
    names = new Set();
  for (const field of fields) {
    if (
      !field ||
      Object.keys(field).length !== 3 ||
      !['source', 'name', 'type'].every((key) => typeof field[key] === 'string') ||
      Object.keys(field).some((key) => !['source', 'name', 'type'].includes(key))
    )
      fail('Provide a source, target name and supported type for every field.');
    if (!parsed.columns.includes(field.source) || sources.has(field.source))
      fail('Select each known source field at most once.');
    sources.add(field.source);
    if (
      !field.name.trim() ||
      !field.name.isWellFormed() ||
      Buffer.byteLength(field.name) > 63 ||
      [...field.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      names.has(field.name.toLowerCase())
    )
      fail('Use distinct field names of 1–63 UTF-8 bytes without control characters.');
    names.add(field.name.toLowerCase());
    if (!importTypes.includes(field.type)) fail('Choose TEXT, BIGINT, DOUBLE or BOOLEAN.');
  }
  return {
    columns: fields.map((field) => field.name),
    rows: parsed.rows.map((row, index) =>
      Object.fromEntries(
        fields.map((field) => [
          field.name,
          importValue(row[field.source], field.type, `Field ${field.name}, row ${index + 1}`),
        ]),
      ),
    ),
  };
}
