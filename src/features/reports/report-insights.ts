import { salesReport } from '../portal/sales-insights';
import type { SalesReport } from './TrialReportContent';
import { samplePath } from './report-files';

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

export function reportMarkdown(report: SalesReport, markets: boolean) {
  if (!markets && report.revision === 2) {
    return salesReport(
      samplePath,
      report.states.map(([label, sales]) => ({ label, sales })),
      report.products.map(([label, sales]) => ({ label, sales })),
    );
  }
  const insight = marketInsight(report.states);
  const states = `| State | Sales |\n| --- | ---: |\n${report.states.map(([name, value]) => `| ${name} | ${money.format(value)} |`).join('\n')}`;
  return `# Top two states\n\n**${insight.percentage} of total sales**\n\n${insight.calculation}\n\n${insight.share}\n\nSource: ${samplePath}\n\n## Sales by state\n\n${states}\n`;
}
