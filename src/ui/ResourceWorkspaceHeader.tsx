import type { ReactNode } from 'react';
import { Badge, Button, NativeSelect, Popover, Stack, VisuallyHidden } from '@tidbcloud/uikit';
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconDatabase01,
  IconFolder,
} from '@tidbcloud/uikit/icons';
import type { Resource } from '../api/client';
import { Heading } from './WorkspaceHeading';
import './resource-workspace.css';

export function ResourceConnectButton({
  onClick,
  disabled,
  ariaLabel,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      rightSection={<IconArrowUpRight size={16} />}
    >
      Connect
    </Button>
  );
}

export function ResourceTutorialButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="subtle" onClick={onClick} disabled={disabled}>
      Tutorial
    </Button>
  );
}

export function ResourceCollectionButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="subtle"
      leftSection={<IconArrowLeft size={18} />}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

export function ResourceWorkspaceHeader({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="resource-workspace-heading">
      <VisuallyHidden>
        <Heading level={1}>{title}</Heading>
      </VisuallyHidden>
      {children}
      <div className="resource-workspace-actions">{actions}</div>
    </header>
  );
}

export function ResourceDetails({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Popover width={340} position="bottom-end" withinPortal trapFocus returnFocus>
      <Popover.Target>
        <Button variant="subtle">Details</Button>
      </Popover.Target>
      <Popover.Dropdown maw="calc(100vw - 32px)">
        <Stack gap="sm">
          <Heading level={2}>{title}</Heading>
          {children}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function ResourceWorkspaceBar({
  resource,
  resources,
  label,
  mode,
  live,
  disabled,
  onSelect,
}: {
  resource?: Resource;
  resources: Resource[];
  label: string;
  mode: string;
  live: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const Icon = resource?.kind === 'filesystem' || !resource ? IconFolder : IconDatabase01;
  const kinds: Record<string, string> = { postgresql: 'PostgreSQL', filesystem: '' };
  const active = resource?.status === 'active';
  return (
    <section className="resource-workspace-bar" aria-label={`${label} context`}>
      <div className="resource-workspace-select">
        <NativeSelect
          aria-label={label}
          title={resource?.name}
          value={resource?.id || ''}
          disabled={disabled || !resources.length}
          leftSection={<Icon size={18} aria-hidden />}
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
              {kinds[item.kind] ? ` · ${kinds[item.kind]}` : ''}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Badge
        className="resource-workspace-status"
        color={
          resource?.status === 'failed' ? 'red' : active ? (live ? 'green' : 'carbon') : 'yellow'
        }
      >
        {resource ? (active ? mode : `${mode} · ${resource.status}`) : 'Unavailable'}
      </Badge>
    </section>
  );
}
