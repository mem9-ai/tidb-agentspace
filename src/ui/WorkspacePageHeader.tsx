import type { ReactNode } from 'react';
import { Text } from '@tidbcloud/uikit';
import { Heading } from './WorkspaceHeading';

export function WorkspacePageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <Heading level={1}>{title}</Heading>
        <Text component="p">{description}</Text>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </header>
  );
}
