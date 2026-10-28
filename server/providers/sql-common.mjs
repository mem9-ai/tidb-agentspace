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
    binding.kind !== 'mysql' ||
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
      'This database needs a valid internal Zero connection.',
    );
  // Copy only supported fields. In particular, never accept TLS overrides or connection URLs.
  return Object.fromEntries(
    ['kind', 'region', 'host', 'port', 'user', 'password', 'database'].map((key) => [
      key,
      binding[key],
    ]),
  );
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
  if (error?.code === 'ER_TABLE_EXISTS_ERROR')
    return sqlError(
      409,
      'SQL_TABLE_EXISTS',
      'A table with this name already exists. Choose a new table name.',
    );
  if (['RESULT_TOO_LARGE', 'SQL_MULTIPLE_RESULTS'].includes(error?.code)) return error;
  const code = String(error?.code ?? '');
  if (error?.errno === 8130 || ['ER_PARSE_ERROR', 'ER_EMPTY_QUERY'].includes(code))
    return sqlError(
      422,
      'SQL_SYNTAX_ERROR',
      'SQL syntax is invalid. Run one statement at a time and check the selected database dialect.',
    );
  if (
    [
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
  if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(code))
    return sqlError(
      422,
      'SQL_OBJECT_NOT_FOUND',
      'A referenced table or column does not exist in this database.',
    );
  if (code === 'ER_DUP_ENTRY')
    return sqlError(409, 'SQL_CONFLICT', 'This statement conflicts with an existing unique value.');
  if (['ER_QUERY_TIMEOUT', 'ETIMEDOUT'].includes(code))
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
