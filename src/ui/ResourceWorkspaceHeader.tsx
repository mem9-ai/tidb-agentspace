import type { ReactNode } from 'react';
import { Badge, Button, NativeSelect, Text } from '@tidbcloud/uikit';
import { IconArrowUpRight } from '@tidbcloud/uikit/icons';
import type { Resource } from '../api/client';
import { Heading } from './WorkspaceHeading';
import { ResourceKindIcon } from './ResourceKindIcon';
import './resource-workspace.css';

export function ResourceConnectButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button onClick={onClick} disabled={disabled} rightSection={<IconArrowUpRight size={16} />}>
      Connect
    </Button>
  );
}

export function ResourceWorkspaceHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions: ReactNode;
}) {
  return (
    <header className="resource-workspace-heading">
      <div>
        <Heading level={1}>{title}</Heading>
        <Text c="carbon.7">{description}</Text>
      </div>
      <div className="resource-workspace-actions">{actions}</div>
    </header>
  );
}

export function ResourceWorkspaceBar({
  resource,
  resources,
  label,
  description,
  mode,
  live,
  disabled,
  onSelect,
  children,
}: {
  resource?: Resource;
  resources: Resource[];
  label: string;
  description: ReactNode;
  mode: string;
  live: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <section className="resource-workspace-bar" aria-label={`${label} context`}>
      <div className="resource-workspace-selection">
        <ResourceKindIcon kind={resource?.kind || 'filesystem'} />
        <div className="resource-workspace-select">
          <NativeSelect
            aria-label={label}
            title={resource?.name}
            value={resource?.id || ''}
            disabled={disabled || !resources.length}
            onChange={(event) => onSelect(event.currentTarget.value)}
          >
            {!resource && (
              <option value="">
                {resources.length ? 'Choose a resource' : 'No resources available'}
              </option>
            )}
            {resources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
          <Text size="sm" c="carbon.7">
            {description}
          </Text>
        </div>
        <Badge color={live ? 'green' : 'carbon'}>{mode}</Badge>
      </div>
      <div className="resource-workspace-meta">
        {children}
        <Badge color={resource?.status === 'active' ? 'green' : 'yellow'} variant="dot">
          {resource?.status || 'Unavailable'}
        </Badge>
      </div>
    </section>
  );
}
