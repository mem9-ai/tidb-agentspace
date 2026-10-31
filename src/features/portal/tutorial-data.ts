import type { Resource } from '../../api/client';

export const ordersCsv = `id,region,amount
1,APAC,120
2,EMEA,80
3,AMER,50
4,APAC,120
5,EMEA,100
6,AMER,40
`;

export const expectedTotals = [
  { region: 'AMER', total: 90 },
  { region: 'APAC', total: 240 },
  { region: 'EMEA', total: 180 },
];

export function liveDatabase(resource: Pick<Resource, 'provider'>) {
  return ['tidb-cloud-zero', 'db9-anonymous', 'duckdb-drive9'].includes(resource.provider || '');
}

export function tutorialSample(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid tutorial sample ID.');
  return { table: `tutorial_orders_${id}`, path: `/tutorial-orders-${id}.csv` };
}

export function totalsQuery(table: string) {
  return `SELECT region, SUM(amount) AS total\nFROM ${table}\nGROUP BY region\nORDER BY region;`;
}

export function databaseTutorial(resource: Pick<Resource, 'kind' | 'provider'>, id: string) {
  const sample = tutorialSample(id);
  const table =
    resource.kind === 'postgresql'
      ? `"workspace"."${sample.table}"`
      : resource.kind === 'duckdb'
        ? `"main"."${sample.table}"`
        : `\`${sample.table}\``;
  return {
    table: sample.table,
    query: liveDatabase(resource) ? totalsQuery(table) : 'SELECT * FROM agent_events LIMIT 10;',
    // One create-only statement prevents a partial CREATE/INSERT sequence or duplicate rows.
    seedSql: `CREATE TABLE ${table} AS
SELECT 1 AS id, 'APAC' AS region, 120 AS amount
UNION ALL SELECT 2, 'EMEA', 80
UNION ALL SELECT 3, 'AMER', 50
UNION ALL SELECT 4, 'APAC', 120
UNION ALL SELECT 5, 'EMEA', 100
UNION ALL SELECT 6, 'AMER', 40;`,
  };
}

export function matchesTotals(rows: Record<string, unknown>[]) {
  return (
    rows.length === expectedTotals.length &&
    expectedTotals.every(
      (expected, i) =>
        rows[i].region === expected.region && Number(rows[i].total) === expected.total,
    )
  );
}
