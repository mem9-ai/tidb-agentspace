import { useState } from 'react';
import { Button, Stack, Text } from '@tidbcloud/uikit';
import {
  rememberWorkspaceFilesEntry,
  reportFilesHash,
  reportAccountHash,
} from '../navigation/upload-entry';
import { reportMarkdown } from './report-insights';
import type { SalesReport } from './TrialReportContent';
import { prepareReportFiles } from './report-files';

export function OpenReportFiles({
  report,
  markets = false,
  account = false,
}: {
  report: SalesReport;
  markets?: boolean;
  account?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    try {
      await prepareReportFiles(reportMarkdown(report, markets), report.revision, markets);
      if (!account) rememberWorkspaceFilesEntry();
      location.assign(
        location.pathname.replace(/\/report\/?$/, '/') +
          (account ? reportAccountHash : reportFilesHash),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The report files could not be prepared. Try again.',
      );
      setBusy(false);
    }
  }
  return (
    <Stack gap="xs">
      <Button
        variant={account ? 'filled' : 'default'}
        w="fit-content"
        loading={busy}
        onClick={() => void open()}
      >
        {account ? 'Continue with TiDB Cloud' : 'Open report files'}
      </Button>
      {error && <Text role="alert">{error}</Text>}
    </Stack>
  );
}
