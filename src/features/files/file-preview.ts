const codeLanguages = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  go: 'go',
} as const;

// Rendering has a smaller budget than storage. Check before parsers or highlighters run.
export const previewLimits = {
  bytes: 128 * 1024,
  lines: 2000,
  lineLength: 10000,
  jsonDepth: 64,
} as const;

const binaryExtensions = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'zip',
  'gz',
  'tar',
  '7z',
  'rar',
  'parquet',
  'arrow',
  'db',
  'sqlite',
  'sqlite3',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'exe',
  'bin',
  'wasm',
]);

class PreviewLimitError extends Error {}

function previewIssue(path: string, content: string): string | null {
  if (
    content.length > previewLimits.bytes ||
    new TextEncoder().encode(content).length > previewLimits.bytes
  )
    return 'This file exceeds the 128 KiB preview limit.';
  const extension = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  if (binaryExtensions.has(extension))
    return `The .${extension} file type is not supported by the text preview.`;
  // Permit normal text whitespace, but do not render binary/control data as a document.
  for (const character of content) {
    const code = character.charCodeAt(0);
    if ((code < 32 && ![9, 10, 12, 13].includes(code)) || code === 127)
      return 'This file contains binary or control data that cannot be previewed as text.';
  }
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > previewLimits.lines) return 'This file exceeds the 2,000-line preview limit.';
  if (lines.some((line) => line.length > previewLimits.lineLength))
    return 'This file contains a line longer than the 10,000-character preview limit.';
  return null;
}

export function prepareFilePreview(path: string, content: string) {
  const issue = previewIssue(path, content);
  if (issue) return { kind: 'unavailable', reason: issue } as const;
  const format = fileFormat(path);
  try {
    if (format.kind === 'json') return { ...format, content: formatJson(content) };
    if (format.kind === 'csv') return { ...format, ...previewCsv(content) };
    return { ...format, content };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason:
        error instanceof PreviewLimitError
          ? error.message
          : format.kind === 'json'
            ? 'This file could not be parsed as JSON. You can correct it in Edit source.'
            : 'This CSV could not be rendered. Check its quoting and the 50-column limit in Edit source.',
    } as const;
  }
}

export function isImageFile(path: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

export function isTabularFile(path: string) {
  return /\.(csv|parquet)$/i.test(path);
}

export function fileFormat(path: string) {
  const extension = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'mmd' || extension === 'mermaid') return { kind: 'mermaid' } as const;
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown' } as const;
  if (extension === 'json') return { kind: 'json', language: 'json' } as const;
  if (extension === 'parquet') return { kind: 'parquet' } as const;
  if (extension === 'csv') return { kind: 'csv' } as const;
  const language = Object.entries(codeLanguages).find(([key]) => key === extension)?.[1];
  return language ? ({ kind: 'code', language } as const) : ({ kind: 'text' } as const);
}

// Validate, then format the original tokens so large integers and escapes stay intact.
export function formatJson(content: string): string {
  JSON.parse(content);
  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  let depth = 0;
  let result = '';
  const append = (value: string) => {
    if (result.length + value.length > previewLimits.bytes)
      throw new PreviewLimitError('The formatted JSON exceeds the 128 KiB preview limit.');
    result += value;
  };
  const newline = () => '\n' + '  '.repeat(depth);
  tokens.forEach((token, index) => {
    if (token === '{' || token === '[') {
      if (depth >= previewLimits.jsonDepth)
        throw new PreviewLimitError('This JSON exceeds the 64-level nesting limit for previews.');
      append(token);
      if (tokens[index + 1] !== (token === '{' ? '}' : ']')) {
        depth++;
        append(newline());
      }
    } else if (token === '}' || token === ']') {
      if (tokens[index - 1] !== (token === '}' ? '{' : '[')) {
        depth--;
        append(newline());
      }
      append(token);
    } else if (token === ',') append(token + newline());
    else if (token === ':') append(': ');
    else append(token);
  });
  if (new TextEncoder().encode(result).length > previewLimits.bytes)
    throw new PreviewLimitError('The formatted JSON exceeds the 128 KiB preview limit.');
  return result;
}

export function previewCsv(content: string, maxRows = 200, maxColumns = 50) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const endCell = () => {
    row.push(cell);
    if (row.length > maxColumns) throw new Error(`Preview supports up to ${maxColumns} columns.`);
    cell = '';
    closedQuote = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else cell += char;
    } else if (char === ',') endCell();
    else if (char === '\n' || char === '\r') {
      endRow();
      if (char === '\r' && content[i + 1] === '\n') i++;
      if (rows.length >= maxRows && i < content.length - 1) return { rows, truncated: true };
    } else if (char === '"' && !cell && !closedQuote) quoted = true;
    else {
      if (char === '"' || closedQuote) throw new Error('This CSV has invalid quoted fields.');
      cell += char;
    }
  }
  if (quoted) throw new Error('This CSV has an unclosed quoted field.');
  if (cell || row.length || closedQuote) endRow();
  return { rows, truncated: false };
}
