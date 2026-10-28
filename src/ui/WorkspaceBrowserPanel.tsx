import { useId, type ReactNode } from 'react';
import { ActionIcon, Paper } from '@tidbcloud/uikit';
import { IconChevronLeft, IconChevronRight } from '@tidbcloud/uikit/icons';
import './workspace-browser.css';

// Keep browser chrome and collapse behavior consistent without unmounting active work.
export function WorkspaceBrowserPanel({
  className,
  label,
  heading,
  toolbar,
  listLabel,
  railLabel,
  collapsible = true,
  collapsed,
  onToggle,
  footer,
  children,
}: {
  className: string;
  label: string;
  heading: ReactNode;
  toolbar: ReactNode;
  listLabel: string;
  railLabel: string;
  collapsible?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const contentId = useId();
  return (
    <Paper
      component="aside"
      className={`panel workspace-browser ${className}`}
      style={{ display: 'var(--workspace-browser-display, flex)' }}
      withBorder
      aria-label={label}
      data-collapsed={collapsed || undefined}
    >
      <div className="workspace-browser-heading">
        <div className="workspace-browser-identity" hidden={collapsed}>
          {heading}
        </div>
        {collapsible && (
          <ActionIcon
            className="workspace-browser-toggle"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
            title={`${collapsed ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              onToggle();
            }}
          >
            {collapsed ? <IconChevronRight size={20} /> : <IconChevronLeft size={20} />}
          </ActionIcon>
        )}
      </div>
      <span className="workspace-browser-rail-label" aria-hidden hidden={!collapsed}>
        {railLabel}
      </span>
      <div id={contentId} className="workspace-browser-content" hidden={collapsed}>
        <div className="workspace-browser-toolbar">{toolbar}</div>
        <div className="workspace-browser-list" role="region" aria-label={listLabel} tabIndex={0}>
          {children}
        </div>
        {footer && <footer className="workspace-browser-footer">{footer}</footer>}
      </div>
    </Paper>
  );
}
