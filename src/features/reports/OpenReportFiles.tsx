import { useState } from 'react';
import { Button, Stack, Text } from '@tidbcloud/uikit';
import { rememberWorkspaceFilesEntry, reportFilesHash } from '../navigation/upload-entry';
import { salesReport } from '../portal/sales-insights';
import type { SalesReport } from './TrialReportContent';
import { prepareReportFiles, samplePath } from './report-files';

export function OpenReportFiles({ report }: { report: SalesReport }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    try {
      const content = salesReport(
        samplePath,
        report.states.map(([label, sales]) => ({ label, sales })),
        report.products.map(([label, sales]) => ({ label, sales })),
      );
      await prepareReportFiles(content, 2);
      rememberWorkspaceFilesEntry();
      location.assign(location.pathname.replace(/\/report\/?$/, '/') + reportFilesHash);
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
      <Button variant="filled" w="fit-content" loading={busy} onClick={() => void open()}>
        Open report files
      </Button>
      {error && <Text role="alert">{error}</Text>}
    </Stack>
  );
}
