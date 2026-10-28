import { useId, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Menu, Paper, Popover, Text } from '@tidbcloud/uikit';
import { IconMaximize02, IconMinimize02, IconPlay } from '@tidbcloud/uikit/icons';
import { Heading } from './WorkspaceHeading';
import './workspace-execution.css';

export function WorkspaceExecutionPanel({
  title = 'SQL Editor',
  runLabel = 'Run query',
  cancelLabel = 'Cancel query',
  busy,
  disabled,
  onRun,
  onCancel,
  context,
  samples,
  onSample,
  limits,
  children,
}: {
  title?: string;
  runLabel?: string;
  cancelLabel?: string;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
  onCancel?: () => void;
  context: ReactNode;
  samples: { label: string; value: string }[];
  onSample: (value: string) => void;
  limits: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const editorId = useId();
  return (
    <Paper className="panel workspace-execution" data-expanded={expanded || undefined} withBorder>
      <div className="workspace-execution-toolbar">
        <Heading level={2}>{title}</Heading>
        <div className="workspace-execution-actions">
          {busy && onCancel && <Button onClick={onCancel}>{cancelLabel}</Button>}
          <Button
            variant="filled"
            loading={busy}
            leftSection={<IconPlay size={18} />}
            disabled={busy || disabled}
            onClick={onRun}
          >
            {busy ? 'Running…' : runLabel}
          </Button>
        </div>
      </div>
      <div id={editorId}>{children}</div>
      <div className="workspace-execution-footer">
        <Text size="sm">{context}</Text>
        <div className="workspace-execution-tools">
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button variant="subtle" disabled={busy}>
                Samples
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {samples.map((sample) => (
                <Menu.Item
                  key={sample.label}
                  disabled={busy}
                  onClick={() => onSample(sample.value)}
                >
                  {sample.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Popover width={320} position="bottom-end" withinPortal trapFocus returnFocus>
            <Popover.Target>
              <Button variant="subtle">Limits</Button>
            </Popover.Target>
            <Popover.Dropdown maw="calc(100vw - 32px)">
              <Text>{limits}</Text>
              <Text size="sm" mt="sm">
                ⌘ / Ctrl + Enter to run
              </Text>
            </Popover.Dropdown>
          </Popover>
          <ActionIcon
            size={48}
            aria-label={expanded ? 'Collapse editor' : 'Expand editor'}
            title={expanded ? 'Collapse editor' : 'Expand editor'}
            aria-expanded={expanded}
            aria-controls={editorId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <IconMinimize02 size={20} /> : <IconMaximize02 size={20} />}
          </ActionIcon>
        </div>
      </div>
    </Paper>
  );
}
