import { useRef, useState } from 'react';
import { ActionIcon, Menu } from '@tidbcloud/uikit';
import {
  IconDotsHorizontal,
  IconDownload01,
  IconFile01,
  IconFolder,
  IconTrash01,
} from '@tidbcloud/uikit/icons';
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
            <FileItemActions file={file} busy={busy} onDownload={onDownload} onDelete={onDelete} />
          }
        />
      ))}
    </nav>
  );
}

function FileItemActions({
  file,
  busy,
  onDownload,
  onDelete,
}: {
  file: WorkspaceFile;
  busy: boolean;
  onDownload: (file: WorkspaceFile) => void;
  onDelete: (file: WorkspaceFile) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(true);
  return (
    <Menu
      position="bottom-end"
      withinPortal
      returnFocus={returnFocus}
      onOpen={() => setReturnFocus(true)}
    >
      <Menu.Target>
        <ActionIcon ref={trigger} aria-label={`Actions for ${file.path}`} title="Item actions">
          <IconDotsHorizontal size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {file.type === 'file' && (
          <Menu.Item leftSection={<IconDownload01 size={18} />} onClick={() => onDownload(file)}>
            Download
          </Menu.Item>
        )}
        <Menu.Item
          color="red"
          leftSection={<IconTrash01 size={18} />}
          disabled={busy}
          onClick={() => {
            setReturnFocus(false);
            trigger.current?.focus({ preventScroll: true });
            onDelete(file);
          }}
        >
          {file.type === 'directory' ? 'Delete folder' : 'Delete file'}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
