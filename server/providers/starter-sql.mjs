import { readFile, stat } from 'node:fs/promises';
import { executeNativeSql } from './sql-drivers.mjs';

export const starterProvider = 'tidb-cloud-starter';
export const sqlLimits = Object.freeze({
  rows: 1000,
  bytes: 1024 * 1024,
  sqlBytes: 64 * 1024,
  timeoutMs: 15_000,
});
export function sqlError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function validateBinding(binding, resource) {
  if (
    !binding ||
    binding.kind !== resource.kind ||
    binding.region !== resource.region ||
    !['mysql', 'postgresql'].includes(binding.kind) ||
    typeof binding.host !== 'string' ||
    !/^[a-z0-9.-]+\.tidbcloud\.com$/.test(binding.host) ||
    !Number.isInteger(binding.port) ||
    binding.port < 1 ||
    binding.port > 65535 ||
    !['user', 'password', 'database'].every(
      (key) => typeof binding[key] === 'string' && binding[key].length > 0,
    ) ||
    binding.database.length > 64 ||
    !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(binding.database)
  )
    throw sqlError(
      503,
      'DATABASE_NOT_CONFIGURED',
      'This database needs a valid internal Starter connection.',
    );
  // Copy only supported fields. In particular, never accept TLS overrides or connection URLs.
  return Object.fromEntries(
    ['kind', 'region', 'host', 'port', 'user', 'password', 'database'].map((key) => [
      key,
      binding[key],
    ]),
  );
}

export function createStarterSql({
  credentialsFile,
  execute = executeNativeSql,
  limits = sqlLimits,
}) {
  let active = 0;
  return {
    async execute(resource, sql, signal) {
      if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > limits.sqlBytes)
        throw sqlError(400, 'INVALID_SQL', 'Enter one SQL statement, up to 64 KiB.');
      if (active >= 4)
        throw sqlError(
          429,
          'SQL_BUSY',
          'Four queries are already running. Try again when one completes.',
        );
      active++;
      const started = performance.now();
      try {
        let binding;
        try {
          const info = await stat(credentialsFile);
          if (info.mode & 0o077) throw new Error('Private file permissions required');
          const vault = JSON.parse(await readFile(credentialsFile, 'utf8'));
          binding = validateBinding(vault.bindings?.[resource.id], resource);
        } catch {
          throw sqlError(
            503,
            'DATABASE_NOT_CONFIGURED',
            'This database needs a valid internal Starter connection.',
          );
        }
        const result = await execute(binding, sql, { limits, signal });
        return { ...result, mode: 'live', durationMs: Math.round(performance.now() - started) };
      } finally {
        active--;
      }
    },
  };
}

// Preserve duplicate column names with stable keys instead of losing values in an object.
export function resultCollector(limits = sqlLimits) {
  const rows = [];
  let columns = [],
    bytes = 0,
    fieldsSet = false;
  return {
    fields(names) {
      if (fieldsSet)
        throw sqlError(
          422,
          'SQL_MULTIPLE_RESULTS',
          'Multiple result sets are not supported. Writes may have completed; check their outcome before retrying.',
        );
      fieldsSet = true;
      const used = new Set();
      columns = names.map((name) => {
        let key = name,
          suffix = 2;
        while (used.has(key)) key = `${name}_${suffix++}`;
        used.add(key);
        return key;
      });
      bytes = Buffer.byteLength(JSON.stringify(columns));
      if (bytes > limits.bytes)
        throw sqlError(
          422,
          'RESULT_TOO_LARGE',
          'Result columns exceed the preview limit. Select fewer columns.',
        );
    },
    row(values) {
      const row = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rows.length >= limits.rows || bytes + size > limits.bytes)
        throw sqlError(
          422,
          'RESULT_TOO_LARGE',
          'Result exceeds 1,000 rows or 1 MiB. Select fewer columns or add LIMIT. Writes may already have completed; check their outcome before retrying.',
        );
      rows.push(row);
      bytes += size;
    },
    finish(affectedRows = 0) {
      return { columns, rows, rowCount: rows.length, affectedRows };
    },
  };
}

export function sanitizeSqlError(error) {
  if (['RESULT_TOO_LARGE', 'SQL_MULTIPLE_RESULTS'].includes(error?.code)) return error;
  const code = String(error?.code ?? '');
  if (['42601', 'ER_PARSE_ERROR', 'ER_EMPTY_QUERY'].includes(code))
    return sqlError(
      422,
      'SQL_SYNTAX_ERROR',
      'SQL syntax is invalid. Run one statement at a time and check the selected database dialect.',
    );
  if (
    [
      '42501',
      'ER_TABLEACCESS_DENIED_ERROR',
      'ER_DBACCESS_DENIED_ERROR',
      'ER_SPECIFIC_ACCESS_DENIED_ERROR',
    ].includes(code)
  )
    return sqlError(
      403,
      'SQL_PERMISSION_DENIED',
      'The database role does not permit this operation.',
    );
  if (['42P01', '42703', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(code))
    return sqlError(
      422,
      'SQL_OBJECT_NOT_FOUND',
      'A referenced table or column does not exist in this database.',
    );
  if (['23505', 'ER_DUP_ENTRY'].includes(code))
    return sqlError(409, 'SQL_CONFLICT', 'This statement conflicts with an existing unique value.');
  if (['57014', 'ER_QUERY_TIMEOUT', 'ETIMEDOUT'].includes(code))
    return sqlError(
      504,
      'SQL_TIMEOUT',
      'Query timed out. Its write outcome may be unknown; check the database before retrying.',
    );
  return sqlError(
    502,
    'SQL_EXECUTION_FAILED',
    'The database could not complete this statement. Check its connection and SQL compatibility. A write may have completed; verify before retrying.',
  );
}
