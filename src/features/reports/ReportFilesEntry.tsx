import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Select, Stack, Text } from '@tidbcloud/uikit';
import type { Data } from '../../api/client';
import { fileHash } from '../files/file-location';
import { clearReportFiles, readReportFiles, reportPath, saveReportFiles } from './report-files';

export function ReportFilesEntry({
  data,
  refresh,
  onCreate,
}: {
  data: Data & { resourceWindowTruncated?: boolean };
  refresh: () => Promise<void>;
  onCreate: () => void;
}) {
  const [files] = useState(readReportFiles);
  const systems = data.resources.filter(
    (r) => r.kind === 'filesystem' && r.status === 'active' && !r.connectionError,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const target =
    selected ??
    systems.find((r) => r.isDefault)?.id ??
    (systems.length === 1 && !data.resourceNextCursor && !data.resourceWindowTruncated
      ? systems[0].id
      : undefined);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  useEffect(() => {
    if (!files || !target || running.current) return;
    let active = true;
    running.current = true;
    setError('');
    void saveReportFiles(files, target, data.workspace.id)
      .then(async () => {
        if (!active) return;
        await refresh();
        if (!active) return;
        clearReportFiles();
        location.replace(fileHash(target, reportPath(files), 'preview') + '&from=report');
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : 'Could not save the report files. Try again.',
          );
      })
      .finally(() => {
        running.current = false;
      });
    return () => {
      active = false;
    };
  }, [files, target, data.workspace.id, refresh, attempt]);

  if (!files)
    return (
      <Alert title="Open the report to continue">
        Return to the report and choose “Open report in Workspace” again.
      </Alert>
    );
  return (
    <Stack gap="md">
      <Text role="status">
        {error
          ? 'Your report files are not ready yet.'
          : target
            ? 'Saving your report and source data…'
            : 'Choose where to save your report and source data.'}
      </Text>
      {!systems.length && <Button onClick={onCreate}>Create file system</Button>}
      {(systems.length > 1 || error || (!target && systems.length)) && (
        <Select
          label="File system"
          disabled={Boolean(target && !error)}
          data={systems.map((r) => ({ value: r.id, label: r.name }))}
          value={target ?? null}
          onChange={setSelected}
          allowDeselect={false}
        />
      )}
      {error && (
        <Alert color="red" title="Could not open report files">
          {error}
          <Button mt="sm" onClick={() => setAttempt((v) => v + 1)}>
            Try again
          </Button>
        </Alert>
      )}
    </Stack>
  );
}
