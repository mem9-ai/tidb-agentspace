import { ActionIcon } from '@tidbcloud/uikit';
import { IconDownload01, IconFile01, IconFolder, IconTrash01 } from '@tidbcloud/uikit/icons';
import type { WorkspaceFile } from './remote-files';
import { WorkspaceBrowserItem } from '../../ui/WorkspaceBrowserItem';

export function FileBrowserList({
  files,
  path,
  selectedId,
  busy,
  describeFile,
  onNavigate,
  onOpen,
  onDownload,
  onDelete,
}: {
  files: WorkspaceFile[];
  path: string;
  selectedId?: string;
  busy: boolean;
  describeFile: (file: WorkspaceFile) => string;
  onNavigate: (path: string) => void;
  onOpen: (file: WorkspaceFile, trigger: HTMLElement) => void;
  onDownload: (file: WorkspaceFile) => void;
  onDelete: (file: WorkspaceFile) => void;
}) {
  return (
    <nav className="workspace-browser-entries" aria-label="File entries">
      {path !== '/' && (
        <WorkspaceBrowserItem
          name="Parent folder"
          icon={<IconFolder size={20} />}
          onClick={() => onNavigate(path.slice(0, path.lastIndexOf('/')) || '/')}
        />
      )}
      {files.map((file) => (
        <WorkspaceBrowserItem
          key={file.id}
          name={file.path.split('/').pop() || file.path}
          description={describeFile(file)}
          icon={file.type === 'directory' ? <IconFolder size={20} /> : <IconFile01 size={20} />}
          active={selectedId === file.id}
          onClick={(event) =>
            file.type === 'directory' ? onNavigate(file.path) : onOpen(file, event.currentTarget)
          }
          actions={
            <>
              {file.type === 'file' && (
                <ActionIcon
                  aria-label={`Download ${file.path}`}
                  title="Download"
                  onClick={() => onDownload(file)}
                >
                  <IconDownload01 size={18} />
                </ActionIcon>
              )}
              <ActionIcon
                aria-label={`Delete ${file.path}`}
                title="Delete"
                disabled={busy}
                onClick={() => onDelete(file)}
              >
                <IconTrash01 size={18} />
              </ActionIcon>
            </>
          }
        />
      ))}
    </nav>
  );
}
