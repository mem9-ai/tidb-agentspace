import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Text,
  Textarea,
  Loader,
} from '@tidbcloud/uikit';
import { IconArrowLeft, IconDownload01, IconXClose } from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
import { WorkspaceResultPanel } from '../../ui/WorkspaceQueryResults';
import { WorkspaceExportButton } from '../../ui/WorkspaceExportButton';
import { FileContent, FilePreviewBoundary } from './FileContent';
import { fileFormat, isTabularFile } from './file-preview';
import { TabularFilePreview, useTabularPreview } from './TabularFilePreview';
import type { FileView } from './file-location';

const FileExportDialog = lazy(() =>
  import('../exports/FileExportDialog').then((module) => ({ default: module.FileExportDialog })),
);
const FileAnalysisPanel = lazy(() => import('./FileAnalysisPanel'));

export default function FilePreviewPanel({
  path,
  resourceId,
  initialView,
  onViewChange,
  content,
  savedContent,
  size,
  loading = false,
  unavailableReason = '',
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
  onAnalysisRunningChange,
  onExportSaved,
}: {
  path: string;
  resourceId: string;
  initialView: FileView;
  onViewChange: (view: FileView) => void;
  content: string;
  savedContent: string;
  size?: number;
  loading?: boolean;
  unavailableReason?: string;
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
  onAnalysisRunningChange: (running: boolean) => void;
  onExportSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<string | null>(initialView);
  const [expanded, setExpanded] = useState(initialView === 'analyze');
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const reportRunning = useCallback(
    (running: boolean) => {
      setAnalysisRunning(running);
      onAnalysisRunningChange(running);
    },
    [onAnalysisRunningChange],
  );
  const tabular = isTabularFile(path);
  const tablePreview = useTabularPreview(resourceId, path, savedContent, tabular && !loading);
  const fileActions = (
    <Group gap="sm">
      {dirty ? (
        <Button
          leftSection={<IconDownload01 size={18} />}
          onClick={onDownload}
          disabled={busy || loading}
        >
          Download draft
        </Button>
      ) : (
        <WorkspaceExportButton
          disabled={busy || analysisRunning || loading}
          onClick={() => setExportOpen(true)}
        />
      )}
      {(mode === 'source' || dirty) && (
        <Button
          variant="filled"
          loading={busy}
          disabled={!dirty || busy || loading || !!unavailableReason}
          onClick={onSave}
        >
          Save changes
        </Button>
      )}
    </Group>
  );
  const previewContent = loading ? (
    <Group p="lg">
      <Loader aria-label="Loading file content" />
    </Group>
  ) : tabular && !dirty ? (
    <FilePreviewBoundary path={path} content={tablePreview.data?.fileVersion || tablePreview.error}>
      <TabularFilePreview
        {...tablePreview}
        onRefresh={tablePreview.refresh}
        disabled={busy || analysisRunning || dirty}
      />
    </FilePreviewBoundary>
  ) : (
    <div className="file-preview-content">
      {unavailableReason ? (
        <Alert color="yellow" title="Preview unavailable">
          {unavailableReason} Use Export to download the file and open it in another tool.
        </Alert>
      ) : (
        <FilePreviewBoundary path={path} content={content}>
          <FileContent path={path} content={content} />
        </FilePreviewBoundary>
      )}
    </div>
  );
  const preview = (
    <WorkspaceResultPanel title={tabular ? 'Data preview' : 'Preview'} actions={fileActions}>
      {previewContent}
    </WorkspaceResultPanel>
  );
  const title = useRef<HTMLSpanElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    (initialView === 'source' ? source.current : title.current)?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 1099px)').matches) {
      header.current?.scrollIntoView({ block: 'start' });
    }
    return () => {
      if (trigger?.isConnected)
        trigger.focus({ preventScroll: !window.matchMedia('(max-width: 1099px)').matches });
    };
  }, [trigger, initialView]);
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
      data-workspace
      aria-labelledby="file-preview-title"
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          event.target instanceof Node &&
          event.currentTarget.contains(event.target)
        ) {
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
            <Text size="sm" c="carbon.7" mt={4} className="file-preview-path">
              {path}
            </Text>
          </div>
          <Group gap={4} wrap="nowrap">
            {fileFormat(path).kind !== 'parquet' && (
              <Button
                variant="subtle"
                disabled={
                  busy ||
                  analysisRunning ||
                  loading ||
                  !!unavailableReason ||
                  fileFormat(path).kind === 'parquet'
                }
                onClick={() => {
                  const next = mode === 'source' ? 'preview' : 'source';
                  setMode(next);
                  onViewChange(next === 'source' ? next : expanded ? 'analyze' : 'preview');
                }}
              >
                {mode === 'source' ? 'Back to preview' : 'Edit source'}
              </Button>
            )}
            <ActionIcon aria-label="Close file preview" onClick={onClose} disabled={busy}>
              <IconXClose size={20} />
            </ActionIcon>
          </Group>
        </Group>
        <Group gap={10} mt={8}>
          <Badge>
            {fileFormat(path).kind === 'code' ? 'Code' : fileFormat(path).kind.toUpperCase()}
          </Badge>
          <Text size="sm" c="carbon.7">
            {(dirty
              ? new TextEncoder().encode(content).length
              : (tablePreview.data?.inputBytes ?? size ?? new TextEncoder().encode(content).length)
            ).toLocaleString()}{' '}
            bytes
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
      <div hidden={mode === 'source'}>
        <Suspense fallback={preview}>
          <FileAnalysisPanel
            key={resourceId + path}
            resourceId={resourceId}
            path={path}
            savedContent={savedContent}
            preview={preview}
            expanded={expanded}
            blocked={dirty || busy}
            onExpandedChange={(value) => {
              setExpanded(value);
              onViewChange(value ? 'analyze' : 'preview');
            }}
            previewVersion={tablePreview.data?.fileVersion}
            onRefreshPreview={tablePreview.refresh}
            onRunningChange={reportRunning}
            onExportSaved={onExportSaved}
          />
        </Suspense>
      </div>
      <div hidden={mode !== 'source'}>
        <WorkspaceResultPanel title="Edit source" actions={fileActions}>
          <div className="file-preview-content">
            <Textarea
              ref={source}
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
          </div>
        </WorkspaceResultPanel>
      </div>
      {exportOpen && (
        <Suspense fallback={<Loader aria-label="Loading original export" />}>
          <FileExportDialog
            source={{ kind: 'original', resourceId, path }}
            sourcePath={path}
            size={tablePreview.data?.inputBytes ?? size}
            onDownloadOriginal={onDownload}
            onClose={() => setExportOpen(false)}
            onSaved={onExportSaved}
          />
        </Suspense>
      )}
    </Paper>
  );
}
