import { Button, Group, Paper, Stack, Text } from '@tidbcloud/uikit';
import { useState } from 'react';
import { reportAccountHash } from '../navigation/upload-entry';
import { prepareSavedReportFiles } from './report-files';

export function TemporaryReportNotice({
  resourceId,
  workspaceId,
  reportPath,
  disabled,
  beforeLeave,
}: {
  resourceId: string;
  workspaceId: string;
  reportPath: string;
  disabled: boolean;
  beforeLeave: (action: () => void) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await prepareSavedReportFiles(resourceId, reportPath, workspaceId);
      const target = new URL(location.href);
      target.hash = reportAccountHash;
      // Re-enter bootstrap so an existing Guest takes the account sign-in path.
      history.replaceState(null, '', target);
      location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare your files. Try again.');
      setBusy(false);
    }
  }
  return (
    <Paper component="section" withBorder p="md" mb="lg" aria-labelledby="temporary-report">
      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <div>
            <Text id="temporary-report" fw={600}>
              Temporary workspace · 48-hour trial
            </Text>
            <Text size="sm">
              Keep this report and its data beyond the trial by saving them to your TiDB Cloud
              account.
            </Text>
          </div>
          <Button
            variant="default"
            loading={busy}
            disabled={disabled}
            onClick={() => beforeLeave(() => void save())}
          >
            Save to TiDB Cloud
          </Button>
        </Group>
        {error && <Text role="alert">{error}</Text>}
      </Stack>
    </Paper>
  );
}
