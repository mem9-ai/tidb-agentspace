import { ReportFilesEntry } from './features/reports/ReportFilesEntry';
import { ApiDocumentation } from './features/api/ApiDocumentation';
import { capturePage, startAnalytics } from './features/analytics/capture';
import { WorkspaceApiError } from './api/transport';
import {
  apiBaseUrl,
  base,
  workspaceApi,
  workspaceId,
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
import { GuestExpiryNotice } from './features/resources/ResourceQuickStart';
import { SalesSampleJourney } from './features/portal/SalesSampleJourney';
import { useDefaultFileSystem } from './features/portal/useDefaultFileSystem';
import {
  useRemoteFiles,
  downloadRemoteFile,
  fileSize,
  type WorkspaceFile,
} from './features/files/remote-files';
import { CreateResourceDialog } from './features/resources/CreateResourceDialog';
import { TutorialProgressProvider } from './features/portal/TutorialProgressProvider';
import { rememberUploadSignIn, restoreUploadAfterSignIn } from './features/navigation/upload-entry';
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
  Loader,
  NativeSelect,
  Paper,
  Progress,
  Table,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
  Anchor,
  Notification,
  Group,
} from '@tidbcloud/uikit';
import { WorkspaceModal as Modal } from './ui/WorkspaceModal';
import { CodeExample as Code } from './ui/CodeExample';
import { ChoiceTabs } from './ui/ChoiceTabs';
import { Heading } from './ui/WorkspaceHeading';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconArrowRight as ArrowRight,
  IconArrowUpRight as ArrowUpRight,
  IconCheckCircle as CheckCircle2,
  IconCopy03 as Copy,
  IconCreditCard01 as CreditCard,
  IconDatabase01 as Database,
  IconFolder as Folder,
  IconKey01 as KeyRound,
  IconLayoutGrid01 as LayoutDashboard,
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
import {
  KeyPermissions,
  permitsSalesTask,
  retainApplicablePermissions,
} from './features/keys/KeyPermissions';
import { KeyReady } from './features/keys/KeyReady';
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
type PortalData = Data & { resourceWindowTruncated?: boolean; usageNeedsRefresh?: boolean };

const routes: Record<Route, { label: string; icon: WorkspaceIcon; group: string }> = {
  overview: { label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  files: { label: 'File Systems', icon: Folder, group: 'Workspace' },
  databases: { label: 'Databases', icon: Database, group: 'Workspace' },
  connect: { label: 'Connect an agent', icon: Workflow, group: 'Build' },
  tutorials: { label: 'Tutorials', icon: CircleHelp, group: 'Build' },
  keys: { label: 'API keys', icon: KeyRound, group: 'Build' },
  api: { label: 'API documentation', icon: Terminal, group: 'Build' },
  billing: { label: 'Usage & billing', icon: CreditCard, group: 'Manage' },
  settings: { label: 'Settings', icon: Settings, group: 'Manage' },
};

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

function App({ enterWorkspaceFiles }: { enterWorkspaceFiles: boolean }) {
  const guestEntryRequested = useRef(enterWorkspaceFiles);
  const [data, setData] = useState<PortalData | null>(null),
    [routeLocation, setRouteLocation] = useState<WorkspaceRoute>(currentRoute),
    [error, setError] = useState(''),
    [needsSignIn, setNeedsSignIn] = useState(false),
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
  const [freshGuestOverview, setFreshGuestOverview] = useState<string>();
  const [tutorialCreation, setTutorialCreation] = useState(false);
  const [keyPreset, setKeyPreset] = useState<Resource>();
  const [salesPrompt, setSalesPrompt] = useState<string>();
  const [sampleKey, setSampleKey] = useState<{
    workspaceId: string;
    resourceId: string;
    suitable: boolean;
    pending: boolean;
    launchPrepared?: boolean;
  }>();
  const route = routeLocation.page;
  const visibleData = useMemo(
    () =>
      data && {
        ...data,
        resources: data.resources.filter(
          (resource) => !['duckdb', 'mysql'].includes(resource.kind),
        ),
        usage: data.usage.filter((item) => !['duckdb', 'mysql'].includes(item.kind)),
      },
    [data],
  );
  const selectedResourceId =
    routeLocation.databaseId ??
    parseFileSystemLocation('#' + (routeLocation.fileLink || 'files'))?.resourceId;
  const selectedResourceIdRef = useRef(selectedResourceId);
  selectedResourceIdRef.current = selectedResourceId;
  const lookupKey = data && selectedResourceId ? `${data.workspace.id}:${selectedResourceId}` : '';
  const selectedLoaded = Boolean(
    data?.resources.some((resource) => resource.id === selectedResourceId),
  );
  const knownFileSystem =
    route === 'files' &&
    data?.resources.some(
      (resource) =>
        resource.id === selectedResourceId &&
        resource.kind === 'filesystem' &&
        resource.status === 'active' &&
        !resource.connectionError,
    );
  const resourceName = visibleData?.resources.find(
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
  const acceptResource = useCallback((workspaceId: string, resource: Resource) => {
    setData((current) => {
      if (current?.workspace.id !== workspaceId) return current;
      const window = resourceWindow(current.resources, [resource], selectedResourceIdRef.current);
      return {
        ...current,
        resources: window.resources,
        resourceWindowTruncated: Boolean(current.resourceWindowTruncated || window.dropped),
        mode: resource.provider && resource.provider !== 'local' ? 'hybrid' : current.mode,
        usageNeedsRefresh: true,
      };
    });
  }, []);
  const usageRequest = useRef(0);
  const refreshUsage = useCallback(
    async (resourceId?: string) => {
      const sequence = ++usageRequest.current;
      const id = workspaceId;
      const result = await workspaceApi.usage();
      if (id !== workspaceId || sequence !== usageRequest.current) return;
      if (
        resourceId &&
        result.nextCursor &&
        !result.data.some((row) => row.resourceId === resourceId)
      ) {
        await refresh();
        return;
      }
      setData((current) => {
        if (current?.workspace.id !== id) return current;
        const visible = new Set(current.resources.map((resource) => resource.id));
        const rows = new Map(
          current.usage
            .filter((row) => visible.has(row.resourceId))
            .map((row) => [row.resourceId, row]),
        );
        for (const row of result.data)
          if (visible.has(row.resourceId)) rows.set(row.resourceId, row);
        return { ...current, usage: [...rows.values()], usageNeedsRefresh: false };
      });
    },
    [refresh],
  );
  const defaultFileSystem = useDefaultFileSystem(
    data,
    refresh,
    sso.sessionKind === 'guest' || sso.sessionKind === 'account',
    acceptResource,
  );
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
      knownFileSystem ||
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
  }, [knownFileSystem, lookupKey, selectedResourceId, resolvedResourceKey, resourceLookupFailure]);
  const { prepareNewGuest } = defaultFileSystem;
  const startGuest = useCallback(async () => {
    setGuestLoading(true);
    setGuestError('');
    try {
      const guest = await workspaceApi.startGuestSession();
      workspaceApi.selectWorkspace(guest.workspaceId);
      const workspaceLoaded = refresh();
      if (guest.initialFileSystemRegion) {
        void prepareNewGuest(guest.workspaceId, guest.initialFileSystemRegion, workspaceLoaded);
      }
      if (guest.initialFileSystemRegion && currentRoute().page === 'overview')
        setFreshGuestOverview(guest.workspaceId);
      setSso((current) => ({ ...current, sessionKind: 'guest' }));
      await workspaceLoaded;
      setError('');
    } catch {
      setGuestError('Unable to start a temporary workspace. Please try again.');
    } finally {
      setGuestLoading(false);
    }
  }, [prepareNewGuest, refresh]);
  const start = useCallback(async () => {
    let guestAvailable = false;
    try {
      setError('');
      setNeedsSignIn(false);
      const auth = await workspaceApi.authConfig();
      setSso(auth);
      // A missing ID on older hosts requires discovery before starting a Guest.
      guestAvailable = Boolean(auth.enabled && auth.guestEnabled && auth.workspaceId == null);
      void startAnalytics(auth).then(() => capturePage('workspace'));
      if (!auth.enabled) {
        const session = await workspaceApi.startSession();
        workspaceApi.selectWorkspace(session.workspaceId);
      } else if (auth.workspaceId === null) {
        throw new WorkspaceApiError('Sign in to your workspace.', 401, 'UNAUTHENTICATED');
      } else if (auth.workspaceId !== undefined) {
        workspaceApi.selectWorkspace(auth.workspaceId);
      } else {
        // Distributed sessions must exchange their ticket. Older bundled hosts also use discovery.
        await workspaceApi.discoverWorkspace();
      }
      guestAvailable = false;
      if (auth.sessionKind === 'account' || auth.loginUrl) restoreUploadAfterSignIn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      const signedOut = e instanceof WorkspaceApiError && e.status === 401;
      setNeedsSignIn(signedOut);
      if (
        signedOut &&
        guestAvailable &&
        guestEntryRequested.current &&
        currentRoute().openForUpload
      ) {
        guestEntryRequested.current = false;
        await startGuest();
      }
    }
  }, [refresh, startGuest]);
  useEffect(() => {
    void start();
    const update = () => {
      if (location.hash === '#monitoring' || location.hash === '#activity')
        history.replaceState(history.state, '', '#overview');
      setFreshGuestOverview(undefined);
      setRouteLocation(currentRoute());
    };
    update();
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
      return true;
    } catch {
      notify('Clipboard unavailable. Use the on-screen alternative.');
      return false;
    }
  }
  async function finishSignOut() {
    try {
      if (await workspaceApi.endDistributedSession()) window.location.reload();
      else if (sso.logoutPath) window.location.href = apiBaseUrl + sso.logoutPath;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Unable to sign out.');
    }
  }
  function requestSignOut() {
    if (sso.sessionKind === 'guest') {
      setGuestSignOutError('');
      setConfirmGuestSignOut(true);
    } else void finishSignOut();
  }
  async function finishGuestSignOut() {
    setGuestSignOutBusy(true);
    setGuestSignOutError('');
    try {
      await workspaceApi.endGuestSession();
      window.location.reload();
    } catch {
      setGuestSignOutError('Unable to sign out. Try again or refresh this page.');
      setGuestSignOutBusy(false);
    }
  }
  const shared = {
    data: visibleData!,
    refresh,
    refreshUsage,
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
          if (routeLocation.openForUpload) rememberUploadSignIn();
          window.location.href = sso.loginUrl || apiBaseUrl + sso.loginPath;
        }}
      >
        {sso.label || 'Continue with TiDB Account'}
      </Button>
    ) : null;
  if (!data) {
    const showSignIn = error && sso.enabled && needsSignIn;
    return (
      <main className={showSignIn ? 'loading-screen sign-in-screen' : 'loading-screen'}>
        <div className="sign-in-brand">
          <span className="brand-mark">TiDB</span>{' '}
          <Text span fw={600}>
            Agent Workspace
          </Text>
        </div>
        {showSignIn && routeLocation.openForUpload ? (
          <>
            <Heading level={1}>
              {guestLoading
                ? 'Opening your files…'
                : routeLocation.openReportFiles
                  ? 'Open report files'
                  : 'Open Workspace Files'}
            </Heading>
            {guestLoading ? (
              <Loader aria-label="Opening your workspace" />
            ) : (
              <>
                <Text component="p">
                  {sso.guestEnabled
                    ? 'Open a temporary workspace to continue with your files for 24 hours.'
                    : 'Sign in to continue with your files.'}
                </Text>
                {guestError && <Text role="alert">{guestError}</Text>}
                {sso.guestEnabled && (
                  <Button variant="filled" onClick={() => void startGuest()}>
                    Open temporary workspace
                  </Button>
                )}
                {ssoButton}
              </>
            )}
          </>
        ) : showSignIn ? (
          <>
            <Heading level={1}>How would you like to work?</Heading>
            {sso.loginPath && (
              <SignInChoices
                label={sso.label || 'Continue with TiDB Account'}
                guestEnabled={sso.guestEnabled === true}
                guestLoading={guestLoading}
                guestError={guestError}
                onGuestLogin={() => void startGuest()}
                onTiDBLogin={() => {
                  window.location.href = sso.loginUrl || apiBaseUrl + sso.loginPath;
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
      </main>
    );
  }
  return (
    <TutorialProgressProvider
      key={data.workspace.id}
      workspaceId={data.workspace.id}
      resourceIds={visibleData!.resources.map((resource) => resource.id)}
    >
      <WorkspaceLayout
        isHostedSession={sso.sessionKind === 'account' || sso.sessionKind === 'guest'}
        liveFiles={visibleData!.resources.some((r) => r.provider === 'drive9-anonymous')}
        liveDatabases={visibleData!.resources.some((r) =>
          ['tidb-cloud-zero', 'db9-anonymous'].includes(r.provider || ''),
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
          {route === 'overview' && (
            <Overview
              {...shared}
              freshGuest={freshGuestOverview === data.workspace.id}
              defaultFileSystem={defaultFileSystem}
              showSalesExample={routeLocation.showSalesExample === true}
              sampleKey={sampleKey?.workspaceId === data.workspace.id ? sampleKey : undefined}
              isAuthorizing={modal === 'key' && Boolean(keyPreset)}
              onAuthorize={(resource, prompt) => {
                setKeyPreset(resource);
                setSalesPrompt(prompt);
                setModal('key');
              }}
            />
          )}
          {(route === 'databases' || route === 'files') &&
          lookupKey &&
          !selectedLoaded &&
          resolvedResourceKey !== lookupKey &&
          resourceLookupFailure !== lookupKey ? (
            <Text role="status">Loading resource…</Text>
          ) : (
            <>
              {route === 'databases' && <Databases {...shared} routeLocation={routeLocation} />}
              {route === 'files' && (
                <Files
                  key={routeLocation.fileLink || 'files'}
                  {...shared}
                  setup={defaultFileSystem}
                  openForUpload={routeLocation.openForUpload}
                  openReportFiles={routeLocation.openReportFiles}
                />
              )}
            </>
          )}
          {route === 'connect' && <Connect {...shared} onNewKey={() => setModal('key')} />}
          {route === 'tutorials' && (
            <>
              <PageHeading
                title="Tutorials"
                description="Explore a guided example with your agent or on your own."
              />
              <DataTutorials
                key={data.workspace.id}
                data={visibleData!}
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
          {route === 'billing' && <Billing {...shared} />}
          {route === 'settings' && (
            <WorkspaceSettings {...shared} sso={sso} onSignOut={requestSignOut} />
          )}
        </div>
      </WorkspaceLayout>
      {confirmGuestSignOut && (
        <Modal
          title="Leave this temporary workspace?"
          size={480}
          busy={guestSignOutBusy}
          onClose={() => setConfirmGuestSignOut(false)}
        >
          <Text>
            Signing out ends this temporary session and requests deletion of its resources. You
            won’t be able to reopen this session in this browser. Save anything you need first.
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
          applyCreatedResource={acceptResource}
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
      {modal === 'key' && (
        <CreateKey
          {...shared}
          preset={keyPreset}
          salesPrompt={salesPrompt}
          onCreated={
            keyPreset
              ? (key) => {
                  setSampleKey({
                    workspaceId: data.workspace.id,
                    resourceId: keyPreset.id,
                    suitable: permitsSalesTask(key, keyPreset.id),
                    pending: key.regionalStatus === 'pending',
                  });
                }
              : undefined
          }
          onContinue={(launchPrepared) => {
            setModal(null);
            if (keyPreset && launchPrepared)
              setSampleKey((current) => (current ? { ...current, launchPrepared: true } : current));
            if (!keyPreset) location.hash = 'connect';
            setKeyPreset(undefined);
            setSalesPrompt(undefined);
          }}
          onClose={() => {
            setModal(null);
            setKeyPreset(undefined);
            setSalesPrompt(undefined);
          }}
        />
      )}
      {modal === 'search' && (
        <SearchModal data={visibleData!} onClose={() => setModal(null)} onConnect={setConnection} />
      )}
      {connection && (
        <Connection resource={connection} copy={copy} onClose={() => setConnection(null)} />
      )}
    </TutorialProgressProvider>
  );
}
type Shared = {
  refreshUsage: (resourceId?: string) => Promise<void>;
  data: PortalData;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  copy: (s: string) => Promise<boolean>;
  onCreate: (target?: ResourceCreationTarget) => void;
  onConnect: (r: Resource) => void;
  isGuest: boolean;
  loadMoreResources: () => Promise<void>;
  resourcePageBusy: boolean;
  resourcePageError: string;
};
type FileSetup = Pick<ReturnType<typeof useDefaultFileSystem>, 'preparing' | 'error' | 'retry'>;

function FileSetupStatus({ setup }: { setup: FileSetup }) {
  if (setup.preparing) return <Text role="status">Preparing your workspace…</Text>;
  if (!setup.error) return null;
  return (
    <Alert color="yellow" title="Your files are not ready">
      We couldn’t finish preparing your workspace. Try again to check its status.
      <Group mt="sm">
        <Button onClick={() => void setup.retry()}>Try again</Button>
      </Group>
    </Alert>
  );
}
function Overview({
  data,
  onCreate,
  isGuest,
  refresh,
  copy,
  onAuthorize,
  sampleKey,
  isAuthorizing,
  defaultFileSystem,
  freshGuest,
  showSalesExample,
}: Shared & {
  onAuthorize: (resource: Resource, prompt?: string) => void;
  sampleKey?: { resourceId: string; suitable: boolean; pending: boolean; launchPrepared?: boolean };
  isAuthorizing: boolean;
  showSalesExample: boolean;
  freshGuest: boolean;
  defaultFileSystem: FileSetup;
}) {
  const hasResources =
    data.resources.length > 0 || Boolean(data.resourceNextCursor || data.resourceWindowTruncated);
  const resources = [...data.resources].sort(
    (a, b) => Number(b.kind === 'filesystem') - Number(a.kind === 'filesystem'),
  );
  return (
    <>
      <PageHeading
        eyebrow="YOUR WORKSPACE"
        title={hasResources && !isGuest ? data.workspace.name : 'Work with your data, your way'}
        description={
          hasResources && !isGuest
            ? 'Your files, data, and agents. All in one place.'
            : 'Connect an agent to work with your files and data, or explore them yourself.'
        }
        actions={
          hasResources && !isGuest ? (
            <Group>
              <Button component="a" href="#connect" variant="default">
                Connect an agent
              </Button>
              <Button variant="filled" leftSection={<Plus size={18} />} onClick={() => onCreate()}>
                Create resource
              </Button>
            </Group>
          ) : undefined
        }
      />
      {isGuest && <GuestExpiryNotice />}
      <FileSetupStatus setup={defaultFileSystem} />
      {
        <SalesSampleJourney
          key={showSalesExample ? 'sales-example' : 'overview'}
          data={data}
          refresh={refresh}
          copy={copy}
          onAuthorize={onAuthorize}
          sampleKey={sampleKey}
          isAuthorizing={isAuthorizing}
          preparingWorkspace={defaultFileSystem.preparing || defaultFileSystem.error}
          freshGuest={freshGuest}
          showCompleted={showSalesExample}
        />
      }
      {!hasResources && !isGuest && !defaultFileSystem.preparing && !defaultFileSystem.error && (
        <WorkspaceFirstSteps onCreate={onCreate} showDatabase showFileSystem isGuest={isGuest} />
      )}
      {hasResources && (
        <section aria-label="Your resources" className="overview-resources">
          <Group justify="space-between" mb="md">
            <Heading level={2}>
              Your resources{' '}
              <span className="overview-count">
                {resources.length}
                {data.resourceNextCursor || data.resourceWindowTruncated ? '+' : ''}
              </span>
            </Heading>
          </Group>
          {!resources.length && <Text>Open a collection to find your resources.</Text>}
          {!!resources.length && (
            <Paper withBorder className="overview-resource-list">
              {resources.slice(0, 6).map((resource) => (
                <div className="overview-resource-row" key={resource.id}>
                  <KindIcon small kind={resource.kind} />
                  <div className="overview-resource-identity">
                    <Anchor href={resourceWorkspaceHref(resource)} fw={600}>
                      {resource.name}
                    </Anchor>
                    <Text size="sm" c="carbon.7">
                      {kindLabel[resource.kind]} · {resourceServiceLabel(resource)}
                    </Text>
                    {resource.connectionError && (
                      <Text size="sm" c="red">
                        {resource.connectionError}
                      </Text>
                    )}
                  </div>
                  <Badge
                    color={
                      resource.connectionError || resource.status !== 'active' ? 'yellow' : 'green'
                    }
                  >
                    {resource.status !== 'active'
                      ? resource.status
                      : resource.connectionError
                        ? 'Connection unavailable'
                        : 'Ready'}
                  </Badge>
                </div>
              ))}
            </Paper>
          )}
          {(resources.length > 6 || data.resourceNextCursor || data.resourceWindowTruncated) && (
            <Group mt="sm">
              <Text size="sm" c="carbon.7">
                {resources.length > 6
                  ? `Showing 6 of ${resources.length} loaded resources.`
                  : 'More resources may be available.'}
              </Text>
              <Button component="a" href="#files" variant="subtle">
                All file systems
              </Button>
              <Button component="a" href="#databases" variant="subtle">
                All databases
              </Button>
            </Group>
          )}
        </section>
      )}
      {hasResources && !freshGuest && <TutorialResume data={data} />}
    </>
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
        key={database.id}
        workspaceId={data.workspace.id}
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
function Files({
  openForUpload,
  openReportFiles,
  setup,
  ...shared
}: Shared & { openForUpload?: boolean; openReportFiles?: boolean; setup: FileSetup }) {
  const context = parseFileSystemLocation(location.hash);
  const systems = shared.data.resources.filter((resource) => resource.kind === 'filesystem');
  const target =
    openForUpload &&
    (systems.find((system) => system.isDefault) ??
      (systems.length === 1 &&
      !shared.data.resourceNextCursor &&
      !shared.data.resourceWindowTruncated
        ? systems[0]
        : undefined));
  const targetId =
    target && target.status === 'active' && !target.connectionError ? target.id : undefined;
  useEffect(() => {
    if (targetId && !openReportFiles) location.replace(fileSystemHash(targetId));
  }, [targetId, openReportFiles]);
  if (
    !context &&
    (setup.preparing ||
      (openForUpload &&
        setup.error &&
        !systems.some((system) => system.status === 'active' && !system.connectionError)))
  )
    return <FileSetupStatus setup={setup} />;
  if (openReportFiles)
    return (
      <ReportFilesEntry
        data={shared.data}
        refresh={shared.refresh}
        onCreate={() => shared.onCreate('filesystem')}
      />
    );
  if (targetId) return <Text role="status">Opening your files…</Text>;
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
  refreshUsage,
  refresh,
  notify,
  onConnect,
  onCreate,
  isGuest,
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
  const [previewImage, setPreviewImage] = useState<{ mimeType: string; base64: string } | null>(
    null,
  );
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
  async function refreshFiles() {
    listing.refresh();
    if (!remote) await refreshUsage(system);
  }
  const fileUpload = useFileUpload({
    resource: selectedSystem,
    directory: path,
    files,
    onBusyChange: setBusy,
    onSaved: refreshFiles,
  });
  const openFile = useCallback(
    async (file: WorkspaceFile, view: FileView = 'preview', savedText?: string) => {
      if (savedText !== undefined) file = { ...file, content: savedText };
      setPreviewView(view);
      history.replaceState(null, '', fileHash(file.resourceId, file.path, view));
      previewRequest.current?.abort();
      const controller = new AbortController();
      previewRequest.current = controller;
      setEditing(file);
      setContent(file.content || '');
      setError('');
      setUnavailableReason('');
      setPreviewImage(null);
      const needsPreview = savedText === undefined && (remote || file.content === undefined);
      setPreviewLoading(needsPreview);
      if (!needsPreview) return;
      try {
        const result = await workspaceApi.previewFile(file, controller.signal);
        if (controller.signal.aborted) return;
        setEditing({ ...file, content: result.content, size: result.size });
        setContent(result.content || '');
        setUnavailableReason(result.image ? '' : result.unavailableReason || '');
        setPreviewImage(result.image || null);
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
      const { data: saved } = await workspaceApi.saveFile({
        resourceId,
        path: target,
        type,
        content: text,
      });
      setNewItem(null);
      setName('');
      notify(type === 'directory' ? 'Folder created' : 'File saved');
      if (saved) listing.acceptSaved(saved);
      else listing.refresh();
      if (!remote)
        void refreshUsage(system).catch(() =>
          notify('Saved. Refresh the file list to see the update; do not repeat the save.'),
        );
      return (
        saved ?? {
          id: `${resourceId}:${target}`,
          resourceId,
          path: target,
          type,
          content: text,
          size: new TextEncoder().encode(text).length,
          updatedAt: null,
        }
      );
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message);
      return null;
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
      void refreshFiles().catch(() => notify('Item deleted. Refresh to update usage.'));
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
              if (selectedSystem?.connectionError) void refresh();
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
          onRefresh={() => void refreshFiles().catch(() => notify('Could not update usage.'))}
          refreshing={listing.loading || analysisBusy}
          canCreate={!!system && !busy && !analysisBusy}
          onCreate={(type) =>
            requestPreviewChange(() => {
              if (dirty) setContent(editing?.content || '');
              setNewItem(type);
              setName('');
              setError('');
            })
          }
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
              title={search ? 'No matching files' : 'No files yet'}
              description={
                search
                  ? 'Try another file name.'
                  : 'Create a file or upload some context to get started.'
              }
              action={
                !search && path === '/' ? (
                  <Button
                    variant="filled"
                    disabled={busy || analysisBusy}
                    onClick={() =>
                      requestPreviewChange(() => {
                        location.hash = tutorialHash(system);
                      })
                    }
                  >
                    Try sample data
                  </Button>
                ) : undefined
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
              databaseCreation={{ data, refresh, notify, isGuest }}
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
              image={previewImage}
              busy={busy}
              error={error}
              pendingChange={!!pendingAction}
              trigger={previewTrigger}
              onChange={setContent}
              onAnalysisRunningChange={setAnalysisBusy}
              onExportSaved={async () => {
                listing.refresh();
                if (
                  data.resources.some(
                    (item) => item.kind === 'filesystem' && item.provider !== 'drive9-anonymous',
                  ) ||
                  data.resourceNextCursor ||
                  data.resourceWindowTruncated
                )
                  await refreshUsage();
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
              description="Choose a file to preview, edit or analyze its contents."
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
          busy={busy}
          onClose={() => {
            setNewItem(null);
            setName('');
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              if (!name.trim() || name.includes('/') || name === '.' || name === '..') {
                setError('Enter a name without slashes or path segments.');
                return;
              }
              const target = (path === '/' ? '' : path) + '/' + name.trim();
              if (files.some((f) => f.path === target)) {
                setError('An item with this name already exists.');
                return;
              }
              const type = newItem;
              void saveFile(target, type).then((saved) => {
                if (saved && type === 'file') void openFile(saved, 'source', '');
              });
            }}
          >
            <TextInput
              label="Name"
              autoFocus
              required
              maxLength={100}
              placeholder={newItem === 'file' ? 'context.md' : 'research'}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
            {error && (
              <Alert className="inline-error" color="red">
                {error}
              </Alert>
            )}
            <div className="modal-actions">
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setNewItem(null);
                  setName('');
                }}
              >
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
  return <ApiDocumentation data={data} copy={copy} connect onNewKey={onNewKey} />;
}
function Keys({ data, refresh, notify, onNewKey }: Shared & { onNewKey: () => void }) {
  const [revoke, setRevoke] = useState<ApiKey | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [keyWindow, setKeyWindow] = useState<{
    keys: ApiKey[];
    next: string | null;
    earlier: boolean;
  }>({
    keys: [],
    next: data.keysNextCursor ?? null,
    earlier: false,
  });
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setPageBusy(true);
    setPageError('');
    void workspaceApi
      .keysPage()
      .then((page) => {
        if (active) {
          setPageError('');
          setKeyWindow({ keys: page.data, next: page.nextCursor, earlier: false });
          setKeysLoaded(true);
        }
      })
      .catch((cause) => {
        if (active) setPageError(cause instanceof Error ? cause.message : 'Unable to load keys.');
      })
      .finally(() => {
        if (active) setPageBusy(false);
      });
    return () => {
      active = false;
    };
  }, [data.keys, data.keysNextCursor, loadAttempt]);
  async function retryPolicy(id: string) {
    setBusy(true);
    setPageError('');
    try {
      const result = await workspaceApi.retryKeyPolicy(id);
      await refresh();
      notify(
        result.data.regionalStatus === 'applied'
          ? 'Region policy applied.'
          : 'Region delivery is still pending.',
      );
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : 'Unable to deliver policy.');
    } finally {
      setBusy(false);
    }
  }
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
      const result = await workspaceApi.revokeKey(revoke.id);
      await refresh();
      setRevoke(null);
      notify(
        result.regionalStatus === 'applied'
          ? 'Key revoked. Access in this region has been updated.'
          : 'Key revoked. Access in this region is still being updated.',
      );
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
          keysLoaded && (keyWindow.keys.length || keyWindow.next || keyWindow.earlier) ? (
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
          Create an API key to give an agent or application scoped access to your workspace.
          Provider credentials stay private.
        </span>
      </Alert>
      <div className="section-title">
        <Heading level={2}>
          Workspace keys{' '}
          {keysLoaded && (
            <span>
              {active.length}
              {keyWindow.next || keyWindow.earlier ? '+' : ''} active
            </span>
          )}
        </Heading>
        <Badge>Workspace scoped</Badge>
      </div>
      <Paper className="panel table-panel" withBorder>
        {!keysLoaded && pageError ? (
          <Empty
            icon={KeyRound}
            title="Unable to load API keys"
            description="Please try again. If the problem continues, contact support."
            action={
              <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</Button>
            }
          />
        ) : !keysLoaded ? (
          <Group justify="center" my="xl">
            <Loader aria-label="Loading API keys" />
          </Group>
        ) : keyWindow.keys.length ? (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name & key</Table.Th>
                <Table.Th>Resource access</Table.Th>
                <Table.Th>Permissions</Table.Th>
                <Table.Th>Created</Table.Th>
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
                  <Table.Td>{relative(k.createdAt)}</Table.Td>
                  <Table.Td>{new Date(k.expiresAt).toLocaleDateString()}</Table.Td>
                  <Table.Td>
                    <Badge color="carbon">
                      {k.revokedAt
                        ? k.regionalStatus === 'pending'
                          ? 'Revocation pending'
                          : 'Revoked'
                        : Date.parse(k.expiresAt) <= Date.now()
                          ? 'Expired'
                          : k.regionalStatus === 'pending'
                            ? 'Delivery pending'
                            : 'Active'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {k.regionalStatus === 'pending' && (
                      <Button disabled={busy} onClick={() => void retryPolicy(k.id)}>
                        Retry delivery
                      </Button>
                    )}
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
        {keysLoaded && pageError && <Alert color="red">{pageError}</Alert>}
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
          description="After revocation, this key cannot request new access. Existing access ends when the region receives the update; this may take longer if the region is offline."
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
  return <ApiDocumentation data={data} copy={copy} />;
}

function Billing({ data, refreshUsage }: Shared) {
  const [usageError, setUsageError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!data.usageNeedsRefresh) return;
    let active = true;
    void refreshUsage().catch(() => {
      if (active) setUsageError(true);
    });
    return () => {
      active = false;
    };
  }, [data.usageNeedsRefresh, refreshUsage, retry]);
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
            Billing is not connected. Service trial limits apply; cloud usage and charges are not
            measured here.
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
      </div>
      {data.usageNeedsRefresh &&
        (usageError ? (
          <Alert color="red">
            Could not load resource allowances.{' '}
            <Button
              onClick={() => {
                setUsageError(false);
                setRetry(retry + 1);
              }}
            >
              Retry
            </Button>
          </Alert>
        ) : (
          <Text role="status">Loading resource allowances…</Text>
        ))}
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
                    ? 'Temporary session'
                    : sso.enabled
                      ? 'TiDB Account session'
                      : 'Local session'}
                </strong>
                <Text component="p">
                  {sso.sessionKind === 'guest'
                    ? 'Your temporary workspace expires 24 hours after it was created.'
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
  isGuest,
  refresh,
  notify,
  copy,
  onClose,
  loadMoreResources,
  resourcePageBusy,
  resourcePageError,
  preset,
  onCreated,
  onContinue,
  salesPrompt,
}: Shared & {
  onClose: () => void;
  onContinue: (launchPrepared: boolean) => void;
  salesPrompt?: string;
  preset?: Resource;
  onCreated?: (key: ApiKey) => void;
}) {
  const [name, setName] = useState(preset ? 'sales-agent' : ''),
    [scopes, setScopes] = useState<CreateKeyInput['scopes']>(
      preset
        ? ['resources:read', 'files:read', 'files:analyze', 'files:write']
        : ['resources:read'],
    ),
    [resourceIds, setResourceIds] = useState(preset ? [preset.id] : []),
    [expires, setExpires] = useState<CreateKeyInput['expiresInDays']>(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [secret, setSecret] = useState('');
  const [scopeNotice, setScopeNotice] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [launchPrepared, setLaunchPrepared] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKey>();
  const [closeIntent, setCloseIntent] = useState<'close' | 'continue' | null>(null);
  const availableResources =
    preset && !data.resources.some((resource) => resource.id === preset.id)
      ? [...data.resources, preset]
      : data.resources;
  const visibleResourceIds = new Set(availableResources.map((resource) => resource.id));
  const hiddenSelections = resourceIds.filter((id) => id !== '*' && !visibleResourceIds.has(id));
  const activeScopes = retainApplicablePermissions(scopes, resourceIds, availableResources);
  const excludedScopes = scopes.filter((scope) => !activeScopes.includes(scope));
  function changeResourceIds(ids: string[]) {
    setResourceIds(ids);
    const retained = retainApplicablePermissions(activeScopes, ids, availableResources);
    const removed = scopes.filter((scope) => !retained.includes(scope));
    setScopes(retained);
    setScopeNotice(
      removed.length ? `Removed permissions that no longer apply: ${removed.join(', ')}.` : '',
    );
  }
  function finish(intent: 'close' | 'continue') {
    if (secret && !keyCopied) {
      setCloseIntent(intent);
      return;
    }
    if (intent === 'continue') onContinue(launchPrepared);
    else onClose();
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await workspaceApi.createKey({
        name,
        scopes: activeScopes,
        resourceIds,
        expiresInDays: isGuest ? 1 : expires,
      });
      setSecret(result.secret);
      setCreatedKey(result.data);
      onCreated?.(result.data);
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
          ? 'This is the only time the full key is shown.'
          : preset
            ? undefined
            : 'Give one workflow exactly the access it needs.'
      }
      onClose={() => finish('close')}
    >
      {secret ? (
        <>
          <div hidden={Boolean(closeIntent)}>
            <KeyReady
              secret={secret}
              copy={copy}
              onCopied={() => setKeyCopied(true)}
              onDownload={() => download('workspace-key.txt', secret)}
              onContinue={() => finish('continue')}
              hidden={Boolean(closeIntent)}
              insufficientAccess={Boolean(
                preset && createdKey && !permitsSalesTask(createdKey, preset.id),
              )}
              accessPending={createdKey?.regionalStatus === 'pending'}
              salesPrompt={salesPrompt}
              onLaunchCopied={setLaunchPrepared}
            />
          </div>
          {closeIntent && (
            <>
              <Alert color="yellow" role="alert">
                You haven’t copied the key using the button. Make sure you saved it before leaving;
                the full key cannot be shown again.
              </Alert>
              <div className="modal-actions">
                <Button autoFocus onClick={() => setCloseIntent(null)}>
                  Go back
                </Button>
                <Button
                  variant="filled"
                  onClick={() =>
                    closeIntent === 'continue' ? onContinue(launchPrepared) : onClose()
                  }
                >
                  {closeIntent === 'continue'
                    ? 'Continue without copying'
                    : 'Close without copying'}
                </Button>
              </div>
            </>
          )}
        </>
      ) : (
        <form className="key-create-form" onSubmit={create}>
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
            resources={availableResources}
            resourceIds={resourceIds}
            onChange={changeResourceIds}
          />
          {hiddenSelections.length > 0 && (
            <Group mt="sm">
              <Text size="sm">
                {hiddenSelections.length} selected{' '}
                {hiddenSelections.length === 1 ? 'resource is' : 'resources are'} outside the loaded
                window.
              </Text>
              <Button
                type="button"
                onClick={() =>
                  changeResourceIds(resourceIds.filter((id) => visibleResourceIds.has(id)))
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
          <KeyPermissions
            resources={availableResources}
            resourceIds={resourceIds}
            scopes={activeScopes}
            notice={
              excludedScopes.length
                ? `Permissions that no longer apply will not be granted: ${excludedScopes.join(', ')}.`
                : scopeNotice
            }
            onChange={(next) => {
              setScopes(next);
              setScopeNotice('');
            }}
          />
          {isGuest ? (
            <Text component="p">
              Expires with your temporary workspace (within 24 hours), or on sign-out.
            </Text>
          ) : (
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
          )}
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
              disabled={busy || !activeScopes.length || !resourceIds.length}
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
    '  -H "Authorization: Bearer $REGION_ACCESS_TOKEN"',
    ...(isFileSystem ? [] : ["  -H 'Content-Type: application/json'", `  -d '${payload}'`]),
  ].join(' \\' + '\n');
  const javascript = [
    'const response = await fetch(',
    `  "${endpoint}",`,
    '  {',
    `    method: "${isFileSystem ? 'GET' : 'POST'}",`,
    '    headers: {',
    '      Authorization: `Bearer ${process.env.REGION_ACCESS_TOKEN}`,',
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
    '        "Authorization": "Bearer " + os.environ["REGION_ACCESS_TOKEN"],',
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
      description={`${kindLabel[r.kind]} · Scoped API access`}
      onClose={onClose}
    >
      <Alert className="notice" color="peacock" icon={<KeyRound size={17} />}>
        <span>
          Exchange a Workspace Key with access to <strong>{r.name}</strong> and{' '}
          <code>{isFileSystem ? 'files:read' : 'queries:execute'}</code>. The same key can access
          your other permitted resources. Send the returned Region Token as{' '}
          <code>REGION_ACCESS_TOKEN</code>. See the{' '}
          <a href="#api" onClick={onClose}>
            API documentation
          </a>{' '}
          for Token exchange examples.
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
                ? 'SQL runs on a PostgreSQL-compatible database through the Workspace API. Use queries:execute and this resource grant; native credentials stay inside the service. PostgreSQL compatibility has limits.'
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
