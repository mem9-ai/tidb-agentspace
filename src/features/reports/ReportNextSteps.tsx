import { Button, Group, Paper, Stack, Text, Title } from '@tidbcloud/uikit';
import { useState } from 'react';
import { globalApiSettings, type Resource } from '../../api/client';
import { workspaceSkillTask, workspaceSkillUrl } from '../../api/agent-instructions';
import { fileHash } from '../files/file-location';
import { SalesFollowUp, followUpStorageKey } from '../portal/SalesFollowUp';

const nextReport = '/US sales order values.md';

export function ReportNextSteps({
  resource,
  workspaceId,
  copy,
  connected,
  onConnect,
  onExplore,
}: {
  resource: Resource;
  workspaceId: string;
  copy: (value: string) => Promise<boolean>;
  connected?: { started: boolean };
  onConnect: (prompt: string) => void;
  onExplore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [instructions, setInstructions] = useState('');
  const [resuming] = useState(() => {
    try {
      return (
        sessionStorage.getItem(followUpStorageKey(workspaceId, resource.id, nextReport)) ===
        'waiting'
      );
    } catch {
      return false;
    }
  });
  async function connect() {
    setBusy(true);
    setError('');
    try {
      const settings = await globalApiSettings();
      const link = new URL(location.href);
      link.hash = fileHash(resource.id, nextReport, 'preview');
      const prompt = workspaceSkillTask(
        settings.endpoint,
        workspaceSkillUrl(location.origin, location.pathname),
        `Continue in my Workspace File System ${resource.id}. Read /US sales sample.csv, which is already saved; do not ask me to upload it again. Compare average order value by state using read-only file analysis. sales_usd is the line total; do not multiply it by quantity. Save a concise Markdown analysis to ${nextReport} only if absent; if it exists, read and reuse it. Do not overwrite or blindly retry an uncertain write. Give me the finding and this link to the saved report: ${link.href}.`,
      );
      setInstructions(prompt);
      onConnect(prompt);
    } catch {
      setError('Could not load the connection details. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Paper component="section" withBorder p="lg" mb="lg" aria-labelledby="report-ready">
      <Stack gap="sm">
        <Title order={2} id="report-ready">
          Your report and data are ready
        </Title>
        <Text>
          {connected || resuming
            ? 'Your next analysis will appear here after your agent saves it.'
            : 'Connect your coding agent to keep working with these files, or open the sample data to explore it here.'}
        </Text>
        {connected || resuming ? (
          <SalesFollowUp
            workspaceId={workspaceId}
            resourceId={resource.id}
            instructions={instructions}
            enabled={Boolean(instructions)}
            copy={copy}
            started={connected?.started || resuming}
            path={nextReport}
            description="Compare average order value by state using your saved sample."
          />
        ) : (
          <Group>
            <Button loading={busy} onClick={() => void connect()}>
              Connect my agent
            </Button>
            <Button variant="default" onClick={onExplore}>
              Explore sample data
            </Button>
          </Group>
        )}
        {error && <Text role="alert">{error}</Text>}
      </Stack>
    </Paper>
  );
}
