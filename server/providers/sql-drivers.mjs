import { resultCollector, sanitizeSqlError, sqlError } from './starter-sql.mjs';

export async function executeNativeSql(
  binding,
  sql,
  { limits, signal, loadDriver = (kind) => (kind === 'mysql' ? import('mysql2') : import('pg')) },
) {
  const collector = resultCollector(limits);
  let close = () => {};
  let timer;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
        close();
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
              'Query exceeded 15 seconds. Its write outcome may be unknown; verify before retrying.',
            ),
          ),
        limits.timeoutMs,
      );
      void (async () => {
        if (signal?.aborted) return abort();
        if (binding.kind === 'mysql') {
          const { createConnection } = await loadDriver('mysql');
          if (settled) return;
          const client = createConnection({
            host: binding.host,
            port: binding.port,
            user: binding.user,
            password: binding.password,
            database: binding.database,
            ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' },
            connectTimeout: limits.timeoutMs,
            multipleStatements: false,
            rowsAsArray: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
            dateStrings: true,
            jsonStrings: true,
            flags: ['-LOCAL_FILES'],
          });
          close = () => client.destroy();
          client.on('error', (error) => finish(sanitizeSqlError(error)));
          let affectedRows = 0;
          const query = client.query(sql);
          query.on('fields', (fields) => {
            try {
              collector.fields(fields.map((field) => field.name));
            } catch (error) {
              finish(sanitizeSqlError(error));
            }
          });
          query.on('result', (row) => {
            if (settled) return;
            try {
              if (Array.isArray(row))
                collector.row(
                  row.map((value) => (Buffer.isBuffer(value) ? value.toString('base64') : value)),
                );
              else affectedRows = row.affectedRows ?? 0;
            } catch (error) {
              finish(sanitizeSqlError(error));
            }
          });
          query.on('error', (error) => finish(sanitizeSqlError(error)));
          query.on('end', () => finish(null, collector.finish(affectedRows)));
        } else {
          const { Client, Query } = await loadDriver('postgresql');
          if (settled) return;
          const client = new Client({
            host: binding.host,
            port: binding.port,
            user: binding.user,
            password: binding.password,
            database: binding.database,
            ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
            connectionTimeoutMillis: limits.timeoutMs,
            statement_timeout: limits.timeoutMs,
            lock_timeout: limits.timeoutMs,
            application_name: 'tidb-workspace',
            options: '',
          });
          close = () => {
            void client.end().catch(() => {});
          };
          client.on('error', (error) => finish(sanitizeSqlError(error)));
          await client.connect();
          if (settled) return close();
          // Extended protocol rejects multiple statements, including semicolons inside comments/strings correctly.
          // Return text values to avoid lossy bigint/numeric conversion and unbounded JSON parsing.
          const query = new Query({
            text: sql,
            queryMode: 'extended',
            rowMode: 'array',
            types: { getTypeParser: () => (value) => value },
          });
          let fieldsSet = false;
          query.on('row', (row, result) => {
            if (settled) return;
            try {
              if (!fieldsSet) {
                collector.fields(result.fields.map((field) => field.name));
                fieldsSet = true;
              }
              collector.row(row);
            } catch (error) {
              finish(sanitizeSqlError(error));
            }
          });
          query.on('error', (error) => finish(sanitizeSqlError(error)));
          query.on('end', (result) => {
            try {
              if (!fieldsSet) collector.fields(result.fields.map((field) => field.name));
              finish(
                null,
                collector.finish(result.command === 'SELECT' ? 0 : (result.rowCount ?? 0)),
              );
            } catch (error) {
              finish(sanitizeSqlError(error));
            }
          });
          client.query(query);
        }
      })().catch((error) => finish(sanitizeSqlError(error)));
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    close();
  }
}
