import type { FileAnalysisResult } from '../../api/client';

export const salesByStateSql =
  'SELECT state, SUM(sales_usd) AS sales FROM file GROUP BY state ORDER BY sales DESC';

export function salesByProductSql(state: string) {
  return `SELECT product, SUM(sales_usd) AS sales FROM file WHERE state = '${state.replaceAll("'", "''")}' GROUP BY product ORDER BY sales DESC`;
}

export type SalesTotal = { label: string; sales: number };

export function salesTotals(result: FileAnalysisResult | null, label: 'state' | 'product') {
  if (!result?.rows.length) return null;
  const totals: SalesTotal[] = [];
  for (const row of result.rows) {
    const name = row[label];
    const value = row.sales;
    if (typeof name !== 'string' || !name || !['string', 'number'].includes(typeof value))
      return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const sales = Number(value);
    if (!Number.isFinite(sales)) return null;
    totals.push({ label: name, sales });
  }
  return totals;
}

export const formatSales = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

function table(rows: SalesTotal[], label: string) {
  const escape = (value: string) =>
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('|', '\\|')
      .replaceAll(/[\r\n]+/g, ' ');
  return [
    `| ${label} | Sales |`,
    '| --- | ---: |',
    ...rows.map((row) => `| ${escape(row.label)} | ${formatSales(row.sales)} |`),
  ].join('\n');
}

export function salesReport(path: string, states: SalesTotal[], products: SalesTotal[]) {
  const leading = states[0];
  const product = products[0];
  return [
    '# US sales summary',
    '',
    `Source: ${path}`,
    '',
    `The top state is ${leading.label} with ${formatSales(leading.sales)} in sales.`,
    `Its leading product is ${product.label} with ${formatSales(product.sales)} in sales.`,
    '',
    '## Sales by state',
    '',
    table(states, 'State'),
    '',
    `## Products in ${leading.label}`,
    '',
    table(products, 'Product'),
    '',
    '## Queries',
    '',
    '```sql',
    salesByStateSql,
    '```',
    '',
    '```sql',
    salesByProductSql(leading.label),
    '```',
    '',
  ].join('\n');
}
