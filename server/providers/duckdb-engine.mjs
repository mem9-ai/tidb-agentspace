import { DuckDBInstance, ResultReturnType, StatementType } from '@duckdb/node-api';
import { resultCollector, sqlError, sqlLimits } from './sql-common.mjs';

const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
export const duckdbUri = 'tidbfs+db:///workspace.duckdb';
export function safeDuckdbError(error) {
  if (
    error?.status &&
    [
      'INVALID_SQL',
      'SQL_PERMISSION_DENIED',
      'RESULT_TOO_LARGE',
      'SOURCE_INVALID',
      'SQL_SYNTAX_ERROR',
      'SQL_OBJECT_NOT_FOUND',
      'SQL_CONFLICT',
    ].includes(error.code)
  )
    return error;
  const message = String(error?.message || '');
  if (/Parser Error/.test(message))
    return sqlError(
      422,
      'SQL_SYNTAX_ERROR',
      'Check DuckDB SQL syntax and run one statement at a time.',
    );
  if (
    /Permission Error|configuration.*locked|external access|disabled by configuration|Expected a single SELECT statement|read.only database/i.test(
      message,
    )
  )
    return sqlError(
      403,
      'SQL_PERMISSION_DENIED',
      'This operation is not available in the database workspace.',
    );
  if (/Catalog Error|Binder Error/.test(message))
    return sqlError(
      422,
      'SQL_OBJECT_NOT_FOUND',
      'A referenced object or SQL function is unavailable.',
    );
  if (/Constraint Error|TransactionContext Error/.test(message))
    return sqlError(
      409,
      'SQL_CONFLICT',
      'The statement conflicts with existing data or another operation.',
    );
  return sqlError(
    502,
    'SQL_EXECUTION_FAILED',
    'DuckDB could not complete the operation. A write may have completed; inspect the database before retrying.',
  );
}
// Only database SQL is offered. Native parsing still enforces exactly one statement.
function supportedStatement(sql) {
  const text = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  return (
    /^(?:SELECT|WITH|FROM|VALUES|SHOW|DESCRIBE|CHECKPOINT)\b/i.test(text) ||
    /^(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(text) ||
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:TABLE|VIEW|(?:UNIQUE\s+)?INDEX)\b/i.test(
      text,
    ) ||
    /^(?:ALTER\s+TABLE|DROP\s+(?:TABLE|VIEW|INDEX))\b/i.test(text)
  );
}
export async function probeDuckdbExtension(extensionPath) {
  const instance = await DuckDBInstance.create(':memory:', {
    allow_unsigned_extensions: 'true',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
  });
  const connection = await instance.connect();
  try {
    await connection.run(`LOAD ${quote(extensionPath)}`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
export async function openDuckdb({ extensionPath, apiKey, endpoint, localPath, sources = [] }) {
  const instance = await DuckDBInstance.create(':memory:', {
    allow_unsigned_extensions: extensionPath ? 'true' : 'false',
    allow_unredacted_secrets: 'false',
    allow_persistent_secrets: 'false',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
    allow_extension_repositories: 'forbidden',
    memory_limit: '256MB',
    threads: '2',
    max_temp_directory_size: '0B',
  });
  const setup = await instance.connect();
  try {
    const attachment = sources.length ? ' (READ_ONLY)' : '';
    if (localPath) await setup.run(`ATTACH ${quote(localPath)} AS workspace${attachment}`);
    else {
      await setup.run(`LOAD ${quote(extensionPath)}`);
      await setup.run(
        `CREATE TEMPORARY SECRET workspace_storage (TYPE tidbfs, ENDPOINT ${quote(endpoint)}, TOKEN ${quote(apiKey)})`,
      );
      await setup.run(`ATTACH ${quote(duckdbUri)} AS workspace${attachment}`);
    }
    await setup.run('USE workspace');
    if (sources.length) {
      await setup.run("ATTACH ':memory:' AS files");
      const readers = {
        csv: 'read_csv',
        json: 'read_json_auto',
        jsonl: 'read_json_auto',
        ndjson: 'read_json_auto',
        parquet: 'read_parquet',
      };
      for (const source of sources) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(source.name) || !Object.hasOwn(readers, source.format))
          throw sqlError(422, 'SOURCE_INVALID', 'Invalid query source.');
        try {
          await setup.run(
            `CREATE TABLE files."${source.name}" AS SELECT * FROM ${readers[source.format]}(${quote(source.path)})`,
          );
        } catch {
          throw sqlError(
            422,
            'SOURCE_INVALID',
            'A selected file could not be loaded within query limits. Check its format or use a smaller file.',
          );
        }
      }
    }
    // Access to the already attached database/WAL is internal to the storage engine.
    await setup.run('SET enable_external_access=false');
    await setup.run('SET lock_configuration=true');
  } catch (error) {
    setup.closeSync();
    instance.closeSync();
    throw safeDuckdbError(error);
  }
  setup.closeSync();
  return {
    async query(sql, limits = sqlLimits) {
      if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > limits.sqlBytes)
        throw sqlError(400, 'INVALID_SQL', 'Enter one SQL statement, up to 64 KiB.');
      if (!supportedStatement(sql))
        throw sqlError(
          403,
          'SQL_PERMISSION_DENIED',
          'Use database queries and table operations. Storage, secrets, settings, extensions and external connections are managed internally.',
        );
      const connection = await instance.connect();
      let prepared, result;
      try {
        await connection.run('USE workspace');
        const statements = await connection.extractStatements(sql);
        if (statements.count !== 1)
          throw sqlError(400, 'INVALID_SQL', 'Run exactly one SQL statement per request.');
        prepared = await statements.prepare(0);
        if (sources.length && prepared.statementType !== StatementType.SELECT)
          throw sqlError(
            403,
            'SQL_PERMISSION_DENIED',
            'File source queries are read-only. Run one SELECT statement.',
          );
        result = await prepared.stream();
        if (result.returnType !== ResultReturnType.QUERY_RESULT)
          return { columns: [], rows: [], rowCount: 0, affectedRows: result.rowsChanged };
        const collector = resultCollector(limits);
        collector.fields(result.columnNames());
        for await (const rows of result.yieldRowsJson()) for (const row of rows) collector.row(row);
        return collector.finish(result.rowsChanged);
      } catch (error) {
        throw safeDuckdbError(error);
      } finally {
        result?.closeSync();
        prepared?.destroySync();
        connection.closeSync();
      }
    },
    close() {
      instance.closeSync();
    },
  };
}
