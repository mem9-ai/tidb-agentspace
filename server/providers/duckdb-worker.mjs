import { openDuckdb, probeDuckdbExtension, safeDuckdbError } from './duckdb-engine.mjs';
import { sqlError } from './sql-common.mjs';
process.once('message', async ({ connection, extensionPath, sql, limits, probe }) => {
  let engine;
  try {
    if (probe) {
      await probeDuckdbExtension(extensionPath);
      process.send({ result: {} }, () => process.disconnect());
      return;
    }
    engine = await openDuckdb({ ...connection, extensionPath });
    const result = await engine.query(sql, limits);
    engine.close();
    engine = undefined;
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    engine?.close();
    const safe = probe
      ? sqlError(
          503,
          'DUCKDB_RUNTIME_UNAVAILABLE',
          'The configured DuckDB extension cannot be loaded by this runtime.',
        )
      : safeDuckdbError(error);
    process.send({ error: { status: safe.status, code: safe.code, message: safe.message } }, () =>
      process.disconnect(),
    );
  }
});
