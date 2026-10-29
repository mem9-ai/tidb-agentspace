export const analysisLimits = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  scriptBytes: 64 * 1024,
  outputBytes: 1024 * 1024,
  rows: 1000,
  timeoutMs: 15_000,
  concurrency: 2,
  workerHeapMiB: 128,
  duckdbMemoryMB: 128,
});
export const tabularPreviewLimits = Object.freeze({
  rows: 20,
  columns: 50,
  outputBytes: 128 * 1024,
});
export const analysisCommands = Object.freeze([
  'cat',
  'grep',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'tr',
  'echo',
  'printf',
  'pwd',
  'ls',
  'find',
  'basename',
  'dirname',
  'test',
  '[',
  'true',
  'false',
  'seq',
]);
export function analysisError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
export function analysisBashInput(path) {
  const alias = '/workspace/input.log';
  // Never replace a selected file or one of its parent directories with an alias.
  const conflicts = path === alias || path.startsWith(alias + '/') || alias.startsWith(path + '/');
  return {
    path,
    workingDirectory: '/workspace',
    aliases: conflicts ? [] : [alias],
    fileVariable: 'FILE',
  };
}
export function analysisFormat(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return { defaultEngine: 'duckdb', engines: ['duckdb', 'bash'], format: ext };
  if (ext === 'parquet') return { defaultEngine: 'duckdb', engines: ['duckdb'], format: ext };
  if (
    [
      'log',
      'txt',
      'text',
      'md',
      'json',
      'jsonl',
      'ndjson',
      'yaml',
      'yml',
      'out',
      'err',
      'tsv',
    ].includes(ext)
  )
    return { defaultEngine: 'bash', engines: ['bash'], format: 'text' };
  return null;
}
export function validateAnalysis(input) {
  if (
    !input ||
    Object.keys(input).some((k) => !['resourceId', 'path', 'engine', 'sql', 'command'].includes(k))
  )
    throw analysisError(
      400,
      'INVALID_ANALYSIS',
      'Use a selected file and one SQL query or command.',
    );
  const kind = typeof input.path === 'string' && analysisFormat(input.path);
  if (!kind || !kind.engines.includes(input.engine))
    throw analysisError(
      422,
      'UNSUPPORTED_ANALYSIS',
      'Use DuckDB for CSV/Parquet, or Just Bash for UTF-8 CSV, logs and text.',
    );
  const script = input.engine === 'duckdb' ? input.sql : input.command;
  if (
    typeof script !== 'string' ||
    !script.trim() ||
    Buffer.byteLength(script) > analysisLimits.scriptBytes ||
    (input.engine === 'duckdb' ? 'command' : 'sql') in input
  )
    throw analysisError(400, 'INVALID_ANALYSIS', 'Enter one query or command, up to 64 KiB.');
  return { format: kind.format, script };
}
