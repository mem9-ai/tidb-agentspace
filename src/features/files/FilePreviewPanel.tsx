import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Tabs,
  Text,
  Textarea,
} from '@tidbcloud/uikit';
import { IconArrowLeft, IconDownload01, IconXClose } from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
import { FileContent, FilePreviewBoundary } from './FileContent';
import { fileFormat } from './file-preview';

export default function FilePreviewPanel({
  path,
  content,
  dirty,
  busy,
  error,
  pendingChange,
  trigger,
  onChange,
  onClose,
  onSave,
  onDownload,
  onKeepEditing,
  onDiscard,
}: {
  path: string;
  content: string;
  dirty: boolean;
  busy: boolean;
  error: string;
  pendingChange: boolean;
  trigger: HTMLElement | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDownload: () => void;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  const [mode, setMode] = useState<string | null>('preview');
  const title = useRef<HTMLSpanElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 1099px)').matches) {
      header.current?.scrollIntoView({ block: 'start' });
    }
    return () => {
      if (trigger?.isConnected)
        trigger.focus({ preventScroll: !window.matchMedia('(max-width: 1099px)').matches });
    };
  }, [trigger]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return (
    <Paper
      component="aside"
      style={{ display: 'flex' }}
      withBorder
      className="file-preview-panel"
      aria-labelledby="file-preview-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header ref={header} className="file-preview-header">
        <div className="file-preview-back">
          <Button leftSection={<IconArrowLeft size={18} />} onClick={onClose} disabled={busy}>
            Back to files
          </Button>
        </div>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div className="file-preview-identity">
            <Heading level={2}>
              <span id="file-preview-title" ref={title} tabIndex={-1}>
                {path.split('/').pop()}
              </span>
            </Heading>
            <Text size="sm" c="carbon.7" mt={8} className="file-preview-path">
              {path}
            </Text>
          </div>
          <ActionIcon aria-label="Close file preview" onClick={onClose} disabled={busy}>
            <IconXClose size={20} />
          </ActionIcon>
        </Group>
        <Group gap={10} mt={16}>
          <Badge>
            {fileFormat(path).kind === 'code' ? 'Code' : fileFormat(path).kind.toUpperCase()}
          </Badge>
          <Text size="sm" c="carbon.7">
            {new TextEncoder().encode(content).length.toLocaleString()} bytes
          </Text>
          {dirty && <Badge color="yellow">Unsaved changes</Badge>}
        </Group>
      </header>
      {pendingChange && (
        <Alert color="yellow" title="Keep your changes?" className="file-preview-message">
          This file has unsaved changes.
          <Group mt={16}>
            <Button onClick={onKeepEditing}>Keep editing</Button>
            <Button color="red" onClick={onDiscard}>
              Discard changes
            </Button>
          </Group>
        </Alert>
      )}
      {error && (
        <Alert color="red" className="file-preview-message">
          {error}
        </Alert>
      )}
      <Tabs
        value={mode}
        onChange={setMode}
        className="file-preview-tabs"
        style={{ display: 'flex', flexDirection: 'column' }}
        keepMounted={false}
      >
        <Tabs.List px={24}>
          <Tabs.Tab value="preview">Preview</Tabs.Tab>
          <Tabs.Tab value="source">Edit source</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="preview" className="file-preview-content">
          <FilePreviewBoundary path={path} content={content}>
            <FileContent path={path} content={content} />
          </FilePreviewBoundary>
        </Tabs.Panel>
        <Tabs.Panel value="source" className="file-preview-content">
          <Textarea
            label="File content"
            aria-label="File content"
            className="file-source-editor"
            value={content}
            onChange={(event) => onChange(event.currentTarget.value)}
            spellCheck={false}
            disabled={busy}
            autosize
            minRows={14}
            maxRows={30}
          />
        </Tabs.Panel>
      </Tabs>
      <footer className="file-preview-footer">
        <Button leftSection={<IconDownload01 size={18} />} onClick={onDownload}>
          {dirty ? 'Download draft' : 'Download'}
        </Button>
        <Button variant="filled" loading={busy} disabled={!dirty || busy} onClick={onSave}>
          Save changes
        </Button>
      </footer>
    </Paper>
  );
}
