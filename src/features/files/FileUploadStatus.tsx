import { ActionIcon, Group, Loader, Paper, Progress, Stack, Text } from '@tidbcloud/uikit';
import { IconCheckCircle, IconXClose } from '@tidbcloud/uikit/icons';
import type { FileUploadStatus as UploadStatus } from './use-file-upload';

export function FileUploadStatus({
  status,
  onDismiss,
}: {
  status: UploadStatus;
  onDismiss: () => void;
}) {
  const done = status.phase === 'success';
  const failed = status.phase === 'error';
  const pending = !done && !failed;
  const percent =
    status.phase === 'uploading' && status.total
      ? Math.min(100, Math.floor(((status.loaded || 0) / status.total) * 100))
      : undefined;
  const label = {
    preparing: 'Preparing upload…',
    uploading: percent === undefined ? 'Uploading…' : `Uploading · ${percent}%`,
    saving: 'Saving to File System…',
    refreshing: 'File saved · Refreshing files…',
    success: 'Upload complete',
    error: 'Upload failed',
  }[status.phase];
  return (
    <Paper withBorder p="lg" mb="lg" aria-label="File upload status">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            <Group gap="sm" wrap="nowrap">
              {pending && <Loader size="sm" aria-hidden />}
              {done && <IconCheckCircle size={20} aria-hidden />}
              <Text fw={600} role={failed ? 'alert' : 'status'}>
                {label}
              </Text>
            </Group>
            <Text mt="xs">{status.name}</Text>
            <Text c="dimmed" fz={14}>
              {status.size.toLocaleString()} bytes · {status.path}
            </Text>
          </div>
          {!pending && (
            <ActionIcon variant="subtle" aria-label="Dismiss upload status" onClick={onDismiss}>
              <IconXClose size={18} />
            </ActionIcon>
          )}
        </Group>
        {!failed && (
          <Progress.Root
            size="md"
            role="progressbar"
            aria-label="File upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={done ? 100 : percent}
            aria-valuetext={label}
          >
            <Progress.Section
              value={done ? 100 : (percent ?? 100)}
              withAria={false}
              striped={pending && percent === undefined}
            />
          </Progress.Root>
        )}
        {status.phase === 'saving' && (
          <Text c="dimmed" fz={14}>
            Transfer complete. Waiting for the server to confirm the file was saved.
          </Text>
        )}
        {status.message && <Text c={failed ? 'red' : 'dimmed'}>{status.message}</Text>}
      </Stack>
    </Paper>
  );
}
