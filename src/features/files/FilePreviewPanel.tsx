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
import { fileFormat, isImageFile, isTabularFile } from './file-preview';
import { TabularFilePreview, useTabularPreview } from './TabularFilePreview';
import type { FileView } from './file-location';
import type { DatabaseCreationContext } from '../resources/resource-creation';

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
  image,
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
  databaseCreation,
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
  image: { mimeType: string; base64: string } | null;
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
  databaseCreation: DatabaseCreationContext;
}) {
  const imageFile = isImageFile(path);
  const [mode, setMode] = useState<string | null>(
    imageFile && initialView === 'source' ? 'preview' : initialView,
  );
  const [previewOpened, setPreviewOpened] = useState(mode !== 'source');
  const [expanded, setExpanded] = useState(initialView === 'analyze');
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [exportMode, setExportMode] = useState<'export' | 'table' | null>(null);
  const reportRunning = useCallback(
    (running: boolean) => {
      setAnalysisRunning(running);
      onAnalysisRunningChange(running);
    },
    [onAnalysisRunningChange],
  );
  const tabular = isTabularFile(path);
  const [imageError, setImageError] = useState(false);
  const tablePreview = useTabularPreview(
    resourceId,
    path,
    savedContent,
    previewOpened && tabular && !loading,
  );
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
        <>
          {tabular && (
            <Button
              variant="filled"
              disabled={busy || analysisRunning || loading}
              onClick={() => setExportMode('table')}
            >
              Create table
            </Button>
          )}
          <WorkspaceExportButton
            disabled={busy || analysisRunning || loading}
            onClick={() => setExportMode('export')}
          />
        </>
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
      ) : imageFile ? (
        image && !imageError ? (
          <img
            className="file-image-preview"
            src={`data:${image.mimeType};base64,${image.base64}`}
            alt={path.split('/').pop() || 'File preview'}
            onError={() => setImageError(true)}
          />
        ) : (
          <Alert color="yellow" title="Preview unavailable">
            This image could not be displayed. Use Export to download the file.
          </Alert>
        )
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
    if (loading) return;
    (initialView === 'source' && !imageFile ? source.current : title.current)?.focus({
      preventScroll: true,
    });
    if (window.matchMedia('(max-width: 1099px)').matches) {
      header.current?.scrollIntoView({ block: 'start' });
    }
    return () => {
      if (trigger?.isConnected)
        trigger.focus({ preventScroll: !window.matchMedia('(max-width: 1099px)').matches });
    };
  }, [trigger, initialView, imageFile, loading]);
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
            {!imageFile && fileFormat(path).kind !== 'parquet' && (
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
                  if (next === 'preview') setPreviewOpened(true);
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
            {imageFile
              ? 'IMAGE'
              : fileFormat(path).kind === 'code'
                ? 'Code'
                : fileFormat(path).kind.toUpperCase()}
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
        {!previewOpened ? null : imageFile ? (
          preview
        ) : (
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
              databaseCreation={databaseCreation}
            />
          </Suspense>
        )}
      </div>
      <div hidden={imageFile || mode !== 'source'}>
        <WorkspaceResultPanel title="Edit source" actions={fileActions}>
          <div className="file-preview-content">
            <Textarea
              ref={source}
              label="File content"
              aria-label="File content"
              description={loading ? 'Loading saved file…' : unavailableReason || undefined}
              className="file-source-editor"
              value={content}
              onChange={(event) => onChange(event.currentTarget.value)}
              spellCheck={false}
              disabled={busy || loading || !!unavailableReason}
              autosize
              minRows={14}
              maxRows={30}
            />
          </div>
        </WorkspaceResultPanel>
      </div>
      {exportMode && (
        <Suspense fallback={<Loader aria-label="Loading original export" />}>
          <FileExportDialog
            source={{ kind: 'original', resourceId, path }}
            sourcePath={path}
            createTable={exportMode === 'table'}
            size={tablePreview.data?.inputBytes ?? size}
            onDownloadOriginal={onDownload}
            onClose={() => setExportMode(null)}
            onSaved={onExportSaved}
            databaseCreation={databaseCreation}
          />
        </Suspense>
      )}
    </Paper>
  );
}
