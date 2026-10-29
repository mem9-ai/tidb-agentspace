import { readFile } from 'node:fs/promises';
import { analysisError } from './file-analysis-contract.mjs';

export async function readImport({ sourcePath, parsing, limits }) {
  if (parsing.format === 'lines') {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await readFile(sourcePath),
      );
    } catch {
      throw analysisError(422, 'IMPORT_FORMAT', 'Text-line import requires valid UTF-8.');
    }
    const rows = [];
    let size = 0,
      start = 0;
    const append = (end) => {
      if (rows.length >= limits.rows)
        throw analysisError(
          413,
          'IMPORT_ROW_LIMIT',
          'Import up to 1,000 rows. Use SQL to select a smaller result.',
        );
      const row = { line: text.slice(start, end) };
      size += Buffer.byteLength(JSON.stringify(row));
      if (size > limits.outputBytes)
        throw analysisError(
          413,
          'IMPORT_OUTPUT_LIMIT',
          'Parsed data exceeds 1 MiB. Select a smaller result.',
        );
      rows.push(row);
    };
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127)
        throw analysisError(422, 'IMPORT_FORMAT', 'Binary data cannot be imported as text lines.');
      if (code === 10 || code === 13) {
        append(i);
        if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
      }
    }
    if (start < text.length) append(text.length);
    return { columns: ['line'], columnTypes: ['VARCHAR'], rows, rowCount: rows.length };
  }
  const { DuckDBInstance, JsonDuckDBValueConverter } = await import('@duckdb/node-api');
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
  const quoted = sourcePath.replaceAll("'", "''");
  try {
    const reader =
      parsing.format === 'parquet'
        ? `read_parquet('${quoted}')`
        : `read_csv('${quoted}',header=${parsing.header},delim='${parsing.delimiter}',all_varchar=true,strict_mode=true,allow_quoted_nulls=false,quote='"',escape='"')`;
    await connection.run(`CREATE VIEW import_input AS SELECT * FROM ${reader}`);
    statement = await connection.prepare('SELECT * FROM import_input');
    result = await statement.stream();
    const columns = result.deduplicatedColumnNames();
    if (columns.length > limits.columns)
      throw analysisError(
        413,
        'IMPORT_COLUMN_LIMIT',
        'Import up to 100 columns. Select fewer columns with SQL.',
      );
    const columnTypes = columns.map((_, i) => String(result.columnType(i)));
    let size = Buffer.byteLength(JSON.stringify({ columns, columnTypes }));
    const rows = [];
    for await (const chunk of result)
      for (const values of chunk.convertRows(JsonDuckDBValueConverter)) {
        if (rows.length >= limits.rows)
          throw analysisError(
            413,
            'IMPORT_ROW_LIMIT',
            'Import up to 1,000 rows. Use SQL to select a smaller result.',
          );
        const row = Object.fromEntries(columns.map((name, i) => [name, values[i]]));
        size += Buffer.byteLength(JSON.stringify(row));
        if (size > limits.outputBytes)
          throw analysisError(
            413,
            'IMPORT_OUTPUT_LIMIT',
            'Parsed data exceeds 1 MiB. Select a smaller result.',
          );
        rows.push(row);
      }
    return { columns, columnTypes, rows, rowCount: rows.length };
  } finally {
    result?.closeSync();
    statement?.destroySync();
    connection.closeSync();
    db.closeSync();
  }
}
