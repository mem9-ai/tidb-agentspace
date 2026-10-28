import { resultCollector, sqlError } from './sql-common.mjs';

export function postgresError(error) {
  if (error?.code === '42P07')
    return sqlError(
      409,
      'SQL_TABLE_EXISTS',
      'A table with this name already exists. Choose a new table name.',
    );
  if (
    ['RESULT_TOO_LARGE', 'SQL_MULTIPLE_RESULTS', 'SQL_TIMEOUT', 'SQL_CANCELED'].includes(
      error?.code,
    )
  )
    return error;
  if (error?.code === '42601')
    return sqlError(
      422,
      'SQL_SYNTAX_ERROR',
      'Check PostgreSQL syntax and run one statement at a time.',
    );
  if (error?.code === '42501')
    return sqlError(
      403,
      'SQL_PERMISSION_DENIED',
      'The database role does not permit this operation.',
    );
  if (['42P01', '42703', '42883'].includes(error?.code))
    return sqlError(
      422,
      'SQL_OBJECT_NOT_FOUND',
      'A referenced table, column or function is unavailable.',
    );
  if (error?.code === '23505')
    return sqlError(409, 'SQL_CONFLICT', 'This statement conflicts with an existing unique value.');
  if (['57014', 'ETIMEDOUT'].includes(error?.code))
    return sqlError(
      504,
      'SQL_TIMEOUT',
      'Query timed out. Check any write outcome before retrying.',
    );
  return sqlError(
    502,
    'SQL_EXECUTION_FAILED',
    'PostgreSQL could not complete this statement. Check compatibility and any write outcome before retrying.',
  );
}

export async function executePostgres(
  binding,
  sql,
  { limits, signal, loadDriver = () => import('pg'), setup = false },
) {
  const collector = resultCollector(limits);
  let client,
    timer,
    abort,
    settled = false;
  const close = () => {
    if (client) void client.end().catch(() => {});
  };
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        close();
        if (error) reject(postgresError(error));
        else resolve(result);
      };
      abort = () =>
        finish(
          sqlError(
            499,
            'SQL_CANCELED',
            'Connection closed. Check any write outcome before retrying.',
          ),
        );
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () =>
          finish(
            sqlError(
              504,
              'SQL_TIMEOUT',
              'Query exceeded 15 seconds. Check any write outcome before retrying.',
            ),
          ),
        limits.timeoutMs,
      );
      void (async () => {
        if (signal?.aborted) return abort();
        const { Client, Query, types } = await loadDriver();
        if (settled) return;
        client = new Client({
          host: binding.host,
          port: binding.port,
          user: binding.user,
          password: binding.password,
          database: 'postgres',
          ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: binding.host },
          connectionTimeoutMillis: limits.timeoutMs,
          statement_timeout: limits.timeoutMs,
          application_name: 'agent-workspace',
          types: {
            getTypeParser(oid, format) {
              // Preserve exact numeric, JSON and temporal text instead of coercing through JS numbers/dates.
              return [20, 1700, 1082, 1114, 1184, 114, 3802].includes(oid)
                ? (value) => value
                : types.getTypeParser(oid, format);
            },
          },
        });
        client.on('error', (error) => finish(error));
        await client.connect();
        if (settled) return close();
        if (!setup)
          await client.query({
            text: 'SET search_path TO workspace, pg_catalog',
            queryMode: 'extended',
          });
        if (settled) return close();
        const query = new Query({ text: sql, rowMode: 'array', queryMode: 'extended' });
        let fieldsSet = false;
        const fields = (result) => {
          if (!fieldsSet) {
            collector.fields(result.fields.map((field) => field.name));
            fieldsSet = true;
          }
        };
        query.on('row', (row, result) => {
          if (settled) return;
          try {
            fields(result);
            collector.row(
              row.map((value) => (Buffer.isBuffer(value) ? value.toString('base64') : value)),
            );
          } catch (error) {
            finish(error);
          }
        });
        query.on('error', (error) => finish(error));
        query.on('end', (result) => {
          if (settled) return;
          try {
            if (Array.isArray(result))
              throw sqlError(422, 'SQL_MULTIPLE_RESULTS', 'Run one statement at a time.');
            fields(result);
            finish(null, collector.finish(result.fields.length ? 0 : result.rowCount || 0));
          } catch (error) {
            finish(error);
          }
        });
        // The row listener prevents pg from accumulating an unbounded result.rows array.
        client.query(query);
      })().catch((error) => finish(error));
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    close();
  }
}
