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
}: {
  name: string;
  description?: string;
  icon: ReactNode;
  active?: boolean;
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  actions?: ReactNode;
}) {
  const props = {
    label: name,
    description,
    leftSection: icon,
    active,
    title: name,
    onClick,
    p: 'sm',
    className: 'workspace-browser-item',
    classNames: { label: 'workspace-browser-item-label' },
    styles: { description: { color: 'inherit' }, root: { paddingRight: actions ? 60 : undefined } },
    'aria-current': active ? ('true' as const) : undefined,
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
