import { agentInstructions } from './api/agent-instructions';
import {
  apiBaseUrl,
  base,
  workspaceApi,
  type Data,
  type Resource,
  type ApiKey,
  type CreateKeyInput,
  type WriteFileInput,
  type SsoAuthConfig,
} from './api/client';
import './features/files/file-preview.css';
import { FileBrowserPanel } from './features/files/FileBrowserPanel';
import { FileBrowserList } from './features/files/FileBrowserList';
import { ResourceKindIcon as KindIcon } from './ui/ResourceKindIcon';
import { FileWorkspaceHeader } from './features/files/FileWorkspaceHeader';
import { FileUploadStatus } from './features/files/FileUploadStatus';
import { useFileUpload } from './features/files/use-file-upload';
import { ResourceCollectionPage } from './features/resources/ResourceCollectionPage';
import { resourceWindow } from './features/resources/resource-window';
import {
  resourceWorkspaceHref,
  resourceServiceLabel,
} from './features/resources/resource-presentation';
import { WorkspacePageHeader as PageHeading } from './ui/WorkspacePageHeader';
import { WorkspaceEmptyState as Empty } from './ui/WorkspaceEmptyState';
import { WorkspaceFirstSteps } from './features/resources/WorkspaceFirstSteps';
import {
  useRemoteFiles,
  downloadRemoteFile,
  fileSize,
  type WorkspaceFile,
} from './features/files/remote-files';
import { regionLabel as region } from './features/resources/regions';
import { CreateResourceDialog } from './features/resources/CreateResourceDialog';
import { SignInChoices } from './features/auth/SignInChoices';
import {
  resourceKindLabels as kindLabel,
  type ResourceCreationTarget,
} from './features/resources/resource-creation';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Loader,
  NativeSelect,
  NavLink,
  Paper,
  Progress,
  SegmentedControl,
  Table,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
  Anchor,
  Notification,
  Fieldset,
  Group,
} from '@tidbcloud/uikit';
import { WorkspaceModal as Modal } from './ui/WorkspaceModal';
import { CodeExample as Code } from './ui/CodeExample';
import { ChoiceTabs } from './ui/ChoiceTabs';
import { Heading } from './ui/WorkspaceHeading';
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  IconActivity as Activity,
  IconDownload01 as ArrowDownToLine,
  IconArrowRight as ArrowRight,
  IconArrowUpRight as ArrowUpRight,
  IconCheck as Check,
  IconCheckCircle as CheckCircle2,
  IconChevronRight as ChevronRight,
  IconCode02 as Code2,
  IconCopy03 as Copy,
  IconCreditCard01 as CreditCard,
  IconDatabase01 as Database,
  IconFolder as Folder,
  IconKey01 as KeyRound,
  IconLayoutGrid01 as LayoutDashboard,
  IconPlay as Play,
  IconPlus as Plus,
  IconRefreshCw01 as RefreshCw,
  IconSearchLg as Search,
  IconSettings01 as Settings,
  IconShieldTick as ShieldCheck,
  IconTerminal as Terminal,
  IconGitBranch01 as Workflow,
  IconHelpCircle as CircleHelp,
} from '@tidbcloud/uikit/icons';
import type { IconProps } from '@tidbcloud/uikit/icons';
import { ResourceAccessPicker } from './features/keys/ResourceAccessPicker';
import { WorkspaceLayout } from './ui/WorkspaceLayout';
import { DatabaseWorkspace } from './features/databases/DatabaseWorkspace';
import {
  databaseEditorHash,
  parseWorkspaceRoute,
  tutorialHash,
} from './features/navigation/workspace-route';
import { DataTutorials } from './features/portal/DataTutorials';
import { TutorialResume } from './features/portal/TutorialResume';
import type { Route, WorkspaceRoute } from './features/navigation/workspace-route';

import {
  fileHash,
  fileSystemHash,
  parseFileSystemLocation,
  type FileView,
} from './features/files/file-location';

const FilePreviewPanel = lazy(() => import('./features/files/FilePreviewPanel'));
type WorkspaceIcon = React.ComponentType<IconProps>;
type PortalData = Data & { resourceWindowTruncated?: boolean };

type Kind = Resource['kind'];
const routes: Record<Route, { label: string; icon: WorkspaceIcon; group: string }> = {
  overview: { label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  databases: { label: 'Databases', icon: Database, group: 'Workspace' },
  files: { label: 'File Systems', icon: Folder, group: 'Workspace' },
  connect: { label: 'Connect an agent', icon: Workflow, group: 'Build' },
  tutorials: { label: 'Tutorials', icon: CircleHelp, group: 'Build' },
  keys: { label: 'API keys', icon: KeyRound, group: 'Build' },
  api: { label: 'API explorer', icon: Terminal, group: 'Build' },
  monitoring: { label: 'Monitoring', icon: Activity, group: 'Manage' },
  billing: { label: 'Usage & billing', icon: CreditCard, group: 'Manage' },
  settings: { label: 'Settings', icon: Settings, group: 'Manage' },
};

const kindDescription: Record<Kind, string> = {
  mysql: 'Relational memory for your agents.',
  postgresql: 'PostgreSQL for your apps and agents.',
  duckdb: 'Analytics in a persistent DuckDB database.',
  filesystem: 'Persistent context, across sessions.',
};
const allScopes: CreateKeyInput['scopes'] = [
  'resources:read',
  'resources:write',
  'files:read',
  'files:analyze',
  'files:write',
  'queries:execute',
  'usage:read',
];
function go(route: Route) {
  location.hash = route;
}
function openDatabaseEditor(resourceId: string) {
  location.hash = databaseEditorHash(resourceId);
}
function currentRoute(): WorkspaceRoute {
  return parseWorkspaceRoute(location.hash);
}
function bytes(value: number) {
  if (!value) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function relative(value: string | null) {
  if (!value) return 'Time unavailable';
  const seconds = (Date.now() - Date.parse(value)) / 1000;
  return seconds < 60
    ? 'Just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Sparkline({ large = false, range = '24h' }: { large?: boolean; range?: string }) {
  const values =
    range === '7d'
      ? [
          42, 40, 32, 39, 23, 30, 17, 34, 22, 25, 15, 26, 20, 29, 13, 26, 19, 14, 26, 8, 20, 15, 24,
          9, 18, 14, 5,
        ]
      : [
          44, 42, 46, 36, 38, 37, 29, 34, 17, 33, 29, 34, 23, 20, 30, 12, 28, 20, 21, 11, 27, 24,
          12, 18, 14, 20, 9,
        ];
  const points = values.map((n, i) => `${i * 20},${n * 2}`).join(' ');
  return (
    <svg
      className={large ? 'chart-svg' : 'sparkline'}
      viewBox="0 0 520 110"
      preserveAspectRatio="none"
      aria-label="Illustrative request activity"
    >
      <defs>
        <linearGradient id={large ? 'fill-lg' : 'fill-sm'} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="var(--accent-text)" stopOpacity=".16" />
          <stop offset="1" stopColor="var(--accent-text)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {large &&
        [20, 50, 80, 109].map((y) => (
          <line
            key={y}
            x1="0"
            x2="520"
            y1={y}
            y2={y}
            stroke="var(--border-subtle)"
            strokeDasharray="3 4"
          />
        ))}
      <polygon points={`0,110 ${points} 520,110`} fill={`url(#${large ? 'fill-lg' : 'fill-sm'})`} />
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent-text)"
        strokeWidth={large ? 1.7 : 2}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function App() {
  const [data, setData] = useState<PortalData | null>(null),
    [routeLocation, setRouteLocation] = useState<WorkspaceRoute>(currentRoute),
    [error, setError] = useState(''),
    [guestLoading, setGuestLoading] = useState(false),
    [guestError, setGuestError] = useState(''),
    [confirmGuestSignOut, setConfirmGuestSignOut] = useState(false),
    [guestSignOutBusy, setGuestSignOutBusy] = useState(false),
    [guestSignOutError, setGuestSignOutError] = useState(''),
    [toast, setToast] = useState(''),
    [modal, setModal] = useState<'resource' | 'key' | 'search' | null>(null),
    [creationTarget, setCreationTarget] = useState<ResourceCreationTarget>('resource'),
    [sso, setSso] = useState<SsoAuthConfig>({ enabled: false }),
    [connection, setConnection] = useState<Resource | null>(null);
  const [resourcePageBusy, setResourcePageBusy] = useState(false);
  const [resourcePageError, setResourcePageError] = useState('');
  const [resourceLookupFailure, setResourceLookupFailure] = useState('');
  const [resolvedResourceKey, setResolvedResourceKey] = useState('');
  const [tutorialCreation, setTutorialCreation] = useState(false);
  const route = routeLocation.page;
  const selectedResourceId =
    routeLocation.databaseId ??
    parseFileSystemLocation('#' + (routeLocation.fileLink || 'files'))?.resourceId;
  const selectedResourceIdRef = useRef(selectedResourceId);
  selectedResourceIdRef.current = selectedResourceId;
  const lookupKey = data && selectedResourceId ? `${data.workspace.id}:${selectedResourceId}` : '';
  const selectedLoaded = Boolean(
    data?.resources.some((resource) => resource.id === selectedResourceId),
  );
  const resourceName = data?.resources.find(
    (resource) =>
      resource.id === selectedResourceId &&
      (route === 'files' ? resource.kind === 'filesystem' : resource.kind !== 'filesystem'),
  )?.name;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3500);
  }
  const refresh = useCallback(async () => {
    const refreshed = await workspaceApi.bootstrap();
    setData((current) => {
      const selectedId = selectedResourceIdRef.current;
      const relevantFiles = refreshed.files.filter((file) => file.resourceId === selectedId);
      const selected = current?.resources.find((resource) => resource.id === selectedId);
      if (
        current?.workspace.id === refreshed.workspace.id &&
        selected &&
        !refreshed.resources.some((resource) => resource.id === selected.id)
      ) {
        return {
          ...refreshed,
          resources: [...refreshed.resources, selected],
          files: current.files.filter((file) => file.resourceId === selected.id),
          resourceWindowTruncated: false,
        };
      }
      return { ...refreshed, files: relevantFiles };
    });
    setResourcePageError('');
    setResourceLookupFailure('');
    setResolvedResourceKey('');
  }, []);
  const loadMoreResources = useCallback(async () => {
    const cursor = data?.resourceNextCursor;
    if (!cursor || resourcePageBusy) return;
    setResourcePageBusy(true);
    setResourcePageError('');
    try {
      const [page, usage] = await Promise.all([
        workspaceApi.resourcesPage(cursor),
        workspaceApi.usagePage(cursor),
      ]);
      setData((current) => {
        if (!current || current.resourceNextCursor !== cursor) return current;
        const window = resourceWindow(current.resources, page.data, selectedResourceIdRef.current);
        const usageByResource = new Map(current.usage.map((item) => [item.resourceId, item]));
        const pageIds = new Set(page.data.map((resource) => resource.id));
        for (const item of usage.data)
          if (pageIds.has(item.resourceId)) usageByResource.set(item.resourceId, item);
        const retainedIds = new Set(window.resources.map((resource) => resource.id));
        return {
          ...current,
          resources: window.resources,
          usage: [...usageByResource.values()].filter((item) => retainedIds.has(item.resourceId)),
          resourceNextCursor: page.nextCursor ?? null,
          resourceWindowTruncated: Boolean(current.resourceWindowTruncated || window.dropped),
        };
      });
    } catch (cause) {
      setResourcePageError(cause instanceof Error ? cause.message : 'Unable to load resources.');
    } finally {
      setResourcePageBusy(false);
    }
  }, [data?.resourceNextCursor, resourcePageBusy]);
  useEffect(() => {
    if (
      !lookupKey ||
      !selectedResourceId ||
      resolvedResourceKey === lookupKey ||
      resourceLookupFailure === lookupKey
    )
      return;
    const controller = new AbortController();
    workspaceApi
      .resource(selectedResourceId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData((current) => {
          if (!current || `${current.workspace.id}:${selectedResourceId}` !== lookupKey)
            return current;
          const window = resourceWindow(current.resources, [result.data], selectedResourceId);
          return {
            ...current,
            resources: window.resources,
            files: [],
            resourceWindowTruncated: Boolean(current.resourceWindowTruncated || window.dropped),
          };
        });
        setResolvedResourceKey(lookupKey);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResourceLookupFailure(lookupKey);
      });
    return () => controller.abort();
  }, [lookupKey, selectedResourceId, resolvedResourceKey, resourceLookupFailure]);
  // Boot the workspace. When SSO is enabled the anonymous demo session is disabled, so we never
  // auto-start one: we only try to use an existing (SSO) session and, failing that, show the
  // sign-in screen. When SSO is unconfigured, the local demo session starts as before.
  const start = useCallback(async () => {
    try {
      setError('');
      const auth = await workspaceApi.authConfig();
      setSso(auth);
      if (!auth.enabled) await workspaceApi.startSession();
      await workspaceApi.discoverWorkspace();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refresh]);
  async function startGuest() {
    setGuestLoading(true);
    setGuestError('');
    try {
      await workspaceApi.startGuestSession();
      setSso(await workspaceApi.authConfig());
      await workspaceApi.discoverWorkspace();
      await refresh();
      setError('');
    } catch {
      setGuestError('Unable to start Guest access. Please try again.');
    } finally {
      setGuestLoading(false);
    }
  }
  useEffect(() => {
    void start();
    const update = () => {
      setRouteLocation(currentRoute());
    };
    window.addEventListener('hashchange', update);
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setModal('search');
      }
    }
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('hashchange', update);
      document.removeEventListener('keydown', key);
    };
  }, [start]);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify('Copied to clipboard');
    } catch {
      notify('Clipboard unavailable. Select and copy the text.');
    }
  }
  function finishSignOut() {
    if (sso.logoutPath) window.location.href = apiBaseUrl + sso.logoutPath;
  }
  function requestSignOut() {
    if (sso.sessionKind === 'guest') {
      setGuestSignOutError('');
      setConfirmGuestSignOut(true);
    } else finishSignOut();
  }
  async function finishGuestSignOut() {
    setGuestSignOutBusy(true);
    setGuestSignOutError('');
    try {
      await workspaceApi.endGuestSession();
      window.location.reload();
    } catch {
      setGuestSignOutError('Unable to finish Guest sign-out. Try again or refresh this page.');
      setGuestSignOutBusy(false);
    }
  }
  const shared = {
    data: data!,
    refresh,
    notify,
    copy,
    onCreate: (target: ResourceCreationTarget = 'resource') => {
      setTutorialCreation(false);
      setCreationTarget(target);
      setModal('resource');
    },
    onConnect: (r: Resource) => setConnection(r),
    isGuest: sso.sessionKind === 'guest',
    loadMoreResources,
    resourcePageBusy,
    resourcePageError,
  };
  const ssoButton =
    sso.enabled && sso.loginPath ? (
      <Button
        variant="default"
        onClick={() => {
          window.location.href = apiBaseUrl + sso.loginPath;
        }}
      >
        {sso.label || 'Continue with TiDB Account'}
      </Button>
    ) : null;
  if (!data)
    return (
      <div className="loading-screen">
        <div className="brand-mark">T</div>
        {error && sso.enabled ? (
          // SSO is enabled and no session is active yet: prompt sign-in (no anonymous demo).
          <>
            <Heading level={2}>Sign in to your workspace</Heading>
            <Text component="p">Choose how you want to continue.</Text>
            {sso.loginPath && (
              <SignInChoices
                label={sso.label || 'Continue with TiDB Account'}
                guestEnabled={sso.guestEnabled === true}
                guestLoading={guestLoading}
                guestError={guestError}
                onGuestLogin={() => void startGuest()}
                onTiDBLogin={() => {
                  window.location.href = apiBaseUrl + sso.loginPath;
                }}
              />
            )}
          </>
        ) : error ? (
          <>
            <Heading level={2}>Couldn’t open your workspace</Heading>
            <Text component="p">{error}</Text>
            <Button onClick={start}>Try again</Button>
            {ssoButton}
          </>
        ) : (
          <>
            <Loader size="lg" />
            <Text component="p">Opening your workspace…</Text>
            {ssoButton}
          </>
        )}
      </div>
    );
  return (
    <>
      <WorkspaceLayout
        isHostedSession={sso.sessionKind === 'account' || sso.sessionKind === 'guest'}
        liveFiles={data.resources.some((r) => r.provider === 'drive9-anonymous')}
        liveDatabases={data.resources.some((r) =>
          ['tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'].includes(r.provider || ''),
        )}
        workspaceName={data.workspace.name}
        profileName={data.profile.name}
        active={route}
        databaseId={routeLocation.databaseId}
        resourceName={resourceName}
        databaseView={routeLocation.databaseView}
        fileSystemId={
          parseFileSystemLocation('#' + (routeLocation.fileLink || 'files'))?.resourceId
        }
        navigation={Object.entries(routes).map(([id, item]) => ({ id, ...item }))}
        onSearch={() => setModal('search')}
        onSignOut={
          sso.enabled && sso.logoutPath && (sso.sessionKind !== 'guest' || sso.guestCleanupEnabled)
            ? requestSignOut
            : undefined
        }
        isGuest={sso.sessionKind === 'guest'}
      >
        <div key={route}>
          {route === 'overview' && <Overview {...shared} />}
          {(route === 'databases' || route === 'files') &&
          lookupKey &&
          (!selectedLoaded || route === 'files') &&
          resolvedResourceKey !== lookupKey &&
          resourceLookupFailure !== lookupKey ? (
            <Text role="status">Loading resource…</Text>
          ) : (
            <>
              {route === 'databases' && <Databases {...shared} routeLocation={routeLocation} />}
              {route === 'files' && <Files key={routeLocation.fileLink || 'files'} {...shared} />}
            </>
          )}
          {route === 'connect' && <Connect {...shared} onNewKey={() => setModal('key')} />}
          {route === 'tutorials' && (
            <>
              <PageHeading
                title="Tutorials"
                description="Load the included sample data, run a query, and check your first result."
                actions={
                  <Button component="a" href="#connect">
                    Connect an agent
                  </Button>
                }
              />
              <DataTutorials
                key={data.workspace.id}
                data={data}
                resourceId={routeLocation.tutorialResourceId}
                kind={routeLocation.tutorialKind}
                refresh={refresh}
                copy={copy}
                onCreate={(kind) => {
                  setTutorialCreation(true);
                  setCreationTarget(kind === 'filesystem' ? 'filesystem' : 'database');
                  setModal('resource');
                }}
              />
            </>
          )}
          {route === 'keys' && <Keys {...shared} onNewKey={() => setModal('key')} />}
          {route === 'api' && <ApiExplorer {...shared} />}
          {route === 'monitoring' && <Monitoring {...shared} />}
          {route === 'billing' && <Billing {...shared} />}
          {route === 'settings' && (
            <WorkspaceSettings {...shared} sso={sso} onSignOut={requestSignOut} />
          )}
        </div>
      </WorkspaceLayout>
      {confirmGuestSignOut && (
        <Modal
          title="Sign out of Guest?"
          size={480}
          busy={guestSignOutBusy}
          onClose={() => setConfirmGuestSignOut(false)}
        >
          <Text>
            Signing out ends this Guest session and requests deletion of its resources. You won’t be
            able to reopen this session in this browser. Save anything you need first.
          </Text>
          {guestSignOutError && (
            <Alert color="red" role="alert" mt="md">
              {guestSignOutError}
            </Alert>
          )}
          <div className="modal-actions">
            <Button disabled={guestSignOutBusy} onClick={() => setConfirmGuestSignOut(false)}>
              Cancel
            </Button>
            <Button
              variant="filled"
              loading={guestSignOutBusy}
              onClick={() => void finishGuestSignOut()}
            >
              Sign out
            </Button>
          </div>
        </Modal>
      )}
      {toast && (
        <Notification
          className="workspace-toast"
          closeButtonProps={{ 'aria-label': 'Dismiss notification' }}
          role="status"
          onClose={() => setToast('')}
          icon={<CheckCircle2 size={20} />}
        >
          {toast}
        </Notification>
      )}
      {modal === 'resource' && (
        <CreateResourceDialog
          {...shared}
          target={creationTarget}
          onClose={() => setModal(null)}
          onCreated={
            tutorialCreation
              ? (resource) => {
                  location.hash = tutorialHash(resource.id);
                }
              : undefined
          }
        />
      )}
      {modal === 'key' && <CreateKey {...shared} onClose={() => setModal(null)} />}
      {modal === 'search' && (
        <SearchModal data={data} onClose={() => setModal(null)} onConnect={setConnection} />
      )}
      {connection && (
        <Connection resource={connection} copy={copy} onClose={() => setConnection(null)} />
      )}
    </>
  );
}
type Shared = {
  data: PortalData;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  copy: (s: string) => void;
  onCreate: (target?: ResourceCreationTarget) => void;
  onConnect: (r: Resource) => void;
  isGuest: boolean;
  loadMoreResources: () => Promise<void>;
  resourcePageBusy: boolean;
  resourcePageError: string;
};
function Overview({
  data,
  onCreate,
  onConnect,
  copy,
  isGuest,
  loadMoreResources,
  resourcePageBusy,
  resourcePageError,
  refresh,
}: Shared) {
  const [range, setRange] = useState('24h');
  const dbs = data.resources.filter((r) => r.kind !== 'filesystem'),
    fs = data.resources.filter((r) => r.kind === 'filesystem'),
    hasResources =
      data.resources.length > 0 || Boolean(data.resourceNextCursor || data.resourceWindowTruncated);
  return (
    <>
      <PageHeading
        eyebrow="YOUR WORKSPACE"
        title={hasResources ? data.workspace.name : 'Start with your data'}
        description={
          hasResources
            ? 'Your data, files, and agents. All in one place.'
            : 'Create a database for SQL or a File System for files. Connect your agent when you are ready.'
        }
        actions={
          hasResources ? (
            <>
              <Button
                leftSection={React.createElement(Workflow, { size: 18 })}
                onClick={() => go('connect')}
              >
                Connect an agent
              </Button>
              <Button
                variant="filled"
                leftSection={React.createElement(Plus, { size: 18 })}
                onClick={() => onCreate()}
              >
                Create resource
              </Button>
            </>
          ) : undefined
        }
      />
      <TutorialResume data={data} />
      {(data.resourceNextCursor || data.resourceWindowTruncated) && (
        <Alert color="peacock" mb="md">
          <Text>
            Showing {data.resources.length} loaded resources.
            {data.resourceWindowTruncated &&
              ' Earlier resources are hidden to keep this page responsive.'}
            {data.resourceNextCursor && ' More resources are available.'}
          </Text>
          {resourcePageError && <Text c="red">{resourcePageError}</Text>}
          <Group mt="sm">
            {data.resourceWindowTruncated && (
              <Button onClick={() => void refresh()}>Back to first resources</Button>
            )}
            {data.resourceNextCursor && (
              <Button loading={resourcePageBusy} onClick={() => void loadMoreResources()}>
                Load more resources
              </Button>
            )}
          </Group>
        </Alert>
      )}
      {!data.resourceNextCursor && !data.resourceWindowTruncated && (!dbs.length || !fs.length) && (
        <WorkspaceFirstSteps
          onCreate={onCreate}
          showDatabase={!dbs.length}
          showFileSystem={!fs.length}
          isGuest={isGuest}
        />
      )}
      {!!data.resources.length && (
        <>
          <div className="section-title">
            <Heading level={2}>
              Your resources{' '}
              <span>
                {data.resources.length}
                {data.resourceNextCursor || data.resourceWindowTruncated ? '+' : ''}
              </span>
            </Heading>
          </div>
          <section className="resource-grid">
            {(['mysql', 'postgresql', 'duckdb', 'filesystem'] as Kind[])
              .filter((kind) => kind !== 'filesystem' || fs.length > 0)
              .filter(
                (kind) =>
                  kind !== 'postgresql' ||
                  data.capabilities.postgresql.available ||
                  data.resources.some((r) => r.kind === kind),
              )
              .map((kind) => {
                const items = data.resources.filter((r) => r.kind === kind),
                  r =
                    items.find((r) =>
                      [
                        'tidb-cloud-zero',
                        'drive9-anonymous',
                        'duckdb-drive9',
                        'db9-anonymous',
                      ].includes(r.provider || ''),
                    ) || items[0];
                return (
                  <Card className="resource-card" key={kind}>
                    <div className="resource-card-top">
                      <KindIcon kind={kind} />
                      <Group gap="xs">
                        {r && r.status !== 'active' && (
                          <Badge color={r.status === 'failed' ? 'red' : 'yellow'}>{r.status}</Badge>
                        )}
                        {r && <Badge color="carbon">{resourceServiceLabel(r)}</Badge>}
                      </Group>
                    </div>
                    <Heading level={3}>
                      {kindLabel[kind]}
                      {kind !== 'filesystem' && <span className="resource-type">database</span>}
                    </Heading>
                    <Text component="p">{kindDescription[kind]}</Text>
                    {r ? (
                      <Anchor className="resource-name" href={resourceWorkspaceHref(r)} fw={600}>
                        {r.name}
                        {items.length > 1 && <span className="count">+{items.length - 1}</span>}
                        <ChevronRight size={16} />
                      </Anchor>
                    ) : (
                      <Text component="p" className="resource-name" c="carbon.7">
                        {data.resourceNextCursor || data.resourceWindowTruncated
                          ? 'No loaded resources'
                          : 'No resources yet'}
                      </Text>
                    )}
                    <div className="resource-card-bottom">
                      <span>{r ? region(r.region) : 'Ready when you are'}</span>
                      <Button
                        aria-label={r ? `Connect to ${r.name}` : `Create ${kindLabel[kind]}`}
                        onClick={() => (r ? onConnect(r) : onCreate(kind))}
                        rightSection={<ArrowUpRight size={16} />}
                      >
                        {r ? 'Connect' : 'Create'}
                      </Button>
                    </div>
                  </Card>
                );
              })}
          </section>
        </>
      )}
      {!!data.resources.length && (
        <>
          <div className="overview-grid">
            <Paper className="panel activity-panel" withBorder>
              <div className="panel-header">
                <div>
                  <Heading level={2}>Workspace activity</Heading>
                  <Text component="p">Illustrative activity · demo data</Text>
                </div>
                <SegmentedControl
                  aria-label="Activity time range"
                  value={range}
                  onChange={setRange}
                  data={[
                    { value: '24h', label: '24 hours' },
                    { value: '7d', label: '7 days' },
                  ]}
                />
              </div>
              <div className="metrics-inline">
                <div>
                  <span>Local queries run</span>
                  <strong>
                    {data.queryCount}
                    <small>queries</small>
                  </strong>
                </div>
                <div>
                  <span>Databases</span>
                  <strong>
                    {dbs.length}
                    <small>active</small>
                  </strong>
                </div>
                <div>
                  <span>File systems</span>
                  <strong>
                    {fs.length}
                    <small>active</small>
                  </strong>
                </div>
              </div>
              <div className="chart-wrap">
                <Sparkline large range={range} />
                <div className="chart-axis">
                  {(range === '24h'
                    ? ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00']
                    : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                  ).map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              </div>
            </Paper>
            <Paper className="panel spend-panel" withBorder>
              <div className="panel-header">
                <Heading level={2}>Usage this month</Heading>
                <Badge>Free plan</Badge>
              </div>
              <div className="spend-number">
                —<small>Billing not connected</small>
              </div>
              <div className="spend-rule">
                <ShieldCheck size={15} />
                <span>No payment method connected</span>
              </div>
              <div className="usage-mini">
                <div>
                  <span>MySQL request units</span>
                  <strong>
                    {data.resources.some((r) => r.provider === 'tidb-cloud-zero')
                      ? 'Not measured'
                      : '0 / 50M (demo)'}
                  </strong>
                </div>
                <Progress value={0} aria-label="MySQL request units used" />
                <div>
                  <span>File System allowance</span>
                  <strong>
                    {data.capabilities.filesystem.provider === 'drive9-anonymous'
                      ? 'Service trial limits'
                      : '$5 / month (reference)'}
                  </strong>
                </div>
                <small>Live trial quota and usage are not measured here.</small>
              </div>
              <Button className="text-link" onClick={() => go('billing')} variant="subtle">
                View usage & limits <ArrowRight size={14} />
              </Button>
            </Paper>
          </div>
          <div className="overview-grid bottom-grid">
            <Paper className="panel quickstart-panel" withBorder>
              <div className="panel-header">
                <Heading level={2}>From workspace to workflow</Heading>
                <Terminal size={17} />
              </div>
              <Text className="section-description" component="p">
                Let your agent discover its resources through one API.
              </Text>
              <Code
                copy={copy}
                label="WORKSPACE API"
                value={
                  'curl ' +
                  apiBaseUrl +
                  base +
                  '/resources \\\n  -H "Authorization: Bearer $WORKSPACE_API_KEY"'
                }
              />
              <div className="quickstart-footer">
                <span>
                  <KeyRound size={13} /> Create a scoped key to get started
                </span>
                <Button className="text-link" onClick={() => go('connect')} variant="subtle">
                  Setup guide <ArrowUpRight size={13} />
                </Button>
              </div>
            </Paper>
            <Paper className="panel events-panel" withBorder>
              <div className="panel-header">
                <Heading level={2}>Recent activity</Heading>
                <Button
                  className="text-link subtle"
                  onClick={() => go('monitoring')}
                  variant="subtle"
                >
                  View all <ArrowUpRight size={13} />
                </Button>
              </div>
              {data.events.slice(0, 3).map((e) => (
                <div className="activity-row" key={e.id}>
                  <span className="event-icon">
                    <Check size={13} />
                  </span>
                  <div>
                    <strong>{eventLabel(e.action)}</strong>
                    <span>{e.resource}</span>
                  </div>
                  <time>{relative(e.at)}</time>
                </div>
              ))}
            </Paper>
          </div>
        </>
      )}
    </>
  );
}
function eventLabel(action: string) {
  return (
    (
      {
        'workspace.created': 'Workspace is ready',
        'resource.created': 'Resource created',
        'query.executed': 'Query executed',
        'file.created': 'File created',
        'file.updated': 'File updated',
        'file.deleted': 'File deleted',
        'key.created': 'API key created',
        'key.revoked': 'API key revoked',
        'workspace.updated': 'Workspace updated',
      } as Record<string, string>
    )[action] || action
  );
}
function Databases({ routeLocation, ...shared }: Shared & { routeLocation: WorkspaceRoute }) {
  const { databaseId } = routeLocation;
  const { data, onCreate, onConnect, isGuest } = shared;
  const databases = data.resources
    .filter((r) => r.kind !== 'filesystem')
    .sort(
      (a, b) => Number(b.provider === 'tidb-cloud-zero') - Number(a.provider === 'tidb-cloud-zero'),
    );
  if (databaseId) {
    const database = databases.find((r) => r.id === databaseId);
    if (!database) {
      return (
        <Empty
          icon={Database}
          title="Database unavailable"
          description="This database is no longer available in your workspace. Choose another database to open its SQL editor."
          action={
            <Group justify="center">
              <Button onClick={() => go('databases')}>Back to databases</Button>
              {!databases.length && (
                <Button variant="filled" onClick={() => onCreate('database')}>
                  Create database
                </Button>
              )}
            </Group>
          }
        />
      );
    }
    return (
      <DatabaseDetail
        key={database.id}
        {...shared}
        database={database}
        routeLocation={routeLocation}
      />
    );
  }
  return (
    <ResourceCollectionPage
      kind="database"
      resources={databases}
      onCreate={() => onCreate('database')}
      onConnect={onConnect}
      isGuest={isGuest}
      hasMore={Boolean(data.resourceNextCursor)}
      hasEarlier={Boolean(data.resourceWindowTruncated)}
      loadingMore={shared.resourcePageBusy}
      pageError={shared.resourcePageError}
      onLoadMore={shared.loadMoreResources}
      onRestart={shared.refresh}
    />
  );
}

function DatabaseDetail({
  data,
  database,
  refresh,
  notify,
  onConnect,
  routeLocation,
}: Shared & { database: Resource; routeLocation: WorkspaceRoute }) {
  return (
    <section className="database-page">
      <DatabaseWorkspace
        onConnect={() => onConnect(database)}
        onRetry={async () => {
          try {
            await workspaceApi.createResourceSetupAttempt(database.id);
            await refresh();
          } catch (error) {
            notify((error as Error).message);
          }
        }}
        database={database}
        databases={data.resources.filter((resource) => resource.kind !== 'filesystem')}
        routeLocation={routeLocation}
        refresh={refresh}
        onSelect={openDatabaseEditor}
      />
    </section>
  );
}

function download(name: string, value: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([value], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Files(shared: Shared) {
  const context = parseFileSystemLocation(location.hash);
  const systems = shared.data.resources.filter((resource) => resource.kind === 'filesystem');
  if (!context)
    return (
      <ResourceCollectionPage
        kind="filesystem"
        resources={systems}
        onCreate={() => shared.onCreate('filesystem')}
        onConnect={shared.onConnect}
        isGuest={shared.isGuest}
        hasMore={Boolean(shared.data.resourceNextCursor)}
        hasEarlier={Boolean(shared.data.resourceWindowTruncated)}
        loadingMore={shared.resourcePageBusy}
        pageError={shared.resourcePageError}
        onLoadMore={shared.loadMoreResources}
        onRestart={shared.refresh}
      />
    );
  const resource = systems.find((system) => system.id === context.resourceId);
  if (!resource)
    return (
      <Empty
        title="File System unavailable"
        description="This File System is no longer available in your workspace. Choose a File System from the list."
        action={
          <Group justify="center">
            <Button onClick={() => go('files')}>All file systems</Button>
            {!systems.length && (
              <Button variant="filled" onClick={() => shared.onCreate('filesystem')}>
                Create file system
              </Button>
            )}
          </Group>
        }
      />
    );
  return <FileWorkspace key={resource.id} {...shared} resource={resource} />;
}
function FileWorkspace({
  data,
  refresh,
  notify,
  onConnect,
  onCreate,
  resource,
}: Shared & { resource: Resource }) {
  const systems = data.resources.filter((r) => r.kind === 'filesystem');
  const [initialContext] = useState(() => parseFileSystemLocation(location.hash));
  const initialLocation = initialContext?.file;
  const initialResource = resource;
  const initialFile =
    initialResource && initialLocation
      ? data.files.find(
          (f) => f.resourceId === initialResource.id && f.path === initialLocation.path,
        ) || {
          id: `${initialResource.id}:${initialLocation.path}`,
          resourceId: initialResource.id,
          path: initialLocation.path,
          type: 'file' as const,
          size: 0,
          updatedAt: null,
        }
      : null;
  const restoreFile = useRef(initialFile);
  const [previewView, setPreviewView] = useState<FileView>(initialLocation?.view || 'preview');
  const system = resource.id;
  const [path, setPath] = useState(
      initialFile ? initialFile.path.slice(0, initialFile.path.lastIndexOf('/')) || '/' : '/',
    ),
    [search, setSearch] = useState(''),
    [editing, setEditing] = useState<WorkspaceFile | null>(null),
    [content, setContent] = useState(''),
    [newItem, setNewItem] = useState<'file' | 'directory' | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(
      initialContext?.invalidFile || (initialLocation && !initialFile)
        ? 'The linked file or File System is unavailable. Select a file to continue.'
        : '',
    ),
    [deleting, setDeleting] = useState<WorkspaceFile | null>(null);
  const selectedSystem = systems.find((r) => r.id === system);
  const remote = selectedSystem?.provider === 'drive9-anonymous';
  const localUsage = data.usage.find((item) => item.resourceId === system);
  const listing = useRemoteFiles(system, path, Boolean(system));
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState('');
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => previewRequest.current?.abort(), []);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [previewTrigger, setPreviewTrigger] = useState<HTMLElement | null>(null);
  const dirty = !!editing && content !== (editing.content || '');
  useEffect(() => {
    if (!dirty) return;
    const guardCollectionLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (link?.getAttribute('href') !== '#files') return;
      event.preventDefault();
      setPendingAction(() => () => go('files'));
    };
    document.addEventListener('click', guardCollectionLink);
    return () => document.removeEventListener('click', guardCollectionLink);
  }, [dirty]);
  function requestPreviewChange(action: () => void) {
    if (busy) return;
    restoreFile.current = null;
    if (dirty) setPendingAction(() => action);
    else action();
  }
  const upload = useRef<HTMLInputElement>(null);
  const files = listing.files;
  const fileUpload = useFileUpload({
    resource: selectedSystem,
    directory: path,
    files,
    onBusyChange: setBusy,
    onSaved: async () => {
      listing.refresh();
      await refresh();
    },
  });
  const openFile = useCallback(
    async (file: WorkspaceFile, view: FileView = 'preview') => {
      setPreviewView(view);
      history.replaceState(null, '', fileHash(file.resourceId, file.path, view));
      previewRequest.current?.abort();
      const controller = new AbortController();
      previewRequest.current = controller;
      setEditing(file);
      setContent(file.content || '');
      setError('');
      setUnavailableReason('');
      const needsPreview = remote || file.content === undefined;
      setPreviewLoading(needsPreview);
      if (!needsPreview) return;
      try {
        const result = await workspaceApi.previewFile(file, controller.signal);
        if (controller.signal.aborted) return;
        setEditing({ ...file, content: result.content, size: result.size });
        setContent(result.content || '');
        setUnavailableReason(result.unavailableReason || '');
      } catch (cause) {
        if (!controller.signal.aborted)
          setUnavailableReason(cause instanceof Error ? cause.message : 'Unable to load preview.');
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    },
    [remote],
  );
  useEffect(() => {
    const file = restoreFile.current;
    if (file) void openFile(file, initialLocation?.view);
  }, [openFile, initialLocation]);
  function closePreview() {
    history.replaceState(null, '', fileSystemHash(system));
    previewRequest.current?.abort();
    setPreviewLoading(false);
    setEditing(null);
    setError('');
    setBrowserCollapsed(false);
  }
  function downloadFile(file: WorkspaceFile) {
    if (remote) downloadRemoteFile(file);
    else download(file.path.split('/').pop()!, file.content || '');
  }
  const directoryFiles = files.filter(
    (file) => (file.path.slice(0, file.path.lastIndexOf('/')) || '/') === path,
  );
  const children = directoryFiles
    .filter((file) => file.path.split('/').pop()!.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1,
    );
  async function saveFile(
    target: string,
    type: WriteFileInput['type'],
    text = '',
    resourceId = system,
  ) {
    setBusy(true);
    setError('');
    try {
      await workspaceApi.saveFile({ resourceId, path: target, type, content: text });
      await refresh();
      listing.refresh();
      notify(type === 'directory' ? 'Folder created' : 'File saved');
      setNewItem(null);
      setName('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await workspaceApi.deleteFile({ resourceId: system, path: deleting.path });
      await refresh();
      listing.refresh();
      notify('Item deleted');
      if (editing?.id === deleting.id) {
        closePreview();
        setPendingAction(null);
      }
      setDeleting(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <FileWorkspaceHeader
        resource={selectedSystem}
        resources={systems}
        busy={busy || analysisBusy}
        fileCount={
          remote
            ? files.filter((file) => file.type === 'file').length
            : (localUsage?.fileCount ?? files.filter((file) => file.type === 'file').length)
        }
        sizeLabel={
          remote
            ? `${bytes(files.reduce((total, file) => total + fileSize(file), 0))} in folder`
            : localUsage?.storageBytes != null
              ? `${bytes(localUsage.storageBytes)} / 2 GiB`
              : `${bytes(files.reduce((total, file) => total + fileSize(file), 0))} loaded`
        }
        onConnect={() => {
          if (selectedSystem) onConnect(selectedSystem);
        }}
        onUpload={() => upload.current?.click()}
        onBack={() => requestPreviewChange(() => go('files'))}
        onTutorial={() => {
          if (selectedSystem)
            requestPreviewChange(() => {
              location.hash = tutorialHash(selectedSystem.id);
            });
        }}
        onSelect={(nextSystem) =>
          requestPreviewChange(() => {
            location.hash = fileSystemHash(nextSystem);
          })
        }
      />
      <input
        ref={upload}
        type="file"
        hidden
        aria-label="Upload a file"
        onChange={(e) => {
          if (e.target.files?.[0]) void fileUpload.upload(e.target.files[0]);
          e.target.value = '';
        }}
      />
      {fileUpload.status?.resourceId === system && (
        <FileUploadStatus status={fileUpload.status} onDismiss={fileUpload.dismiss} />
      )}
      {error && !editing && !newItem && !deleting && (
        <Alert color="red" mb={20}>
          {error}
        </Alert>
      )}
      {(listing.error || selectedSystem?.connectionError) && (
        <Alert color="red" mb={20}>
          {listing.error || selectedSystem?.connectionError}
          <Button
            ml={16}
            onClick={() => {
              listing.refresh();
              void refresh();
            }}
          >
            Retry
          </Button>
        </Alert>
      )}
      <div
        className="resource-workspace file-workspace"
        data-preview={editing ? true : undefined}
        data-browser-collapsed={browserCollapsed || undefined}
      >
        <FileBrowserPanel
          systemName={selectedSystem?.name || 'Files'}
          count={directoryFiles.length}
          path={path}
          search={search}
          onSearch={setSearch}
          onNavigate={setPath}
          onRefresh={() => {
            listing.refresh();
            void refresh();
          }}
          refreshing={listing.loading || analysisBusy}
          canCreate={!!system && !busy && !analysisBusy}
          onCreate={(type) => {
            setNewItem(type);
            setError('');
          }}
          collapsed={browserCollapsed}
          onToggle={() => setBrowserCollapsed((value) => !value)}
          footer={
            <>
              <span>
                {children.length} {listing.nextCursor || listing.earlier ? 'loaded ' : ''}items
              </span>
              {(listing.nextCursor || listing.earlier) && (
                <span>Filter applies to loaded files.</span>
              )}
              {listing.earlier && <Button onClick={listing.refresh}>Back to first files</Button>}
              {listing.nextCursor && (
                <Button loading={listing.loading} onClick={() => void listing.loadMore()}>
                  Load more files
                </Button>
              )}
              <span>
                {remote
                  ? `Stored in Singapore · Upload up to ${bytes(selectedSystem?.uploadLimitBytes || 0)}`
                  : 'Local persistent storage · UTF-8 text files up to 256 KiB'}
              </span>
            </>
          }
        >
          {listing.loading && (
            <Text p={24}>
              <Loader size="sm" /> Loading files…
            </Text>
          )}
          {systems.length ? (
            <FileBrowserList
              files={children}
              path={path}
              selectedId={editing?.id}
              busy={busy || analysisBusy}
              describeFile={(file) =>
                `${file.type === 'directory' ? 'Folder' : bytes(fileSize(file))} · ${relative(file.updatedAt)}`
              }
              onNavigate={(nextPath) => {
                setPath(nextPath);
                setSearch('');
              }}
              onOpen={(file, trigger) => {
                if (editing?.id === file.id) return;
                requestPreviewChange(() => {
                  setPreviewTrigger(trigger);
                  void openFile(file);
                });
              }}
              onDownload={downloadFile}
              onDelete={(file) => {
                setDeleting(file);
                setError('');
              }}
            />
          ) : (
            <Empty
              title="Add your first file system"
              description="Keep agent context available across sessions."
              action={<Button onClick={() => onCreate('filesystem')}>Create file system</Button>}
            />
          )}
          {systems.length > 0 && !children.length && !listing.loading && !listing.error && (
            <Empty
              title={search ? 'No matching files' : 'An open canvas'}
              description={
                search
                  ? 'Try another file name.'
                  : 'Create a file or upload some context to get started.'
              }
            />
          )}
        </FileBrowserPanel>
        {editing ? (
          <Suspense
            fallback={
              <Paper withBorder p={24}>
                <Loader aria-label="Loading file preview" />
              </Paper>
            }
          >
            <FilePreviewPanel
              key={editing.id}
              path={editing.path}
              resourceId={editing.resourceId}
              initialView={previewView}
              onViewChange={(view) =>
                history.replaceState(null, '', fileHash(editing.resourceId, editing.path, view))
              }
              content={content}
              savedContent={editing.content || ''}
              dirty={dirty}
              size={editing.size}
              loading={previewLoading}
              unavailableReason={unavailableReason}
              busy={busy}
              error={error}
              pendingChange={!!pendingAction}
              trigger={previewTrigger}
              onChange={setContent}
              onAnalysisRunningChange={setAnalysisBusy}
              onExportSaved={async () => {
                listing.refresh();
                await refresh();
              }}
              onClose={() => requestPreviewChange(closePreview)}
              onKeepEditing={() => setPendingAction(null)}
              onDiscard={() => {
                const action = pendingAction;
                setPendingAction(null);
                action?.();
              }}
              onDownload={() =>
                dirty ? download(editing.path.split('/').pop()!, content) : downloadFile(editing)
              }
              onSave={async () => {
                const file = editing;
                const savedContent = content;
                if (await saveFile(file.path, 'file', savedContent, file.resourceId)) {
                  setEditing((current) =>
                    current?.id === file.id
                      ? {
                          ...current,
                          content: savedContent,
                          size: new TextEncoder().encode(savedContent).length,
                        }
                      : current,
                  );
                  setPendingAction(null);
                }
              }}
            />
          </Suspense>
        ) : (
          <Paper className="panel file-placeholder" withBorder>
            <Empty
              title="Select a file"
              description="Choose a file on the left to preview, edit or analyze its contents."
            />
          </Paper>
        )}
      </div>
      <Alert className="notice quiet" color="peacock" icon={<ShieldCheck size={17} />}>
        <span>
          Use the same Workspace Key for databases and files. File operations require access to this
          File System and the corresponding read or write permission.
        </span>
      </Alert>
      {newItem && (
        <Modal
          title={newItem === 'file' ? 'Create a file' : 'Create a folder'}
          description={`Location: ${path}`}
          onClose={() => {
            setNewItem(null);
            setName('');
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || name.includes('/') || name === '.' || name === '..') {
                setError('Enter a name without slashes or path segments.');
                return;
              }
              const target = (path === '/' ? '' : path) + '/' + name.trim();
              if (files.some((f) => f.path === target)) {
                setError('An item with this name already exists.');
                return;
              }
              void saveFile(target, newItem);
            }}
          >
            <TextInput
              label="Name"
              autoFocus
              required
              maxLength={100}
              placeholder={newItem === 'file' ? 'context.md' : 'research'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {error && (
              <Alert className="inline-error" color="red">
                {error}
              </Alert>
            )}
            <div className="modal-actions">
              <Button type="button" onClick={() => setNewItem(null)}>
                Cancel
              </Button>
              <Button variant="filled" loading={busy} disabled={busy} type="submit">
                Create {newItem === 'file' ? 'file' : 'folder'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.type === 'directory' ? 'folder' : 'file'}?`}
          description={`“${deleting.path}” will be removed from this File System. Non-empty folders cannot be deleted.`}
          onClose={() => setDeleting(null)}
        >
          {error && (
            <Alert className="inline-error" color="red">
              {error}
            </Alert>
          )}
          <div className="modal-actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="filled" color="red" disabled={busy} onClick={remove}>
              Delete {deleting.type === 'directory' ? 'folder' : 'file'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Connect({ data, copy, onNewKey }: Shared & { onNewKey: () => void }) {
  const [tab, setTab] = useState('Agent');
  const snippet = `# Discover your workspace resources\ncurl ${apiBaseUrl}${base}/resources \\\n  -H "Authorization: Bearer $WORKSPACE_API_KEY"`;
  const python = `import os, json, urllib.request\n\nreq = urllib.request.Request(\n    "${apiBaseUrl}${base}/resources",\n    headers={"Authorization": "Bearer " + os.environ["WORKSPACE_API_KEY"]}\n)\nwith urllib.request.urlopen(req) as response:\n    print(json.load(response))`;
  const js = `const response = await fetch(\n  "${apiBaseUrl}${base}/resources",\n  { headers: { Authorization: \`Bearer \${process.env.WORKSPACE_API_KEY}\` } }\n);\nconsole.log(await response.json());`;
  const agents = agentInstructions(data.workspace.id, apiBaseUrl);
  return (
    <>
      <PageHeading
        eyebrow="BUILT FOR AGENTS"
        title="Connect an agent"
        description="Give your agent scoped access to databases and files with one Workspace Key."
        actions={
          <Button variant="filled" onClick={onNewKey} leftSection={<KeyRound size={18} />}>
            Create API key
          </Button>
        }
      />
      <div className="setup-layout">
        <Paper className="panel setup-steps" withBorder>
          <Heading level={2}>Connect in three steps</Heading>
          <div className="setup-step">
            <span>1</span>
            <div>
              <Heading level={3}>Create a workspace key</Heading>
              <Text component="p">
                Grant only the permissions your agent needs. Keys expire automatically and can be
                revoked anytime.
              </Text>
              <Anchor href="#keys">Manage API keys</Anchor>
            </div>
          </div>
          <div className="setup-step">
            <span>2</span>
            <div>
              <Heading level={3}>Make your workspace discoverable</Heading>
              <Text component="p">
                Provide the OpenAPI schema or reference WORKSPACE.md from your project’s existing
                agent instructions.
              </Text>
              <div className="inline-controls">
                <Button
                  onClick={() => download('WORKSPACE.md', agents)}
                  leftSection={React.createElement(ArrowDownToLine, { size: 18 })}
                >
                  Download workspace instructions
                </Button>
                <a
                  className="text-link"
                  href={apiBaseUrl + '/openapi.json'}
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenAPI schema <ArrowUpRight size={13} />
                </a>
              </div>
            </div>
          </div>
          <div className="setup-step">
            <span>3</span>
            <div>
              <Heading level={3}>Build with persistent context</Heading>
              <Text component="p">
                Call the REST API from an agent shell or your application. No custom SDK is required
                for this prototype.
              </Text>
            </div>
          </div>
        </Paper>
        <Paper className="panel connect-code-panel" withBorder>
          <ChoiceTabs value={tab} onChange={setTab} options={['Agent', 'JavaScript', 'Python']}>
            <Code
              value={tab === 'Agent' ? snippet : tab === 'Python' ? python : js}
              copy={copy}
              label={tab === 'Agent' ? 'SHELL' : tab.toUpperCase()}
            />
          </ChoiceTabs>
          <div className="connection-note">
            <ShieldCheck size={17} />
            <Text component="p">
              Inject <code>WORKSPACE_API_KEY</code> through your environment. The full key is
              displayed once when created.
            </Text>
          </div>
          <div className="capability-note">
            <Badge>REST API · Available locally</Badge>
            <Text component="p">
              Native MCP support is part of the proposed next phase. These instructions use the
              working REST API.
            </Text>
          </div>
        </Paper>
      </div>
    </>
  );
}
function Keys({ data, refresh, notify, onNewKey }: Shared & { onNewKey: () => void }) {
  const [revoke, setRevoke] = useState<ApiKey | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [keyWindow, setKeyWindow] = useState({
    keys: data.keys,
    next: data.keysNextCursor ?? null,
    earlier: false,
  });
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  useEffect(() => {
    setKeyWindow({ keys: data.keys, next: data.keysNextCursor ?? null, earlier: false });
    setPageError('');
  }, [data.keys, data.keysNextCursor]);
  async function loadKeys() {
    if (!keyWindow.next || pageBusy) return;
    const cursor = keyWindow.next;
    setPageBusy(true);
    setPageError('');
    try {
      const page = await workspaceApi.keysPage(cursor);
      setKeyWindow((current) => {
        if (current.next !== cursor) return current;
        const merged = new Map(current.keys.map((key) => [key.id, key]));
        for (const key of page.data) merged.set(key.id, key);
        const keys = [...merged.values()];
        return {
          keys: keys.slice(-200),
          next: page.nextCursor,
          earlier: current.earlier || keys.length > 200,
        };
      });
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : 'Unable to load keys.');
    } finally {
      setPageBusy(false);
    }
  }
  const active = keyWindow.keys.filter((k) => !k.revokedAt && Date.parse(k.expiresAt) > Date.now());
  async function doRevoke() {
    if (!revoke) return;
    setBusy(true);
    try {
      await workspaceApi.revokeKey(revoke.id);
      await refresh();
      setRevoke(null);
      notify('API key revoked. Access has been removed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="API keys"
        description="Scoped access for every agent, application, and workflow."
        actions={
          keyWindow.keys.length || keyWindow.next || keyWindow.earlier ? (
            <Button
              variant="filled"
              leftSection={React.createElement(Plus, { size: 18 })}
              onClick={onNewKey}
            >
              Create API key
            </Button>
          ) : undefined
        }
      />
      <Alert className="notice" color="peacock" icon={<ShieldCheck size={18} />}>
        <span>
          One Workspace Key can access your databases and files. Choose its allowed resources and
          actions; provider credentials are managed by the service.
        </span>
      </Alert>
      <div className="section-title">
        <Heading level={2}>
          Workspace keys{' '}
          <span>
            {active.length}
            {keyWindow.next || keyWindow.earlier ? '+' : ''} active
          </span>
        </Heading>
        <Badge>Workspace scoped</Badge>
      </div>
      <Paper className="panel table-panel" withBorder>
        {keyWindow.keys.length ? (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name & key</Table.Th>
                <Table.Th>Resource access</Table.Th>
                <Table.Th>Permissions</Table.Th>
                <Table.Th>Last used</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {keyWindow.keys.map((k) => (
                <Table.Tr key={k.id}>
                  <Table.Td>
                    <div className="key-name">
                      <KeyRound size={17} />
                      <div>
                        <strong>{k.name}</strong>
                        <code>{k.prefix}…</code>
                      </div>
                    </div>
                  </Table.Td>
                  <Table.Td>
                    <div className="scope-chips">
                      {k.resourceIds.includes('*') ? (
                        <Badge>All current & future resources</Badge>
                      ) : k.resourceIds.length ? (
                        k.resourceIds.map((id) => (
                          <Badge key={id}>
                            {data.resources.find((resource) => resource.id === id)?.name || id}
                          </Badge>
                        ))
                      ) : (
                        <Badge>Reissue to grant access</Badge>
                      )}
                    </div>
                  </Table.Td>
                  <Table.Td>
                    <div className="scope-chips">
                      {k.scopes.map((s) => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </div>
                  </Table.Td>
                  <Table.Td>{k.lastUsedAt ? relative(k.lastUsedAt) : 'Never'}</Table.Td>
                  <Table.Td>{new Date(k.expiresAt).toLocaleDateString()}</Table.Td>
                  <Table.Td>
                    <Badge color="carbon">
                      {k.revokedAt
                        ? 'Revoked'
                        : Date.parse(k.expiresAt) <= Date.now()
                          ? 'Expired'
                          : 'Active'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {!k.revokedAt && (
                      <Button
                        className="text-link danger-link"
                        onClick={() => {
                          setRevoke(k);
                          setError('');
                        }}
                        variant="subtle"
                      >
                        Revoke
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Empty
            icon={KeyRound}
            title="A key for every workflow"
            description="Create your first API key to give an agent access to this workspace."
            action={
              <Button
                variant="filled"
                leftSection={React.createElement(Plus, { size: 18 })}
                onClick={onNewKey}
              >
                Create API key
              </Button>
            }
          />
        )}
        {pageError && <Alert color="red">{pageError}</Alert>}
        {(keyWindow.next || keyWindow.earlier) && (
          <Group justify="center" my="md">
            {keyWindow.earlier && (
              <Button
                onClick={() =>
                  setKeyWindow({
                    keys: data.keys,
                    next: data.keysNextCursor ?? null,
                    earlier: false,
                  })
                }
              >
                Back to first keys
              </Button>
            )}
            {keyWindow.next && (
              <Button loading={pageBusy} onClick={() => void loadKeys()}>
                Load more keys
              </Button>
            )}
          </Group>
        )}
      </Paper>
      <div className="two-column">
        <Paper className="panel info-panel" withBorder>
          <ShieldCheck size={22} />
          <Heading level={3}>Least privilege by default</Heading>
          <Text component="p">
            Use read-only access for exploration. Add write and query permissions only when your
            workflow needs them.
          </Text>
        </Paper>
        <Paper className="panel info-panel" withBorder>
          <RefreshCw size={22} />
          <Heading level={3}>Rotate without surprises</Heading>
          <Text component="p">
            Create a replacement key, update your agent’s environment, then revoke the old key. Full
            keys are never stored on the server.
          </Text>
        </Paper>
      </div>
      {revoke && (
        <Modal
          title="Revoke API key?"
          description={`Agents using “${revoke.name}” will immediately lose access. Create a replacement first if the workflow should keep running.`}
          onClose={() => setRevoke(null)}
        >
          {error && (
            <Alert className="inline-error" color="red">
              {error}
            </Alert>
          )}
          <div className="modal-actions">
            <Button onClick={() => setRevoke(null)}>Cancel</Button>
            <Button variant="filled" color="red" disabled={busy} onClick={doRevoke}>
              Revoke key
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ApiExplorer({ data, copy }: Shared) {
  const [endpoint, setEndpoint] = useState('/resources'),
    [result, setResult] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const fileSystem = data.resources.find((r) => r.kind === 'filesystem');
  const endpoints = [
    { path: '/resources', label: 'List resources', scope: 'resources:read' },
    { path: '/usage', label: 'Get usage', scope: 'usage:read' },
    { path: '/events', label: 'List activity', scope: 'resources:read' },
    ...(fileSystem
      ? [{ path: '/files?resourceId=' + fileSystem.id, label: 'List files', scope: 'files:read' }]
      : []),
  ];
  async function run() {
    setBusy(true);
    setError('');
    try {
      const result =
        endpoint === '/resources'
          ? await workspaceApi.resources()
          : endpoint === '/usage'
            ? await workspaceApi.usage()
            : endpoint === '/events'
              ? await workspaceApi.events()
              : await workspaceApi.listFiles(fileSystem?.id || '');
      setResult(JSON.stringify(result, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="API explorer"
        description="The same API powers your console and your agents."
        actions={
          <Anchor
            href={apiBaseUrl + '/openapi.json'}
            target="_blank"
            rel="noreferrer"
            className="schema-link"
          >
            <ArrowUpRight size={15} />
            OpenAPI 3.1 schema
          </Anchor>
        }
      />
      <div className="api-layout">
        <Paper className="panel endpoint-list" withBorder>
          <div className="panel-header">
            <Heading level={2}>Workspace API</Heading>
            <Badge>v1</Badge>
          </div>
          {endpoints.map((e) => (
            <NavLink
              key={e.path}
              active={endpoint === e.path}
              label={e.label}
              description={e.path.split('?')[0]}
              leftSection={<Badge color="green">GET</Badge>}
              onClick={() => {
                setEndpoint(e.path);
                setResult('');
                setError('');
              }}
            />
          ))}
          <div className="endpoint-note">
            The schema also documents resource creation, file writes, queries, and key management.
          </div>
        </Paper>
        <div className="api-main">
          <Paper className="panel" withBorder>
            <div className="panel-header">
              <Heading level={2}>{endpoints.find((e) => e.path === endpoint)?.label}</Heading>
              <Badge>{endpoints.find((e) => e.path === endpoint)?.scope}</Badge>
            </div>
            <div className="api-url">
              <span className="http-method">GET</span>
              <code>{base + endpoint}</code>
              <Button
                variant="filled"
                loading={busy}
                leftSection={<Play size={18} />}
                onClick={run}
                disabled={busy}
              >
                Send request
              </Button>
            </div>
            <div className="api-auth-note">
              <ShieldCheck size={14} /> Explorer uses your local owner session. Agents use Bearer
              authentication.
            </div>
            <Code
              label="cURL"
              copy={copy}
              value={`curl '${apiBaseUrl}${base + endpoint}' \\\n  -H "Authorization: Bearer $WORKSPACE_API_KEY"`}
            />
          </Paper>
          <Paper className="panel api-response" withBorder>
            <div className="panel-header">
              <Heading level={2}>Response</Heading>
              {result && <Badge color="green">200 OK</Badge>}
            </div>
            {error ? (
              <Alert className="inline-error" color="red">
                {error}
              </Alert>
            ) : result ? (
              <Code label="JSON" value={result} copy={copy} />
            ) : (
              <Empty
                icon={Terminal}
                title="See the API in action"
                description="Send a request to inspect the real local response."
              />
            )}
          </Paper>
        </div>
      </div>
    </>
  );
}
function Monitoring({ data }: Shared) {
  const [tab, setTab] = useState('Metrics'),
    [range, setRange] = useState('24h'),
    [filter, setFilter] = useState('');
  const events = data.events.filter((e) =>
    (e.action + ' ' + e.resource + ' ' + e.actor).toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        title="Monitoring"
        description="Understand what your workspace is doing, and who is doing it."
        actions={
          <SegmentedControl
            aria-label="Activity time range"
            value={range}
            onChange={setRange}
            data={[
              { value: '24h', label: '24 hours' },
              { value: '7d', label: '7 days' },
            ]}
          />
        }
      />
      <ChoiceTabs value={tab} onChange={setTab} options={['Metrics', 'Activity log']}>
        {tab === 'Metrics' ? (
          <>
            <Alert className="notice" color="peacock" icon={<Activity size={17} />}>
              <span>
                Charts below are illustrative. Resource counts and local action counts come from the
                running prototype. Cloud QPS and latency are not connected.
              </span>
            </Alert>
            <div className="metric-cards">
              {[
                {
                  name: 'Active resources',
                  value:
                    data.resourceNextCursor || data.resourceWindowTruncated
                      ? `${data.resources.length}+`
                      : data.resources.length,
                  unit: 'resources',
                  icon: Database,
                },
                {
                  name: 'Queries executed',
                  value: data.queryCount,
                  unit: 'local queries',
                  icon: Code2,
                },
                {
                  name: 'Active API keys',
                  value: data.keys.filter(
                    (k) => !k.revokedAt && Date.parse(k.expiresAt) > Date.now(),
                  ).length,
                  unit: 'keys',
                  icon: KeyRound,
                },
                {
                  name: 'Activity events',
                  value: data.events.length,
                  unit: 'local events',
                  icon: Activity,
                },
              ].map((m) => (
                <Paper className="panel metric-card" key={m.name} withBorder>
                  <div>
                    <span>{m.name}</span>
                    <m.icon size={16} />
                  </div>
                  <strong>{m.value}</strong>
                  <small>{m.unit}</small>
                </Paper>
              ))}
            </div>
            <div className="two-column">
              <Paper className="panel monitoring-chart" withBorder>
                <div className="panel-header">
                  <Heading level={2}>Request activity</Heading>
                  <Badge>Illustrative</Badge>
                </div>
                <div className="chart-wrap">
                  <Sparkline large range={range} />
                  <div className="chart-axis">
                    <span>{range === '7d' ? '7 days ago' : '24 hours ago'}</span>
                    <span>Now</span>
                  </div>
                </div>
              </Paper>
              <Paper className="panel monitoring-chart blue-chart" withBorder>
                <div className="panel-header">
                  <Heading level={2}>Query duration</Heading>
                  <Badge>Illustrative</Badge>
                </div>
                <div className="chart-wrap">
                  <Sparkline large range={range === '7d' ? '24h' : '7d'} />
                  <div className="chart-axis">
                    <span>{range === '7d' ? '7 days ago' : '24 hours ago'}</span>
                    <span>Now</span>
                  </div>
                </div>
              </Paper>
            </div>
            <div className="section-title">
              <Heading level={2}>Resource health</Heading>
            </div>
            <Paper className="panel" withBorder>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Resource</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Provider</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.resources.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td>
                        <div className="table-resource">
                          <KindIcon small kind={r.kind} />
                          <strong>{r.name}</strong>
                        </div>
                      </Table.Td>
                      <Table.Td>{kindLabel[r.kind]}</Table.Td>
                      <Table.Td>
                        {r.provider === 'drive9-anonymous'
                          ? 'Live trial'
                          : r.provider === 'db9-anonymous'
                            ? 'db9 PostgreSQL'
                            : r.provider === 'duckdb-drive9'
                              ? 'DuckDB'
                              : r.provider === 'tidb-cloud-zero'
                                ? 'Zero trial'
                                : 'Local demo'}
                      </Table.Td>
                      <Table.Td>
                        <span className="status">
                          <span className="live-dot" />
                          {r.connectionError ? 'Connection unavailable' : r.status}
                        </span>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          </>
        ) : (
          <>
            <div className="log-toolbar">
              <div className="input-with-icon">
                <Search size={15} />
                <TextInput
                  aria-label="Filter activity"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by action, resource, or actor…"
                />
              </div>
              <span>{events.length} events · Latest 200 local events</span>
            </div>
            <Paper className="panel table-panel" withBorder>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Action</Table.Th>
                    <Table.Th>Resource</Table.Th>
                    <Table.Th>Actor</Table.Th>
                    <Table.Th>Result</Table.Th>
                    <Table.Th>Time</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {events.map((e) => (
                    <Table.Tr key={e.id}>
                      <Table.Td>
                        <code>{e.action}</code>
                      </Table.Td>
                      <Table.Td>{e.resource}</Table.Td>
                      <Table.Td>{e.actor}</Table.Td>
                      <Table.Td>
                        <Badge color="green">Success</Badge>
                      </Table.Td>
                      <Table.Td>{new Date(e.at).toLocaleString()}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {!events.length && (
                <Empty title="No matching events" description="Try a different filter." />
              )}
            </Paper>
          </>
        )}
      </ChoiceTabs>
    </>
  );
}
function Billing({ data }: Shared) {
  return (
    <>
      <PageHeading
        title="Usage & billing"
        description="Start free. Know your limits before you reach them."
        actions={
          <Badge color="green">
            <ShieldCheck size={13} />
            No payment method
          </Badge>
        }
      />
      <Paper className="billing-overview panel" withBorder>
        <div>
          <Badge>FREE PLAN</Badge>
          <Heading level={2}>Room to experiment.</Heading>
          <Text component="p">
            Billing is not connected. Anonymous File Systems use the service’s trial limits;
            database usage remains simulated.
          </Text>
        </div>
        <div className="billing-total">
          <span>Billing integration</span>
          <strong>
            —<small>Not connected</small>
          </strong>
          <span>No settled charges or cloud quota measurements available</span>
        </div>
      </Paper>
      <div className="section-title">
        <Heading level={2}>Resource allowances</Heading>
        <a
          className="text-link"
          href="https://docs.pingcap.com/tidbcloud/select-cluster-tier/"
          target="_blank"
          rel="noreferrer"
        >
          Current cloud limits <ArrowUpRight size={14} />
        </a>
      </div>
      <Paper className="panel table-panel" withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Resource</Table.Th>
              <Table.Th>Storage</Table.Th>
              <Table.Th>Request units / month</Table.Th>
              <Table.Th>Plan</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.usage.map((u) => (
              <Table.Tr key={u.resourceId}>
                <Table.Td>
                  <div className="table-resource">
                    <KindIcon small kind={u.kind} />
                    <div>
                      <strong>{u.name}</strong>
                      <small>{kindLabel[u.kind]}</small>
                    </div>
                  </div>
                </Table.Td>
                <Table.Td>
                  <div className="usage-cell">
                    {u.measured === false ? (
                      <span>Not measured · Service trial limits apply</span>
                    ) : (
                      <>
                        <span>
                          {bytes(u.storageBytes ?? 0)}{' '}
                          <small>/ {(u.storageLimitBytes || 0) / 1024 ** 3} GiB</small>
                        </span>
                        <Progress
                          value={Math.min(
                            ((u.storageBytes ?? 0) / (u.storageLimitBytes || 1)) * 100,
                            100,
                          )}
                          aria-label={`${u.name} storage used`}
                        />
                      </>
                    )}
                  </div>
                </Table.Td>
                <Table.Td>
                  {u.monthlyRULimit ? (
                    <>
                      {'0'} <small>/ {u.monthlyRULimit / 1000000}M</small>
                    </>
                  ) : (
                    'Read / write / storage / egress'
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge color="carbon">
                    {u.measured === false
                      ? 'Anonymous trial'
                      : u.kind === 'mysql'
                        ? 'Starter Free'
                        : 'Free · Preview'}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
      <div className="two-column">
        <Paper className="panel info-panel" withBorder>
          <Folder size={22} />
          <Heading level={3}>File System provider limits</Heading>
          <Text component="p">
            Anonymous File Systems use service-enforced trial limits. This Console does not yet
            measure total storage, file-count quotas, or cloud charges.
          </Text>
          <Text className="muted" component="p">
            TiDB Cloud account-bound allowances are separate from the anonymous trial. The file
            browser shows the current upload limit.
          </Text>
          <a
            className="text-link"
            href="https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-limits/"
            target="_blank"
            rel="noreferrer"
          >
            File System limits <ArrowUpRight size={13} />
          </a>
        </Paper>
        <Paper className="panel info-panel" withBorder>
          <ShieldCheck size={22} />
          <Heading level={3}>Predictable limits</Heading>
          <Text component="p">
            TiDB Cloud Zero is temporary and service limits apply. Export important data before the
            database expires.
          </Text>
          <Text className="muted" component="p">
            File System requests can be rejected when a trial quota is reached. Keep important files
            backed up; anonymous trials are for evaluation.
          </Text>
        </Paper>
      </div>
      <Alert className="notice quiet" color="peacock" icon={<CreditCard size={18} />}>
        <span>
          Payments, invoices, and paid upgrades are deferred for this validation release. No payment
          information is collected.
        </span>
      </Alert>
    </>
  );
}
function WorkspaceSettings({
  data,
  refresh,
  notify,
  copy,
  sso,
  onSignOut,
}: Shared & { sso: SsoAuthConfig; onSignOut: () => void }) {
  const [name, setName] = useState(data.profile.name),
    [workspaceName, setWorkspaceName] = useState(data.workspace.name),
    [description, setDescription] = useState(data.workspace.description),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await workspaceApi.settings({ name, workspaceName, description });
      await refresh();
      notify('Workspace settings saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title="Settings" description="Make this workspace yours." />
      <form onSubmit={save} className="settings-form">
        <Paper className="panel settings-panel" withBorder>
          <div className="panel-header">
            <div>
              <Heading level={2}>Workspace details</Heading>
              <Text component="p">The home for your resources and agent workflows.</Text>
            </div>
          </div>
          <div className="settings-fields">
            <TextInput
              label="Workspace name"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              required
              minLength={2}
              maxLength={50}
            />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
            />
            <TextInput
              label="Workspace ID"
              readOnly
              value={data.workspace.id}
              rightSection={
                <ActionIcon aria-label="Copy workspace ID" onClick={() => copy(data.workspace.id)}>
                  <Copy size={18} />
                </ActionIcon>
              }
            />
          </div>
        </Paper>
        <Paper className="panel settings-panel" withBorder>
          <div className="panel-header">
            <div>
              <Heading level={2}>Personal account</Heading>
              <Text component="p">Your workspace display profile.</Text>
            </div>
            <Badge>{sso.enabled ? 'Workspace owner' : 'Local owner'}</Badge>
          </div>
          <div className="settings-fields">
            <TextInput
              label="Display name"
              required
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="account-row">
              <span className="profile-avatar">{name.slice(0, 1).toUpperCase()}</span>
              <div className="account-session-summary">
                <strong>
                  {sso.sessionKind === 'guest'
                    ? 'Guest session'
                    : sso.enabled
                      ? 'TiDB Account session'
                      : 'Local session'}
                </strong>
                <Text component="p">
                  {sso.sessionKind === 'guest'
                    ? 'Your Guest workspace expires 24 hours after it was created.'
                    : sso.enabled
                      ? 'Signed in with your TiDB Account. This is your personal workspace.'
                      : 'Local development session. Your workspace uses the configured local storage.'}
                </Text>
              </div>
              <Badge color="green">Active</Badge>
              {sso.enabled &&
                sso.logoutPath &&
                (sso.sessionKind !== 'guest' || sso.guestCleanupEnabled) && (
                  <Button variant="default" onClick={onSignOut}>
                    Sign out
                  </Button>
                )}
            </div>
          </div>
        </Paper>
        {error && (
          <Alert className="inline-error" color="red">
            {error}
          </Alert>
        )}
        <div className="settings-save">
          <Text component="p">Changes apply to this workspace.</Text>
          <Button variant="filled" loading={busy} disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
      <Alert className="notice quiet" color="peacock" icon={<KeyRound size={17} />}>
        <span>
          For automation, create a scoped API key. Signing in does not grant TiDB Cloud account
          administration access.
        </span>
      </Alert>
    </>
  );
}
function CreateKey({
  data,
  refresh,
  notify,
  copy,
  onClose,
  loadMoreResources,
  resourcePageBusy,
  resourcePageError,
}: Shared & { onClose: () => void }) {
  const [name, setName] = useState(''),
    [scopes, setScopes] = useState<CreateKeyInput['scopes']>([
      'resources:read',
      'files:read',
      'usage:read',
    ]),
    [resourceIds, setResourceIds] = useState(data.resources.map((resource) => resource.id)),
    [expires, setExpires] = useState<CreateKeyInput['expiresInDays']>(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [secret, setSecret] = useState('');
  const visibleResourceIds = new Set(data.resources.map((resource) => resource.id));
  const hiddenSelections = resourceIds.filter((id) => id !== '*' && !visibleResourceIds.has(id));
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await workspaceApi.createKey({
        name,
        scopes,
        resourceIds,
        expiresInDays: expires,
      });
      setSecret(result.secret);
      await refresh();
      notify('API key created');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={secret ? 'Your key is ready' : 'Create API key'}
      description={
        secret
          ? 'Copy it now. You won’t be able to view the full key again.'
          : 'Give one workflow exactly the access it needs.'
      }
      onClose={onClose}
    >
      {secret ? (
        <>
          <div className="secret-value">
            <KeyRound size={20} />
            <code>{secret}</code>
          </div>
          <Alert className="notice" color="peacock" icon={<ShieldCheck size={17} />}>
            <span>
              Save this in your agent’s environment as WORKSPACE_API_KEY. This Workspace Key only
              works against the local workspace API.
            </span>
          </Alert>
          <div className="modal-actions">
            <Button
              leftSection={React.createElement(Copy, { size: 18 })}
              onClick={() => copy(secret)}
            >
              Copy key
            </Button>
            <Button variant="filled" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={create}>
          <TextInput
            label="Key name"
            required
            minLength={2}
            maxLength={60}
            placeholder="e.g. coding-agent-dev"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ResourceAccessPicker
            resources={data.resources}
            resourceIds={resourceIds}
            onChange={(ids) => {
              setResourceIds(ids);
              if (!ids.includes('*'))
                setScopes((current) => current.filter((scope) => scope !== 'resources:write'));
            }}
          />
          {hiddenSelections.length > 0 && (
            <Group mt="sm">
              <Text size="sm">
                {hiddenSelections.length} selected resources are outside the loaded window.
              </Text>
              <Button
                type="button"
                onClick={() =>
                  setResourceIds((ids) => ids.filter((id) => visibleResourceIds.has(id)))
                }
              >
                Clear hidden selections
              </Button>
            </Group>
          )}
          {(data.resourceNextCursor || data.resourceWindowTruncated) && (
            <Group mt="sm">
              {data.resourceWindowTruncated && (
                <Button type="button" onClick={() => void refresh()}>
                  Back to first resources
                </Button>
              )}
              {data.resourceNextCursor && (
                <Button
                  type="button"
                  loading={resourcePageBusy}
                  onClick={() => void loadMoreResources()}
                >
                  Load more resources
                </Button>
              )}
              <Text size="sm">Newly loaded resources are not selected automatically.</Text>
            </Group>
          )}
          {resourcePageError && <Alert color="red">{resourcePageError}</Alert>}
          <Fieldset legend="Allowed actions">
            <div className="scope-picker">
              {allScopes.map((s) => (
                <Checkbox
                  label={
                    <span>
                      <code>{s}</code>
                      <small>
                        {
                          (
                            {
                              'resources:read': 'Discover workspace resources',
                              'resources:write': 'Create resources',
                              'files:read': 'Read files and context',
                              'files:analyze': 'Analyze files (read-only SQL and Bash)',
                              'files:write': 'Create, edit, and delete files',
                              'queries:execute': 'Read and write SQL on permitted databases',
                              'usage:read': 'Read usage and allowances',
                            } as Record<string, string>
                          )[s]
                        }
                      </small>
                    </span>
                  }
                  className="permission-choice"
                  key={s}

                  checked={scopes.includes(s)}
                  disabled={s === 'resources:write' && !resourceIds.includes('*')}
                  onChange={(e) =>
                    setScopes(e.target.checked ? [...scopes, s] : scopes.filter((v) => v !== s))
                  }
                />
              ))}
            </div>
          </Fieldset>
          <NativeSelect
            label="Expiration"
            value={expires}
            onChange={(e) => {
              const days = Number(e.target.value);
              if (days === 7 || days === 30 || days === 90) setExpires(days);
            }}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </NativeSelect>
          {error && (
            <Alert className="inline-error" color="red">
              {error}
            </Alert>
          )}
          <div className="modal-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="filled"
              leftSection={React.createElement(KeyRound, { size: 18 })}
              loading={busy}
              disabled={busy || !scopes.length || !resourceIds.length}
              type="submit"
            >
              {busy ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function Connection({
  resource: r,
  copy,
  onClose,
}: {
  resource: Resource;
  copy: (s: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('REST API');
  const isFileSystem = r.kind === 'filesystem';
  const endpoint = `${apiBaseUrl}${base}${isFileSystem ? `/files?resourceId=${r.id}` : '/queries'}`;
  const payload = JSON.stringify({ resourceId: r.id, sql: 'SELECT 1 AS connected;' });
  const shell = [
    `curl '${endpoint}'`,
    '  -H "Authorization: Bearer $WORKSPACE_API_KEY"',
    ...(isFileSystem ? [] : ["  -H 'Content-Type: application/json'", `  -d '${payload}'`]),
  ].join(' \\' + '\n');
  const javascript = [
    'const response = await fetch(',
    `  "${endpoint}",`,
    '  {',
    `    method: "${isFileSystem ? 'GET' : 'POST'}",`,
    '    headers: {',
    '      Authorization: `Bearer ${process.env.WORKSPACE_API_KEY}`,',
    '      "Content-Type": "application/json"',
    `    }${isFileSystem ? '' : ','}`,
    ...(isFileSystem ? [] : [`    body: JSON.stringify(${payload})`]),
    '  }',
    ');',
    'console.log(await response.json());',
  ].join('\n');
  const python = [
    'import os, json, urllib.request',
    '',
    'request = urllib.request.Request(',
    `    "${endpoint}",`,
    '    headers={',
    '        "Authorization": "Bearer " + os.environ["WORKSPACE_API_KEY"],',
    '        "Content-Type": "application/json"',
    `    }${isFileSystem ? '' : ','}`,
    ...(isFileSystem ? [] : [`    data=json.dumps(${payload}).encode()`]),
    ')',
    'with urllib.request.urlopen(request) as response:',
    '    print(json.load(response))',
  ].join('\n');
  return (
    <Modal
      wide
      title={`Connect to ${r.name}`}
      description={`${kindLabel[r.kind]} · One Workspace Key`}
      onClose={onClose}
    >
      <Alert className="notice" color="peacock" icon={<KeyRound size={17} />}>
        <span>
          Use a Workspace Key with access to <strong>{r.name}</strong> and{' '}
          <code>{isFileSystem ? 'files:read' : 'queries:execute'}</code>. The same key can access
          your other permitted resources.
        </span>
      </Alert>
      <ChoiceTabs value={tab} onChange={setTab} options={['REST API', 'JavaScript', 'Python']}>
        <Code
          copy={copy}
          label={
            r.provider === 'drive9-anonymous'
              ? 'WORKSPACE API · LIVE FILE TRIAL'
              : r.provider === 'duckdb-drive9'
                ? 'WORKSPACE API · DUCKDB'
                : r.provider === 'db9-anonymous'
                  ? 'WORKSPACE API · LIVE POSTGRESQL'
                  : r.provider === 'tidb-cloud-zero'
                    ? 'WORKSPACE API · LIVE ZERO'
                    : 'WORKSPACE API · LOCAL DEMO'
          }
          value={tab === 'REST API' ? shell : tab === 'JavaScript' ? javascript : python}
        />
      </ChoiceTabs>
      <div className="connection-note">
        <ShieldCheck size={18} />
        <Text component="p">
          {r.provider === 'drive9-anonymous'
            ? 'Files are stored in the Singapore anonymous trial. Use the file content API for upload, preview, and download; provider credentials stay inside the service. Native file mounts are not available yet.'
            : r.provider === 'duckdb-drive9'
              ? 'SQL runs in your persistent DuckDB database through the Workspace API. Use this database resource and queries:execute; internal storage and credentials are managed by the service.'
              : r.provider === 'db9-anonymous'
                ? 'SQL runs on a real db9 PostgreSQL-compatible database through the Workspace API. Use queries:execute and this resource grant; native credentials stay inside the service. Check db9 type compatibility before relying on full PostgreSQL behavior.'
                : r.provider === 'tidb-cloud-zero'
                  ? 'SQL runs on a temporary TiDB Cloud Zero database through the Workspace API. This key action permits reads and writes within the internal database role; connection credentials remain private.'
                  : 'Provider credentials are handled by the service. This resource uses a local demo provider; native database connections and file mounts are not available yet.'}
        </Text>
      </div>
      <div className="modal-actions">
        <Button
          onClick={() => {
            onClose();
            go('keys');
          }}
        >
          Manage keys
        </Button>
        <Button
          variant="filled"
          onClick={() => {
            onClose();
            if (isFileSystem) location.hash = fileSystemHash(r.id);
            else openDatabaseEditor(r.id);
          }}
        >
          Open {isFileSystem ? 'file browser' : 'SQL editor'} <ArrowRight size={14} />
        </Button>
      </div>
    </Modal>
  );
}
function SearchModal({
  data,
  onClose,
  onConnect,
}: {
  data: Data;
  onClose: () => void;
  onConnect: (r: Resource) => void;
}) {
  const [query, setQuery] = useState('');
  const pages = Object.entries(routes).filter(([, r]) =>
    r.label.toLowerCase().includes(query.toLowerCase()),
  );
  const resources = data.resources.filter((r) =>
    r.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title="Search workspace" onClose={onClose}>
      <div className="input-with-icon search-modal-input">
        <Search size={18} />
        <TextInput
          autoFocus
          placeholder="Search pages or resources…"
          aria-label="Search pages or resources"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>esc</kbd>
      </div>
      <div className="search-results">
        <div className="nav-label">Pages</div>
        {pages.map(([key, r]) => (
          <UnstyledButton
            key={key}
            onClick={() => {
              go(key as Route);
              onClose();
            }}
          >
            <r.icon size={17} />
            <span>{r.label}</span>
            <ArrowUpRight size={14} />
          </UnstyledButton>
        ))}
        <div className="nav-label">Resources</div>
        {resources.map((r) => (
          <UnstyledButton
            key={r.id}
            onClick={() => {
              onClose();
              setTimeout(() => onConnect(r), 0);
            }}
          >
            <KindIcon small kind={r.kind} />
            <span>{r.name}</span>
            <Badge>{kindLabel[r.kind]}</Badge>
          </UnstyledButton>
        ))}
        {!pages.length && !resources.length && <Text component="p">No results for “{query}”.</Text>}
      </div>
    </Modal>
  );
}

export default App;
