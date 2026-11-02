import type { Resource } from '../../api/client';

export const ordersCsv = `id,region,amount
1,APAC,120
2,EMEA,80
3,AMER,50
4,APAC,120
5,EMEA,100
6,AMER,40
`;

export const orderRows = [
  { id: 1, region: 'APAC', amount: 120 },
  { id: 2, region: 'EMEA', amount: 80 },
  { id: 3, region: 'AMER', amount: 50 },
  { id: 4, region: 'APAC', amount: 120 },
  { id: 5, region: 'EMEA', amount: 100 },
  { id: 6, region: 'AMER', amount: 40 },
];

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

export const fileExamples = {
  notes: {
    suffix: 'notes.md',
    title: 'Read agent notes',
    description: 'Preview a Markdown handoff with context for an agent.',
    content: `# Project handoff

The team is reviewing sales by region.

- APAC: 240
- EMEA: 180
- AMER: 90

Next: investigate the failed sync in the activity log.
`,
  },
  log: {
    suffix: 'activity.log',
    title: 'Find errors with Bash',
    description: 'Open Editor tools and choose Find errors to locate the failed sync.',
    content: `2026-10-30T09:00:00Z INFO sync started
2026-10-30T09:01:00Z ERROR APAC sync timed out
2026-10-30T09:02:00Z INFO sync retried
2026-10-30T09:03:00Z INFO sync completed
`,
  },
} as const;

export type FileExampleKind = keyof typeof fileExamples;
export function fileExamplePath(id: string, kind: FileExampleKind) {
  tutorialSample(id); // Validate the workspace-saved identifier before constructing a path.
  return `/tutorial-${id}-${fileExamples[kind].suffix}`;
}
