import { Paper, Text, Title } from '@tidbcloud/uikit';
import { OpenReportFiles } from './OpenReportFiles';
import { TrialPrompt } from './TrialPrompt';
import { marketInsight } from './report-insights';

type Rows = [string, number][];
export type SalesReport = {
  id: string;
  markdown: string;
  revision: 1 | 2;
  expiresAt: number;
  states: Rows;
  products: Rows;
};
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const share = (amount: number, total: number) =>
  new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(
    amount / total,
  );

function StateRankings({ states, total }: { states: Rows; total: number }) {
  return (
    <table aria-label="Sales by state">
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col">Sales</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {states.map(([state, n]) => (
          <tr key={state}>
            <th scope="row">{state}</th>
            <td>{money.format(n)}</td>
            <td>{share(n, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProductAnalysis({
  state,
  sales,
  products,
}: {
  state: string;
  sales: number;
  products: Rows;
}) {
  const [product, revenue] = products[0];
  return (
    <>
      <Paper className="product-spotlight" withBorder>
        <Text fw={600}>Top product in {state}</Text>
        <Title order={1}>{product}</Title>
        <dl className="product-metrics">
          <div>
            <dt>Product sales</dt>
            <dd>{money.format(revenue)}</dd>
          </div>
          <div>
            <dt>Share of state sales</dt>
            <dd>{share(revenue, sales)}</dd>
          </div>
        </dl>
      </Paper>
      <section aria-labelledby="product-comparison">
        <Title order={2} id="product-comparison">
          Sales by product
        </Title>
        <Text size="sm" c="var(--text-secondary)">
          {state} · {money.format(sales)} total
        </Text>
        <ol className="product-ranking">
          {products.map(([name, amount]) => (
            <li key={name}>
              <div className="product-row-label">
                <span>{name}</span>
                <strong>{money.format(amount)}</strong>
              </div>
              <div
                aria-hidden="true"
                className="product-bar"
                style={{ width: `${(100 * amount) / revenue}%` }}
              />
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

export function TrialReportContent({ report }: { report: SalesReport }) {
  const markets = new URLSearchParams(location.search).get('view') === 'markets';
  const insight = marketInsight(report.states);
  const [[leader, sales]] = report.states;
  const total = report.states.reduce((sum, [, n]) => sum + n, 0);
  const expires = new Date(report.expiresAt * 1000);
  const stateFinding = (
    <p className="report-lead">
      <strong>{leader}</strong> leads with <strong>{money.format(sales)}</strong> in sales,{' '}
      {share(sales, total)} of the {money.format(total)} total.
    </p>
  );
  return (
    <>
      <Text size="sm" c="var(--text-secondary)">
        Public US sales sample · Revision {report.revision}
        {report.revision === 2 && ' · Complete'}
      </Text>
      {report.revision === 2 || markets ? (
        <>
          {markets ? (
            <Paper className="product-spotlight" withBorder>
              <Text fw={600}>Sales from your top two states</Text>
              <Title order={1}>{insight.percentage} of total sales</Title>
              <Text>{insight.calculation}</Text>
              <Text>{insight.share}</Text>
            </Paper>
          ) : (
            <ProductAnalysis state={leader} sales={sales} products={report.products} />
          )}
          <details className="original-analysis">
            <summary>Original state rankings</summary>
            {stateFinding}
            <StateRankings states={report.states} total={total} />
          </details>
          <section aria-labelledby="own-sales">
            <Title order={2} id="own-sales">
              Continue with this report
            </Title>
            <Text mb="sm">
              Open the report alongside its source data, ready to explore in your workspace.
            </Text>
            <OpenReportFiles report={report} />
          </section>
        </>
      ) : (
        <>
          <Title order={1}>US sales report</Title>
          {stateFinding}
          <OpenReportFiles report={report} />
          <Paper component="section" withBorder p="md" aria-labelledby="next-question">
            <Title order={2} id="next-question">
              Which product brought in the most sales in {leader}?
            </Title>
            <Text mb="sm">
              Paste the question into your agent chat in the original project. This page updates
              automatically after your agent saves.
            </Text>
            <TrialPrompt leadingState={leader} />
          </Paper>
          <section aria-labelledby="state-sales">
            <Title order={2} id="state-sales">
              Sales by state
            </Title>
            <StateRankings states={report.states} total={total} />
          </section>
        </>
      )}
      <footer>
        <Text size="sm" c="var(--text-secondary)">
          Read-only link · Expires{' '}
          <time dateTime={expires.toISOString()}>
            {expires.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </time>
        </Text>
        <details>
          <summary>About this shared link</summary>
          <Text size="sm">
            Anyone with this link can read the public sample report until it expires. The report
            owner can ask their agent to stop sharing. Clearing local access alone does not close
            this link.
          </Text>
        </details>
      </footer>
    </>
  );
}
