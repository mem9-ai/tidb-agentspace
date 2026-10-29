import { useId, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Menu, Paper, Text } from '@tidbcloud/uikit';
import {
  IconCode02,
  IconDotsHorizontal,
  IconMaximize02,
  IconMinimize02,
  IconPlay,
  IconStopSquare,
  IconTerminal,
} from '@tidbcloud/uikit/icons';
import { WorkspaceModal } from './WorkspaceModal';
import './workspace-execution.css';

export function WorkspaceExecutionPanel({
  language = 'SQL',
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
  language?: 'SQL' | 'Bash';
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
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState(true);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  return (
    <>
      <Paper
        component="section"
        aria-label={language === 'SQL' ? 'SQL editor' : 'Bash command editor'}
        className="panel workspace-execution"
        data-expanded={expanded || undefined}
        withBorder
      >
        <div className="workspace-execution-toolbar">
          <div className="workspace-execution-language">
            {language === 'SQL' ? (
              <IconCode02 size={16} aria-hidden />
            ) : (
              <IconTerminal size={16} aria-hidden />
            )}
            <Text component="span" size="sm" fw={600} ff="var(--mantine-font-family-monospace)">
              {language}
            </Text>
          </div>
          <Text className="workspace-execution-context" size="sm" c="carbon.7" m={0}>
            {context}
          </Text>
          <div className="workspace-execution-actions">
            <Menu
              position="bottom-end"
              withinPortal
              returnFocus={returnFocus}
              onOpen={() => setReturnFocus(true)}
            >
              <Menu.Target>
                <ActionIcon ref={toolsTrigger} aria-label="Editor tools" title="Editor tools">
                  <IconDotsHorizontal size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Samples</Menu.Label>
                {samples.map((sample) => (
                  <Menu.Item
                    key={sample.label}
                    disabled={busy}
                    onClick={() => onSample(sample.value)}
                  >
                    {sample.label}
                  </Menu.Item>
                ))}
                <Menu.Divider />
                <Menu.Item
                  leftSection={
                    expanded ? <IconMinimize02 size={18} /> : <IconMaximize02 size={18} />
                  }
                  aria-controls={editorId}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? 'Collapse editor' : 'Expand editor'}
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setReturnFocus(false);
                    toolsTrigger.current?.focus({ preventScroll: true });
                    setLimitsOpen(true);
                  }}
                >
                  Limits
                </Menu.Item>
                <Menu.Label>⌘ / Ctrl + Enter to run</Menu.Label>
              </Menu.Dropdown>
            </Menu>
            {busy && onCancel && (
              <ActionIcon aria-label={cancelLabel} title={cancelLabel} onClick={onCancel}>
                <IconStopSquare size={18} />
              </ActionIcon>
            )}
            <Button
              variant="filled"
              loading={busy}
              leftSection={<IconPlay size={18} />}
              disabled={busy || disabled}
              onClick={onRun}
              title={`${runLabel} (⌘ / Ctrl + Enter)`}
            >
              {busy ? 'Running…' : runLabel}
            </Button>
          </div>
        </div>
        <div id={editorId}>{children}</div>
      </Paper>
      {limitsOpen && (
        <WorkspaceModal
          title={language === 'SQL' ? 'Query limits' : 'Command limits'}
          size={420}
          onClose={() => setLimitsOpen(false)}
        >
          <Text>{limits}</Text>
          <Text size="sm" c="carbon.7" mt="md">
            ⌘ / Ctrl + Enter to run
          </Text>
        </WorkspaceModal>
      )}
    </>
  );
}
