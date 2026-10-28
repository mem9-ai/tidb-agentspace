import { Fragment, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Anchor, Menu, Paper, TextInput } from '@tidbcloud/uikit';
import {
  IconChevronLeft,
  IconChevronRight,
  IconFilePlus01,
  IconFolder,
  IconFolderPlus,
  IconPlus,
  IconRefreshCw01,
  IconSearchLg,
} from '@tidbcloud/uikit/icons';

export function FileBrowserPanel({
  systemName,
  path,
  search,
  onSearch,
  onNavigate,
  onRefresh,
  refreshing,
  canCreate,
  onCreate,
  collapsible,
  collapsed,
  onToggle,
  footer,
  children,
}: {
  systemName: string;
  path: string;
  search: string;
  onSearch: (value: string) => void;
  onNavigate: (path: string) => void;
  onRefresh?: () => void;
  refreshing: boolean;
  canCreate: boolean;
  onCreate: (type: 'file' | 'directory') => void;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(true);
  function create(type: 'file' | 'directory') {
    // The menu item unmounts; make the stable trigger the dialog's focus-return target.
    setReturnFocus(false);
    createTrigger.current?.focus({ preventScroll: true });
    onCreate(type);
  }
  const parts = path.split('/').filter(Boolean);
  return (
    <Paper
      component="aside"
      className="panel file-browser"
      style={{ display: 'var(--workspace-file-browser-display, flex)' }}
      withBorder
      aria-label="File browser"
      data-collapsed={collapsed || undefined}
    >
      <div className="file-browser-heading">
        <nav className="path-crumb" aria-label="File path" hidden={collapsed}>
          <ActionIcon
            aria-label="File system root"
            title={systemName}
            onClick={() => onNavigate('/')}
          >
            <IconFolder size={20} />
          </ActionIcon>
          <div className="file-path-segments">
            <Anchor
              component="button"
              type="button"
              className="file-path-root"
              title={systemName}
              onClick={() => onNavigate('/')}
            >
              {systemName}
            </Anchor>
            {parts.map((part, index) => (
              <Fragment key={index}>
                <IconChevronRight size={14} aria-hidden />
                <Anchor
                  component="button"
                  type="button"
                  title={parts.slice(0, index + 1).join('/')}
                  aria-current={index === parts.length - 1 ? 'location' : undefined}
                  onClick={() => onNavigate('/' + parts.slice(0, index + 1).join('/'))}
                >
                  {part}
                </Anchor>
              </Fragment>
            ))}
          </div>
        </nav>
        {collapsible && (
          <ActionIcon
            className="file-browser-toggle"
            aria-label={collapsed ? 'Expand file browser' : 'Collapse file browser'}
            title={collapsed ? 'Expand file browser' : 'Collapse file browser'}
            aria-expanded={!collapsed}
            aria-controls="file-browser-content"
            onClick={onToggle}
          >
            {collapsed ? <IconChevronRight size={20} /> : <IconChevronLeft size={20} />}
          </ActionIcon>
        )}
      </div>
      <span className="file-browser-rail-label" aria-hidden hidden={!collapsed}>
        Files
      </span>
      <div id="file-browser-content" className="file-browser-content" hidden={collapsed}>
        <div className="file-toolbar">
          <TextInput
            aria-label="Search files"
            placeholder="Filter files…"
            value={search}
            leftSection={<IconSearchLg size={18} />}
            onChange={(event) => onSearch(event.currentTarget.value)}
          />
          {onRefresh && (
            <ActionIcon
              aria-label="Refresh files"
              title="Refresh files"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <IconRefreshCw01 size={20} />
            </ActionIcon>
          )}
          <Menu
            position="bottom-end"
            withinPortal
            returnFocus={returnFocus}
            onOpen={() => setReturnFocus(true)}
          >
            <Menu.Target>
              <ActionIcon
                ref={createTrigger}
                aria-label="Create file or folder"
                title="Create file or folder"
                disabled={!canCreate}
              >
                <IconPlus size={22} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={!canCreate}
                leftSection={<IconFilePlus01 size={18} />}
                onClick={() => create('file')}
              >
                New file
              </Menu.Item>
              <Menu.Item
                disabled={!canCreate}
                leftSection={<IconFolderPlus size={18} />}
                onClick={() => create('directory')}
              >
                New folder
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
        <div className="file-browser-list" role="region" aria-label="Files" tabIndex={0}>
          {children}
        </div>
        <footer className="file-browser-footer">{footer}</footer>
      </div>
    </Paper>
  );
}
