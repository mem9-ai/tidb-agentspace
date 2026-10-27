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

export function fileFormat(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown' } as const;
  if (extension === 'json') return { kind: 'json', language: 'json' } as const;
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
  const newline = () => '\n' + '  '.repeat(depth);
  tokens.forEach((token, index) => {
    if (token === '{' || token === '[') {
      result += token;
      if (tokens[index + 1] !== (token === '{' ? '}' : ']')) {
        depth++;
        result += newline();
      }
    } else if (token === '}' || token === ']') {
      if (tokens[index - 1] !== (token === '}' ? '{' : '[')) {
        depth--;
        result += newline();
      }
      result += token;
    } else if (token === ',') result += token + newline();
    else if (token === ':') result += ': ';
    else result += token;
  });
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
