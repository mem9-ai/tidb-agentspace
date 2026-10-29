import type { MouseEvent, ReactNode } from 'react';
import { NavLink } from '@tidbcloud/uikit';

export function WorkspaceBrowserItem({
  name,
  description,
  icon,
  active = false,
  href,
  onClick,
  actions,
  expanded,
  controls,
  disclosure,
  disabled = false,
}: {
  name: string;
  description?: string;
  icon: ReactNode;
  active?: boolean;
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  actions?: ReactNode;
  expanded?: boolean;
  controls?: string;
  disclosure?: ReactNode;
  disabled?: boolean;
}) {
  const props = {
    label: name,
    description,
    leftSection: icon,
    rightSection: disclosure,
    active,
    disabled,
    title: name,
    onClick,
    px: 8,
    py: 4,
    pe: actions ? 60 : 8,
    className: 'workspace-browser-item',
    classNames: { label: 'workspace-browser-item-label' },
    styles: { description: { color: 'inherit' } },
    'aria-current': active ? ('true' as const) : undefined,
    'aria-expanded': expanded,
    'aria-controls': controls,
  };
  return (
    <div className="workspace-browser-row">
      {href ? (
        <NavLink component="a" href={href} {...props} />
      ) : (
        <NavLink component="button" type="button" {...props} />
      )}
      {actions && <div className="workspace-browser-row-actions">{actions}</div>}
    </div>
  );
}
