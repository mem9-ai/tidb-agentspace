import { openDuckdb, probeDuckdbExtension, safeDuckdbError } from './duckdb-engine.mjs';
import { sqlError } from './sql-common.mjs';
process.once('message', async ({ connection, extensionPath, sql, limits, probe, sources }) => {
  let engine;
  try {
    if (probe) {
      await probeDuckdbExtension(extensionPath);
      process.send({ result: {} }, () => process.disconnect());
      return;
    }
    engine = await openDuckdb({ ...connection, extensionPath, sources });
    const result = await engine.query(sql, limits);
    engine.close();
    engine = undefined;
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    engine?.close();
    let safe = probe
      ? sqlError(
          503,
          'DUCKDB_RUNTIME_UNAVAILABLE',
          'The configured DuckDB extension cannot be loaded by this runtime.',
        )
      : safeDuckdbError(error);
    if (sources?.length && safe.code === 'RESULT_TOO_LARGE')
      safe = sqlError(
        422,
        safe.code,
        'File query result exceeds 1,000 rows or 1 MiB. Select fewer columns or add LIMIT.',
      );
    if (sources?.length && safe.code === 'SQL_EXECUTION_FAILED')
      safe = sqlError(
        502,
        safe.code,
        'DuckDB could not complete this read-only query. Check storage availability before running again.',
      );
    process.send({ error: { status: safe.status, code: safe.code, message: safe.message } }, () =>
      process.disconnect(),
    );
  }
});
