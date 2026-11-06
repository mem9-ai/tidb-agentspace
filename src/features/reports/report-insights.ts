import type { SalesReport } from './TrialReportContent';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
export function marketInsight(states: SalesReport['states']) {
  const leaders = states.slice(0, 2);
  const total = states.reduce((sum, [, value]) => sum + value, 0);
  const combined = leaders.reduce((sum, [, value]) => sum + value, 0);
  const percentage = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(combined / total);
  return {
    percentage,
    calculation: `${leaders.map(([name, value]) => `${name} (${money.format(value)})`).join(' + ')} = ${money.format(combined)}.`,
    share: `${money.format(combined)} ÷ ${money.format(total)} = ${percentage}.`,
  };
}
