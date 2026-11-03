import { useEffect, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  ActionIcon,
  Anchor,
  AppShell,
  Breadcrumbs,
  Button,
  Drawer,
  Group,
  NavLink,
  Stack,
  Text,
} from '@tidbcloud/uikit';
import { IconChevronRight, IconLogOut01, IconMenu01, IconSearchLg } from '@tidbcloud/uikit/icons';
import type { IconProps } from '@tidbcloud/uikit/icons';
import { ThemePicker } from '../features/theme/ThemePicker';

type NavigationItem = { id: string; label: string; group: string; icon: ComponentType<IconProps> };
type Props = {
  workspaceName: string;
  liveFiles?: boolean;
  liveDatabases?: boolean;
  isHostedSession?: boolean;
  profileName: string;
  active: string;
  databaseId?: string;
  fileSystemId?: string;
  resourceName?: string;
  databaseView?: 'tables' | 'sql';
  navigation: NavigationItem[];
  onSearch: () => void;
  onSignOut?: () => void;
  isGuest?: boolean;
  children: ReactNode;
};

export function WorkspaceLayout({
  workspaceName,
  liveFiles = false,
  liveDatabases = false,
  isHostedSession = false,
  profileName,
  active,
  databaseId,
  fileSystemId,
  resourceName,
  databaseView,
  navigation,
  onSearch,
  onSignOut,
  isGuest = false,
  children,
}: Props) {
  const [opened, setOpened] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    setOpened(false);
    setMoreOpen(['databases', 'tutorials', 'api', 'billing', 'settings'].includes(active));
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [active, databaseId, databaseView, fileSystemId]);
  const navigate = (page: string) => {
    location.hash = page;
    setOpened(false);
  };
  const sidebar = (
    <div className="sidebar-content">
      <Button fullWidth variant="default" onClick={() => navigate('settings')}>
        {isGuest ? 'Temporary workspace' : 'Personal workspace'}
      </Button>
      {!isHostedSession && !liveFiles && !liveDatabases && (
        <Text size="sm" c="carbon.7" mt={8}>
          Free plan · Local demo
        </Text>
      )}
      <nav aria-label="Main navigation">
        {isGuest ? (
          <>
            <Stack gap={6} mt={24}>
              {navigation
                .filter((item) => ['overview', 'files', 'connect', 'keys'].includes(item.id))
                .map((item) => (
                  <NavLink
                    component="a"
                    key={item.id}
                    href={`#${item.id}`}
                    active={active === item.id}
                    aria-current={active === item.id ? 'page' : undefined}
                    label={
                      item.id === 'overview'
                        ? 'Workspace'
                        : item.id === 'files'
                          ? 'Files'
                          : item.id === 'keys'
                            ? 'Access'
                            : item.label
                    }
                    leftSection={<item.icon size={20} />}
                    onClick={() => setOpened(false)}
                  />
                ))}
            </Stack>
            <details
              className="sidebar-more"
              open={moreOpen}
              onToggle={(event) => setMoreOpen(event.currentTarget.open)}
            >
              <summary>More</summary>
              {navigation
                .filter((item) =>
                  ['databases', 'tutorials', 'api', 'billing', 'settings'].includes(item.id),
                )
                .map((item) => (
                  <NavLink
                    component="a"
                    key={item.id}
                    href={`#${item.id}`}
                    active={active === item.id}
                    aria-current={active === item.id ? 'page' : undefined}
                    label={item.label}
                    leftSection={<item.icon size={20} />}
                    onClick={() => setOpened(false)}
                  />
                ))}
            </details>
          </>
        ) : (
          ['Workspace', 'Build', 'Manage'].map((group) => (
            <Stack key={group} gap={6} mt={24}>
              <Text size="sm" fw={600} c="carbon.7">
                {group}
              </Text>
              {navigation
                .filter((item) => item.group === group)
                .map((item) => (
                  <NavLink
                    component="a"
                    key={item.id}
                    href={`#${item.id}`}
                    active={active === item.id}
                    aria-current={active === item.id ? 'page' : undefined}
                    label={item.label}
                    leftSection={<item.icon size={20} />}
                    onClick={() => setOpened(false)}
                  />
                ))}
            </Stack>
          ))
        )}
      </nav>
      <div className="sidebar-bottom">
        <NavLink
          component="a"
          href="#settings"
          label={profileName}
          description={isGuest ? 'Temporary session' : 'Personal account'}
          onClick={() => setOpened(false)}
        />
        {onSignOut && (
          <NavLink
            component="button"
            label="Sign out"
            leftSection={<IconLogOut01 size={20} />}
            onClick={() => {
              setOpened(false);
              onSignOut();
            }}
          />
        )}
      </div>
    </div>
  );
  const label =
    (isGuest &&
      new Map([
        ['overview', 'Workspace'],
        ['files', 'Files'],
        ['keys', 'Access'],
      ]).get(active)) ||
    navigation.find((item) => item.id === active)?.label ||
    'Workspace';
  return (
    <AppShell
      header={{ height: 80 }}
      navbar={{ width: 272, breakpoint: 'sm', collapsed: { mobile: true } }}
      padding={0}
    >
      <AppShell.Header>
        <div className="workspace-header">
          <Anchor
            href="#overview"
            className="brand"
            underline="never"
            aria-label="TiDB Agent Workspace"
          >
            <span className="brand-mark">TiDB</span>
            <Text span fw={600}>
              Agent Workspace
            </Text>
          </Anchor>
          <ActionIcon hiddenFrom="sm" aria-label="Open navigation" onClick={() => setOpened(true)}>
            <IconMenu01 size={22} />
          </ActionIcon>
          <Breadcrumbs
            visibleFrom="sm"
            className="workspace-breadcrumbs"
            separator={<IconChevronRight size={14} />}
          >
            <Text className="workspace-crumb" size="sm">
              {workspaceName}
            </Text>
            {(databaseId || fileSystemId) && (
              <Anchor href={databaseId ? '#databases' : '#files'} size="sm">
                {databaseId ? 'Databases' : 'File Systems'}
              </Anchor>
            )}
            <Text className="workspace-resource-crumb" title={resourceName} size="sm" fw={600}>
              {databaseId || fileSystemId ? resourceName || 'Resource unavailable' : label}
            </Text>
          </Breadcrumbs>
          <Group hiddenFrom="sm" className="workspace-mobile-crumb">
            {databaseId || fileSystemId ? (
              <Anchor href={databaseId ? '#databases' : '#files'} size="sm">
                {databaseId ? 'Databases' : 'File Systems'}
              </Anchor>
            ) : (
              <Text size="sm" fw={600}>
                {label}
              </Text>
            )}
          </Group>
          <Group gap={12} wrap="nowrap" className="header-actions">
            <ThemePicker />
            <ActionIcon visibleFrom="sm" aria-label="Search workspace" onClick={onSearch}>
              <IconSearchLg size={20} />
            </ActionIcon>
          </Group>
        </div>
      </AppShell.Header>
      <AppShell.Navbar visibleFrom="sm" p={20}>
        {sidebar}
      </AppShell.Navbar>
      <Drawer
        closeButtonProps={{ 'aria-label': 'Close navigation', size: 44 }}
        opened={opened}
        onClose={() => setOpened(false)}
        title="TiDB Agent Workspace"
        size={300}
      >
        {sidebar}
        <Button
          mt={16}
          fullWidth
          onClick={() => {
            setOpened(false);
            onSearch();
          }}
        >
          Search workspace
        </Button>
      </Drawer>
      <AppShell.Main>
        <div
          className={`workspace-content${databaseId || fileSystemId ? ' resource-content' : ''}`}
        >
          {children}
        </div>
        <footer className="footer">
          <Text size="sm">
            Powered by{' '}
            <Anchor
              size="sm"
              href="https://www.pingcap.com/tidb/cloud/"
              target="_blank"
              rel="noopener noreferrer"
            >
              TiDB Cloud
            </Anchor>
          </Text>
          <Text size="sm">
            {isGuest
              ? 'Temporary workspace · Access expires after 24 hours'
              : liveDatabases
                ? 'Cloud usage is not measured'
                : liveFiles
                  ? 'File storage is connected · Databases and telemetry are simulated'
                  : isHostedSession
                    ? 'Create a resource to get started'
                    : 'Local demo · Cloud resources and telemetry are simulated'}
          </Text>
        </footer>
      </AppShell.Main>
    </AppShell>
  );
}
