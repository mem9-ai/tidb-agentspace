// Disposable child: receives only one snapshot and a script, never provider/session credentials.
import { readFile } from 'node:fs/promises';
import { analysisBashInput, analysisCommands, analysisError } from './file-analysis-contract.mjs';

async function duckdb({ sourcePath, format, script, limits }) {
  const { DuckDBInstance, StatementType, JsonDuckDBValueConverter } =
    await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:', {
    threads: '1',
    memory_limit: `${limits.duckdbMemoryMB}MB`,
    temp_directory: '',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
    allow_unsigned_extensions: 'false',
  });
  const connection = await db.connect();
  let statement, result;
  try {
    const reader = format === 'parquet' ? 'read_parquet' : 'read_csv_auto';
    const quoted = sourcePath.replaceAll("'", "''");
    await connection.run(`CREATE TABLE "file" AS SELECT * FROM ${reader}('${quoted}')`);
    const schema = (await connection.runAndReadAll('DESCRIBE "file"')).getRowObjectsJson();
    await connection.run('SET enable_external_access=false; SET lock_configuration=true');
    const extracted = await connection.extractStatements(script);
    if (extracted.count !== 1)
      throw analysisError(422, 'READ_ONLY_SQL', 'Run one read-only SELECT statement.');
    statement = await extracted.prepare(0);
    if (statement.statementType !== StatementType.SELECT)
      throw analysisError(
        422,
        'READ_ONLY_SQL',
        'Only SELECT queries over the file snapshot are allowed.',
      );
    result = await statement.stream();
    const columns = result.deduplicatedColumnNames();
    const columnTypes = columns.map((_, i) => String(result.columnType(i)));
    const rows = [];
    const converter = JsonDuckDBValueConverter;
    let size = Buffer.byteLength(JSON.stringify({ columns, columnTypes, schema }));
    for await (const chunk of result) {
      for (const values of chunk.convertRows(converter)) {
        const row = Object.fromEntries(columns.map((name, i) => [name, values[i]]));
        size += Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= limits.rows || size > limits.outputBytes)
          throw analysisError(
            422,
            'ANALYSIS_OUTPUT_LIMIT',
            'Results exceed 1,000 rows or 1 MiB. Add LIMIT or select fewer columns.',
          );
        rows.push(row);
      }
    }
    return {
      columns,
      columnTypes,
      rows,
      rowCount: rows.length,
      schema,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  } finally {
    result?.closeSync();
    statement?.destroySync();
    connection.closeSync();
    db.closeSync();
  }
}
async function bash({ sourcePath, workspacePath, script, limits }) {
  const { Bash, InMemoryFs } = await import('just-bash');
  const bytes = await readFile(sourcePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.some((b) => b < 9 || (b > 13 && b < 32))) throw new Error('Binary');
  } catch {
    throw analysisError(
      422,
      'ANALYSIS_BINARY_TEXT',
      'Just Bash requires a UTF-8 text file. Download binary files to open them elsewhere.',
    );
  }
  const input = analysisBashInput(workspacePath);
  const memory = new InMemoryFs({ [input.path]: text });
  await memory.mkdir(input.workingDirectory, { recursive: true });
  // An internal symlink preserves old commands without retaining a second file body.
  for (const alias of input.aliases) await memory.symlink(input.path, alias);
  const mutations = new Set([
    'writeFile',
    'appendFile',
    'mkdir',
    'createExclusive',
    'rm',
    'cp',
    'mv',
    'chmod',
    'symlink',
    'link',
    'utimes',
  ]);
  const fs = new Proxy(memory, {
    get(target, name) {
      if (mutations.has(name))
        return async () => {
          throw Object.assign(new Error('EROFS: This analysis filesystem is read-only.'), {
            code: 'EROFS',
          });
        };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const shell = new Bash({
    fs,
    cwd: input.workingDirectory,
    env: {},
    commands: analysisCommands,
    python: false,
    javascript: false,
    executionLimitProfile: 'hardened',
    executionLimits: {
      maxExecutionTimeMs: limits.timeoutMs,
      maxCommandCount: 1000,
      maxLoopIterations: 1000,
      maxOutputSize: limits.outputBytes,
      maxLiveBytes: 64 * 1024 * 1024,
      maxInputBytes: limits.inputBytes * 4,
      maxFileSystemBytes: limits.inputBytes * 2,
      maxStringLength: limits.outputBytes,
      maxTraversalEntries: 1000,
      maxGlobOperations: 1000,
      maxArrayElements: 10000,
      maxBraceExpansionResults: 1000,
    },
  });
  const result = await shell.exec(script);
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > limits.outputBytes)
    throw analysisError(
      422,
      'ANALYSIS_OUTPUT_LIMIT',
      'Command output exceeds 1 MiB. Narrow the search or pipe to head.',
    );
  return {
    columns: [],
    columnTypes: [],
    schema: [],
    rows: [],
    rowCount: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
process.once('message', async (input) => {
  let message;
  try {
    const result = await (input.engine === 'duckdb' ? duckdb(input) : bash(input));
    if (Buffer.byteLength(JSON.stringify(result)) > input.limits.outputBytes)
      throw analysisError(
        422,
        'ANALYSIS_OUTPUT_LIMIT',
        'Analysis output exceeds 1 MiB. Reduce the result size.',
      );
    message = { result };
  } catch (error) {
    // Never relay native messages, SQL, snapshot paths or stack traces.
    message = {
      error: {
        status: error.status || 422,
        code: error.code || 'ANALYSIS_FAILED',
        message: error.status
          ? error.message
          : 'Analysis could not complete. Check the query or command, file format and execution limits.',
      },
    };
  }
  process.send(message, () => process.exit(0));
});
