import type { ComponentType, ReactNode } from 'react';
import { Text } from '@tidbcloud/uikit';
import { IconFolder, type IconProps } from '@tidbcloud/uikit/icons';
import { Heading } from './WorkspaceHeading';

export function WorkspaceEmptyState({
  icon: Icon = IconFolder,
  title,
  description,
  action,
  details,
  label,
  headingLevel = 3,
}: {
  icon?: ComponentType<IconProps>;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  details?: ReactNode;
  label?: string;
  headingLevel?: 2 | 3;
}) {
  return (
    <section className="empty" aria-label={label || title}>
      <Icon size={28} aria-hidden />
      <Heading level={headingLevel}>{title}</Heading>
      <Text component="p">{description}</Text>
      {details}
      {action}
    </section>
  );
}
