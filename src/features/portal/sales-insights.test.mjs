import test from 'node:test';
import assert from 'node:assert/strict';
import { salesByProductSql, salesReport, salesTotals } from './sales-insights.ts';

test('sales insights use returned data and safely quote state names', () => {
  assert.match(salesByProductSql("St. John's"), /state = 'St\. John''s'/);
  const states = salesTotals({ rows: [{ state: 'Texas', sales: '5000' }] }, 'state');
  const products = salesTotals({ rows: [{ product: 'Chairs', sales: 1700 }] }, 'product');
  const report = salesReport('/us-sales.csv', states, products);
  assert.match(report, /Texas with \$5,000\.00/);
  assert.match(report, /Chairs with \$1,700\.00/);
  assert.match(report, /Source: \/us-sales\.csv/);
  assert.equal(salesTotals({ rows: [{ state: 'Texas', sales: 'unknown' }] }, 'state'), null);
});
