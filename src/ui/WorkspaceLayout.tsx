import { useEffect, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  ActionIcon,
  Anchor,
  AppShell,
  Badge,
  Breadcrumbs,
  Button,
  Drawer,
  Group,
  NavLink,
  Stack,
  Text,
} from '@tidbcloud/uikit';
import {
  IconBookOpen01,
  IconChevronRight,
  IconHelpCircle,
  IconMenu01,
  IconSearchLg,
} from '@tidbcloud/uikit/icons';
import type { IconProps } from '@tidbcloud/uikit/icons';
import { ThemePicker } from '../features/theme/ThemePicker';

type NavigationItem = { id: string; label: string; group: string; icon: ComponentType<IconProps> };
type Props = {
  workspaceName: string;
  liveFiles?: boolean;
  liveDatabases?: boolean;
  profileName: string;
  active: string;
  databaseId?: string;
  databaseView?: 'tables' | 'sql';
  navigation: NavigationItem[];
  onSearch: () => void;
  children: ReactNode;
};

export function WorkspaceLayout({
  workspaceName,
  liveFiles = false,
  liveDatabases = false,
  profileName,
  active,
  databaseId,
  databaseView,
  navigation,
  onSearch,
  children,
}: Props) {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    setOpened(false);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [active, databaseId, databaseView]);
  const navigate = (page: string) => {
    location.hash = page;
    setOpened(false);
  };
  const sidebar = (
    <div className="sidebar-content">
      <Button fullWidth variant="default" onClick={() => navigate('settings')}>
        Personal workspace
      </Button>
      <Text size="sm" c="carbon.7" mt={8}>
        {liveFiles || liveDatabases ? 'Prototype · Live resources' : 'Free plan · Local demo'}
      </Text>
      <nav aria-label="Main navigation">
        {['Workspace', 'Build', 'Manage'].map((group) => (
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
        ))}
      </nav>
      <div className="sidebar-bottom">
        <NavLink
          component="a"
          href="https://docs.pingcap.com/tidbcloud/"
          target="_blank"
          rel="noreferrer"
          label="Documentation"
          leftSection={<IconBookOpen01 size={20} />}
        />
        <NavLink
          component="a"
          href="#settings"
          label={profileName}
          description="Personal account"
          onClick={() => setOpened(false)}
        />
      </div>
    </div>
  );
  const label = navigation.find((item) => item.id === active)?.label || 'Workspace';
  return (
    <AppShell
      header={{ height: 80 }}
      navbar={{ width: 272, breakpoint: 'sm', collapsed: { mobile: true } }}
      padding={0}
    >
      <AppShell.Header>
        <div className="workspace-header">
          <Anchor href="#overview" className="brand" underline="never">
            <span className="brand-mark">TiDB</span>
            <Text span fw={600}>
              Workspace
            </Text>
          </Anchor>
          <ActionIcon hiddenFrom="sm" aria-label="Open navigation" onClick={() => setOpened(true)}>
            <IconMenu01 size={22} />
          </ActionIcon>
          <Breadcrumbs className="workspace-breadcrumbs" separator={<IconChevronRight size={14} />}>
            <Text className="workspace-crumb" size="sm">
              {workspaceName}
            </Text>
            {databaseId && (
              <Anchor href="#databases" size="sm">
                Databases
              </Anchor>
            )}
            <Text size="sm" fw={600}>
              {databaseId ? 'SQL workspace' : label}
            </Text>
          </Breadcrumbs>
          <Group gap={12} wrap="nowrap" className="header-actions">
            <ThemePicker />
            <ActionIcon visibleFrom="sm" aria-label="Search workspace" onClick={onSearch}>
              <IconSearchLg size={20} />
            </ActionIcon>
            <Badge visibleFrom="md" color="carbon">
              {liveFiles || liveDatabases ? 'Live resources' : 'Local demo'}
            </Badge>
            <ActionIcon
              visibleFrom="md"
              aria-label="Open documentation"
              onClick={() =>
                window.open('https://docs.pingcap.com/tidbcloud/', '_blank', 'noopener')
              }
            >
              <IconHelpCircle size={20} />
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
        title="Workspace"
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
        <div className="workspace-content">{children}</div>
        <footer className="footer">
          <Text size="sm">Local Workspace gateway</Text>
          <Text size="sm">
            {liveDatabases
              ? 'Live databases · Cloud usage is not measured'
              : liveFiles
                ? 'Drive9 files are live · Databases & telemetry are simulated'
                : 'Product prototype · Cloud resources & telemetry are simulated'}
          </Text>
          <Anchor
            size="sm"
            href="https://docs.pingcap.com/tidbcloud/"
            target="_blank"
            rel="noreferrer"
          >
            Documentation
          </Anchor>
        </footer>
      </AppShell.Main>
    </AppShell>
  );
}
