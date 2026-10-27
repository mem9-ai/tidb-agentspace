import './features/files/file-preview.css';
import { regionLabel as region } from './features/resources/regions';
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
} from '@tidbcloud/uikit';
import { WorkspaceModal as Modal } from './ui/WorkspaceModal';
import { CodeExample as Code } from './ui/CodeExample';
import { ChoiceTabs } from './ui/ChoiceTabs';
import { Heading } from './ui/WorkspaceHeading';
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  IconActivity as Activity,
  IconDownload01 as ArrowDownToLine,
  IconArrowLeft as ArrowLeft,
  IconArrowRight as ArrowRight,
  IconArrowUpRight as ArrowUpRight,
  IconCheck as Check,
  IconCheckCircle as CheckCircle2,
  IconChevronRight as ChevronRight,
  IconHelpCircle as CircleHelp,
  IconCode02 as Code2,
  IconCommand as Command,
  IconCopy03 as Copy,
  IconCreditCard01 as CreditCard,
  IconDatabase01 as Database,
  IconFileCode01 as FileCode2,
  IconFile01 as FileText,
  IconFolder as Folder,
  IconFolderPlus as FolderPlus,
  IconKey01 as KeyRound,
  IconLayoutGrid01 as LayoutDashboard,
  IconPlay as Play,
  IconPlus as Plus,
  IconRefreshCw01 as RefreshCw,
  IconSearchLg as Search,
  IconSettings01 as Settings,
  IconShieldTick as ShieldCheck,
  IconStars01 as Sparkles,
  IconTerminal as Terminal,
  IconTrash01 as Trash2,
  IconUpload01 as Upload,
  IconGitBranch01 as Workflow,
  IconZap as Zap,
} from '@tidbcloud/uikit/icons';
import type { IconProps } from '@tidbcloud/uikit/icons';
import { ResourceAccessPicker } from './features/keys/ResourceAccessPicker';
import { WorkspaceLayout } from './ui/WorkspaceLayout';
import { databaseEditorHash, parseWorkspaceRoute } from './features/navigation/workspace-route';
import type { Route, WorkspaceRoute } from './features/navigation/workspace-route';

const WorkspaceSqlInput = lazy(() => import('./features/sql/WorkspaceSqlInput'));
const FilePreviewPanel = lazy(() => import('./features/files/FilePreviewPanel'));
type WorkspaceIcon = React.ComponentType<IconProps>;

type Kind = 'mysql' | 'postgresql' | 'filesystem';
type Resource = {
  id: string;
  name: string;
  kind: Kind;
  region: string;
  status: string;
  createdAt: string;
};
type WorkspaceFile = {
  id: string;
  resourceId: string;
  path: string;
  type: 'file' | 'directory';
  content?: string;
  updatedAt: string;
  size?: number;
};
type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  resourceIds: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
type Event = {
  id: string;
  action: string;
  resource: string;
  actor: string;
  at: string;
  outcome: string;
};
type Usage = {
  resourceId: string;
  name: string;
  kind: Kind;
  storageBytes: number;
  storageLimitBytes: number;
  monthlyRU: number;
  monthlyRULimit: number | null;
  fileCount: number;
};
type Data = {
  workspace: { id: string; name: string; description: string; plan: string };
  profile: { name: string; email: string };
  resources: Resource[];
  files: WorkspaceFile[];
  keys: ApiKey[];
  events: Event[];
  usage: Usage[];
  queryCount: number;
  capabilities: Record<
    Kind,
    { regions: string[]; preview: boolean; storageGiB: number; monthlyRU?: number }
  >;
};
type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  mode: 'demo';
  durationMs: number;
};
const routes: Record<Route, { label: string; icon: WorkspaceIcon; group: string }> = {
  overview: { label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  databases: { label: 'Databases', icon: Database, group: 'Workspace' },
  files: { label: 'File System', icon: Folder, group: 'Workspace' },
  connect: { label: 'Connect an agent', icon: Workflow, group: 'Build' },
  keys: { label: 'API keys', icon: KeyRound, group: 'Build' },
  api: { label: 'API explorer', icon: Terminal, group: 'Build' },
  monitoring: { label: 'Monitoring', icon: Activity, group: 'Manage' },
  billing: { label: 'Usage & billing', icon: CreditCard, group: 'Manage' },
  settings: { label: 'Settings', icon: Settings, group: 'Manage' },
};
const kindLabel: Record<Kind, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  filesystem: 'File System',
};
const kindDescription: Record<Kind, string> = {
  mysql: 'Relational memory for your agents.',
  postgresql: 'Your familiar Postgres ecosystem.',
  filesystem: 'Persistent context, across sessions.',
};
const base = '/api/v1/workspaces/ws_agentlab';
const apiOrigin = window.location.origin;
const allScopes = [
  'resources:read',
  'resources:write',
  'files:read',
  'files:write',
  'queries:execute',
  'usage:read',
];
async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Request failed.');
  return data;
}
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
function relative(value: string) {
  const seconds = (Date.now() - Date.parse(value)) / 1000;
  return seconds < 60
    ? 'Just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function KindIcon({ kind, small = false }: { kind: Kind; small?: boolean }) {
  const Icon = kind === 'filesystem' ? Folder : Database;
  return (
    <span className={`kind-icon ${kind} ${small ? 'small' : ''}`}>
      <Icon size={small ? 17 : 22} />
      {kind === 'postgresql' && !small && <span className="pg-pip">P</span>}
    </span>
  );
}

function Empty({
  icon: Icon = Folder,
  title,
  description,
  action,
}: {
  icon?: WorkspaceIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={28} />
      <Heading level={3}>{title}</Heading>
      <Text component="p">{description}</Text>
      {action}
    </div>
  );
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
function WorkspaceIllustration() {
  return (
    <div className="workspace-illustration" aria-hidden="true">
      <svg viewBox="0 0 420 210">
        <defs>
          <pattern id="dots" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r=".7" fill="var(--border-strong)" />
          </pattern>
        </defs>
        <rect width="420" height="210" fill="url(#dots)" />
        <g fill="none" stroke="var(--border-strong)" strokeWidth="1.4">
          <path d="M100 106H179Q193 106 193 92V48H281" />
          <path d="M100 106H281" />
          <path d="M100 106H179Q193 106 193 120V165H281" />
        </g>
        <circle cx="193" cy="106" r="4" fill="var(--accent-text)" />
        <g>
          <rect
            x="36"
            y="75"
            width="64"
            height="64"
            rx="15"
            fill="var(--surface)"
            stroke="var(--border)"
          />
          <path
            d="m68 91 17 10v19l-17 10-17-10v-19Zm0 6-12 7v13l12 7 12-7v-13Z"
            fill="var(--accent-text)"
          />
          <rect
            x="281"
            y="26"
            width="112"
            height="43"
            rx="8"
            fill="var(--surface)"
            stroke="var(--border)"
          />
          <text x="299" y="52" fill="var(--text-secondary)" fontSize="12" fontFamily="monospace">
            {'{ memory }'}
          </text>
          <rect
            x="281"
            y="85"
            width="112"
            height="43"
            rx="8"
            fill="var(--surface)"
            stroke="var(--border)"
          />
          <text x="299" y="111" fill="var(--text-secondary)" fontSize="12" fontFamily="monospace">
            {'[ vectors ]'}
          </text>
          <rect
            x="281"
            y="144"
            width="112"
            height="43"
            rx="8"
            fill="var(--surface)"
            stroke="var(--border)"
          />
          <text x="299" y="170" fill="var(--text-secondary)" fontSize="12" fontFamily="monospace">
            {'/ context'}
          </text>
        </g>
      </svg>
      <div className="illustration-label">
        <span className="live-dot" /> One workspace. Connected by design.
      </div>
    </div>
  );
}

function App() {
  const [data, setData] = useState<Data | null>(null),
    [routeLocation, setRouteLocation] = useState<WorkspaceRoute>(currentRoute),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [modal, setModal] = useState<'resource' | 'key' | 'search' | null>(null),
    [connection, setConnection] = useState<Resource | null>(null);
  const route = routeLocation.page;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3500);
  }
  const refresh = useCallback(async () => {
    setData(await api<Data>(base + '/bootstrap'));
  }, []);
  const start = useCallback(async () => {
    try {
      setError('');
      await api('/api/session', { method: 'POST', body: '{}' });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refresh]);
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
  const shared = {
    data: data!,
    refresh,
    notify,
    copy,
    onCreate: () => setModal('resource'),
    onConnect: (r: Resource) => setConnection(r),
  };
  if (!data)
    return (
      <div className="loading-screen">
        <div className="brand-mark">T</div>
        {error ? (
          <>
            <Heading level={2}>Couldn’t open your workspace</Heading>
            <Text component="p">{error}</Text>
            <Button onClick={start}>Try again</Button>
          </>
        ) : (
          <>
            <Loader size="lg" />
            <Text component="p">Opening your workspace…</Text>
          </>
        )}
      </div>
    );
  return (
    <>
      <WorkspaceLayout
        workspaceName={data.workspace.name}
        profileName={data.profile.name}
        active={route}
        databaseId={routeLocation.databaseId}
        navigation={Object.entries(routes).map(([id, item]) => ({ id, ...item }))}
        onSearch={() => setModal('search')}
      >
        <div key={route}>
          {route === 'overview' && <Overview {...shared} />}
          {route === 'databases' && <Databases {...shared} databaseId={routeLocation.databaseId} />}
          {route === 'files' && <Files {...shared} />}
          {route === 'connect' && <Connect {...shared} />}
          {route === 'keys' && <Keys {...shared} onNewKey={() => setModal('key')} />}
          {route === 'api' && <ApiExplorer {...shared} />}
          {route === 'monitoring' && <Monitoring {...shared} />}
          {route === 'billing' && <Billing {...shared} />}
          {route === 'settings' && <WorkspaceSettings {...shared} />}
        </div>
      </WorkspaceLayout>
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
      {modal === 'resource' && <CreateResource {...shared} onClose={() => setModal(null)} />}
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
  data: Data;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  copy: (s: string) => void;
  onCreate: () => void;
  onConnect: (r: Resource) => void;
};
function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <Heading level={1}>{title}</Heading>
        <Text component="p">{description}</Text>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
function Overview({ data, onCreate, onConnect, copy }: Shared) {
  const [range, setRange] = useState('24h');
  const dbs = data.resources.filter((r) => r.kind !== 'filesystem'),
    fs = data.resources.filter((r) => r.kind === 'filesystem');
  return (
    <>
      <PageHeading
        eyebrow="YOUR WORKSPACE"
        title={data.workspace.name}
        description="Your data, files, and agents. All in one place."
        actions={
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
              onClick={onCreate}
            >
              Create resource
            </Button>
          </>
        }
      />
      <section className="welcome-panel">
        <div className="welcome-copy">
          <Badge color="carbon">
            <Sparkles size={12} /> BUILT FOR DEVELOPERS & AGENTS
          </Badge>
          <Heading level={2}>
            Give your next idea
            <br />a place to grow.
          </Heading>
          <Text component="p">
            SQL for memory. Files for context.
            <br />
            One workspace for everything you build.
          </Text>
          <Button className="text-link" onClick={() => go('connect')} variant="subtle">
            Connect your first agent <ArrowRight size={15} />
          </Button>
        </div>
        <WorkspaceIllustration />
      </section>
      <div className="section-title">
        <Heading level={2}>
          Your resources <span>{data.resources.length}</span>
        </Heading>
        <Button className="text-link subtle" onClick={onCreate} variant="subtle">
          <Plus size={14} /> Add resource
        </Button>
      </div>
      <section className="resource-grid">
        {(['mysql', 'postgresql', 'filesystem'] as Kind[]).map((kind) => {
          const items = data.resources.filter((r) => r.kind === kind),
            r = items[0];
          return (
            <Card className="resource-card" key={kind}>
              <div className="resource-card-top">
                <KindIcon kind={kind} />
                <Badge color="carbon">{kind === 'mysql' ? 'Starter' : 'Preview'}</Badge>
              </div>
              <Heading level={3}>
                {kindLabel[kind]}
                {kind !== 'filesystem' && <span className="resource-type">database</span>}
              </Heading>
              <Text component="p">{kindDescription[kind]}</Text>
              <UnstyledButton
                className="resource-name"
                onClick={() => go(kind === 'filesystem' ? 'files' : 'databases')}
              >
                <span className="live-dot" />
                {r?.name || 'No resource yet'}
                {items.length > 1 && <span className="count">+{items.length - 1}</span>}
                <ChevronRight size={14} />
              </UnstyledButton>
              <div className="resource-card-bottom">
                <span>{r ? region(r.region) : 'Ready when you are'}</span>
                <UnstyledButton onClick={() => (r ? onConnect(r) : onCreate())}>
                  {r ? 'Connect' : 'Create'} <ArrowUpRight size={13} />
                </UnstyledButton>
              </div>
            </Card>
          );
        })}
      </section>
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
            $0<span>.00</span>
            <small>Estimated spend</small>
          </div>
          <div className="spend-rule">
            <ShieldCheck size={15} />
            <span>No payment method connected</span>
          </div>
          <div className="usage-mini">
            <div>
              <span>MySQL request units</span>
              <strong>0 / 50M per instance</strong>
            </div>
            <Progress value={0} aria-label="MySQL request units used" />
            <div>
              <span>File System allowance</span>
              <strong>$5 / month</strong>
            </div>
            <small>Shared across the cloud organization.</small>
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
              apiOrigin +
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
            <Button className="text-link subtle" onClick={() => go('monitoring')} variant="subtle">
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
function Databases({ databaseId, ...shared }: Shared & { databaseId?: string }) {
  const { data, onCreate, onConnect } = shared;
  const databases = data.resources.filter((r) => r.kind !== 'filesystem');
  if (databaseId) {
    const database = databases.find((r) => r.id === databaseId);
    if (!database) {
      return (
        <Empty
          icon={Database}
          title="Database unavailable"
          description="This database is no longer available in your workspace. Choose another database to open its SQL editor."
          action={<Button onClick={() => go('databases')}>Back to databases</Button>}
        />
      );
    }
    return <SqlEditor key={database.id} {...shared} database={database} />;
  }
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE RESOURCES"
        title="Databases"
        description="Persistent memory, structured data, and vectors for your agents."
        actions={
          <Button
            variant="filled"
            leftSection={React.createElement(Plus, { size: 18 })}
            onClick={onCreate}
          >
            Create database
          </Button>
        }
      />
      <Alert className="notice" color="peacock" icon={<Database size={17} />}>
        <span>
          MySQL and PostgreSQL are separate resources. Use one Workspace Key with access to the
          databases and actions your workflow needs.
        </span>
      </Alert>
      {!databases.length ? (
        <Paper className="panel" withBorder>
          <Empty
            icon={Database}
            title="Create your first database"
            description="Add a MySQL or PostgreSQL database, then open its SQL editor to start querying."
            action={
              <Button variant="filled" onClick={onCreate}>
                Create database
              </Button>
            }
          />
        </Paper>
      ) : (
        <Paper className="panel table-panel" withBorder>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Database</Table.Th>
                <Table.Th>Compatibility</Table.Th>
                <Table.Th>Region</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Plan</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {databases.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <div className="table-resource">
                      <KindIcon small kind={r.kind} />
                      <div>
                        <a className="text-link database-name" href={databaseEditorHash(r.id)}>
                          {r.name}
                        </a>
                        <small>{r.id}</small>
                      </div>
                    </div>
                  </Table.Td>
                  <Table.Td>
                    {kindLabel[r.kind]}{' '}
                    {r.kind === 'postgresql' && <Badge color="purple">Preview</Badge>}
                  </Table.Td>
                  <Table.Td>{region(r.region)}</Table.Td>
                  <Table.Td>
                    <span className="status">
                      <span className="live-dot" />
                      Active
                    </span>
                  </Table.Td>
                  <Table.Td>Starter · Free</Table.Td>
                  <Table.Td>
                    <div className="database-actions">
                      <Button
                        leftSection={React.createElement(Code2, { size: 18 })}
                        onClick={() => openDatabaseEditor(r.id)}
                        aria-label={`Open SQL editor for ${r.name}`}
                      >
                        SQL editor
                      </Button>
                      <Button onClick={() => onConnect(r)}>
                        Connect <ArrowUpRight size={13} />
                      </Button>
                    </div>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
      <div className="two-column">
        <Paper className="panel info-panel" withBorder>
          <Code2 size={22} />
          <Heading level={3}>Start with a query</Heading>
          <Text component="p">
            Choose a database above and open its SQL editor. Queries run against that database; the
            demo provider supports two read-only query patterns.
          </Text>
        </Paper>
        <Paper className="panel info-panel" withBorder>
          <Workflow size={22} />
          <Heading level={3}>Built for your existing tools</Heading>
          <Text component="p">
            Use a single Workspace Key through the API. MySQL and PostgreSQL compatibility is
            handled by the database service; native client connections are a future integration.
          </Text>
          <a
            className="text-link"
            href="https://docs.pingcap.com/tidbcloud/connect-to-tidb-cluster/"
            target="_blank"
            rel="noreferrer"
          >
            Connection documentation <ArrowUpRight size={14} />
          </a>
        </Paper>
      </div>
    </>
  );
}
function SqlEditor({
  data,
  database,
  refresh,
  notify,
  onConnect,
}: Shared & { database: Resource }) {
  const dbs = data.resources.filter((r) => r.kind !== 'filesystem');
  const resourceId = database.id;
  const [sql, setSql] = useState('SELECT * FROM agent_events LIMIT 10;'),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<QueryResult | null>(null),
    [error, setError] = useState('');
  async function run() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setResult(
        await api<QueryResult>(base + '/queries', {
          method: 'POST',
          body: JSON.stringify({ resourceId, sql }),
        }),
      );
      await refresh();
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <a className="text-link database-back" href="#databases">
        <ArrowLeft size={16} /> All databases
      </a>
      <PageHeading
        eyebrow="SQL EDITOR"
        title={database.name}
        description={`${kindLabel[database.kind]} · Starter · ${region(database.region)}`}
        actions={
          <Button onClick={() => onConnect(database)}>
            Connect <ArrowUpRight size={14} />
          </Button>
        }
      />
      <Alert className="notice" color="peacock" icon={<Sparkles size={17} />}>
        <span>
          Local query sandbox. Supports <code>SELECT 1</code> and{' '}
          <code>SELECT * FROM agent_events LIMIT n</code>. Cloud SQL execution is not connected.
        </span>
      </Alert>
      <Paper className="panel sql-panel" withBorder>
        <div className="sql-toolbar">
          <div className="inline-controls">
            <Database size={16} />
            <NativeSelect
              className="sql-database-select"
              aria-label="Database"
              value={resourceId}
              onChange={(e) => openDatabaseEditor(e.target.value)}
            >
              {dbs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {kindLabel[r.kind]}
                </option>
              ))}
            </NativeSelect>
            <Badge>Demo</Badge>
          </div>
          <Button
            variant="filled"
            loading={busy}
            leftSection={<Play size={18} />}
            disabled={busy || !resourceId}
            onClick={run}
          >
            {busy ? 'Running…' : 'Run query'}
          </Button>
        </div>
        <Suspense
          fallback={
            <div className="editor-loading">
              <Loader size="md" />
              <Text>Loading SQL editor…</Text>
            </div>
          }
        >
          <WorkspaceSqlInput
            databaseId={database.id}
            protocol={database.kind}
            value={sql}
            onChange={setSql}
            onRun={() => void run()}
          />
        </Suspense>
        <div className="editor-bottom">
          <span>SQL · {kindLabel[database.kind]}</span>
          <span>⌘ / Ctrl + Enter to run</span>
        </div>
      </Paper>
      <div className="sample-queries">
        <span>Try a sample:</span>
        <UnstyledButton onClick={() => setSql('SELECT 1 AS connected;')}>
          Test connection
        </UnstyledButton>
        <UnstyledButton onClick={() => setSql('SELECT * FROM agent_events LIMIT 10;')}>
          Read agent events
        </UnstyledButton>
      </div>
      <Paper className="panel result-panel" withBorder>
        <div className="panel-header">
          <Heading level={2}>
            Results {result && <Badge color="green">{result.rowCount} rows</Badge>}
          </Heading>
          {result && (
            <Button
              leftSection={React.createElement(ArrowDownToLine, { size: 18 })}
              onClick={() => {
                download(
                  'query-results.json',
                  JSON.stringify(result.rows, null, 2),
                  'application/json',
                );
                notify('Results exported');
              }}
            >
              Export JSON
            </Button>
          )}
        </div>
        {error ? (
          <Alert className="inline-error" color="red">
            {error}
          </Alert>
        ) : result ? (
          <div className="table-scroll">
            <Table>
              <Table.Thead>
                <Table.Tr>
                  {result.columns.map((c: string) => (
                    <Table.Th key={c}>{c}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.rows.map((r: Record<string, unknown>, i: number) => (
                  <Table.Tr key={i}>
                    {result.columns.map((c: string) => (
                      <Table.Td key={c}>
                        <code>{String(r[c])}</code>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <div className="result-footnote">
              <CheckCircle2 size={13} /> Demo query completed. Results are sample data.
            </div>
          </div>
        ) : (
          <Empty
            icon={Terminal}
            title="Ready when you are"
            description="Run a sample query to see its results here."
          />
        )}
      </Paper>
    </>
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
function Files({ data, refresh, notify, onConnect, onCreate }: Shared) {
  const systems = data.resources.filter((r) => r.kind === 'filesystem');
  const [system, setSystem] = useState(systems[0]?.id || ''),
    [path, setPath] = useState('/'),
    [search, setSearch] = useState(''),
    [editing, setEditing] = useState<WorkspaceFile | null>(null),
    [content, setContent] = useState(''),
    [newItem, setNewItem] = useState<'file' | 'directory' | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState<WorkspaceFile | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [previewTrigger, setPreviewTrigger] = useState<HTMLElement | null>(null);
  const dirty = !!editing && content !== (editing.content || '');
  function requestPreviewChange(action: () => void) {
    if (busy) return;
    if (dirty) setPendingAction(() => action);
    else action();
  }
  const upload = useRef<HTMLInputElement>(null);
  const files = data.files.filter((f) => f.resourceId === system);
  const children = files
    .filter(
      (f) =>
        (f.path.slice(0, f.path.lastIndexOf('/')) || '/') === path &&
        f.path.split('/').pop()!.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1,
    );
  async function saveFile(target: string, type: string, text = '', resourceId = system) {
    setBusy(true);
    setError('');
    try {
      await api(base + '/files', {
        method: 'PUT',
        body: JSON.stringify({ resourceId, path: target, type, content: text }),
      });
      await refresh();
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
  async function uploadFile(file: globalThis.File) {
    if (file.size > 256 * 1024) {
      notify('Choose a UTF-8 text file smaller than 256 KiB.');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (text.includes('\0')) throw new Error('binary');
      const target = (path === '/' ? '' : path) + '/' + file.name;
      if (files.some((f) => f.path === target)) {
        notify('A file with this name already exists. Open it to edit.');
        return;
      }
      await saveFile(target, 'file', text);
    } catch {
      notify('This prototype accepts UTF-8 text files only.');
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await api(base + '/files', {
        method: 'DELETE',
        body: JSON.stringify({ resourceId: system, path: deleting.path }),
      });
      await refresh();
      notify('Item deleted');
      if (editing?.id === deleting.id) {
        setEditing(null);
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
      <PageHeading
        eyebrow="PERSISTENT CONTEXT"
        title="File System"
        description="A shared home for your agent’s context, code, and outputs."
        actions={
          <>
            <Button
              leftSection={React.createElement(Terminal, { size: 18 })}
              onClick={() => {
                const r = systems.find((r) => r.id === system);
                if (r) onConnect(r);
              }}
            >
              Connect
            </Button>
            <Button
              variant="filled"
              leftSection={React.createElement(Upload, { size: 18 })}
              onClick={() => upload.current?.click()}
              disabled={busy || !system}
            >
              Upload file
            </Button>
          </>
        }
      />
      <input
        ref={upload}
        type="file"
        hidden
        aria-label="Upload a text file"
        onChange={(e) => {
          if (e.target.files?.[0]) void uploadFile(e.target.files[0]);
          e.target.value = '';
        }}
      />
      <div className="file-system-summary">
        <div className="table-resource">
          <KindIcon kind="filesystem" />
          <div>
            <NativeSelect
              aria-label="File system"
              className="heading-select"
              value={system}
              disabled={busy}
              onChange={(e) => {
                const nextSystem = e.target.value;
                requestPreviewChange(() => {
                  setSystem(nextSystem);
                  setPath('/');
                  setSearch('');
                  setEditing(null);
                });
              }}
            >
              {systems.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
            <small>
              {systems[0] ? region(systems.find((r) => r.id === system)!.region) : 'No file system'}
            </small>
          </div>
          <Badge color="purple">Preview</Badge>
        </div>
        <div className="file-stat">
          <span>{files.filter((f) => f.type === 'file').length} files</span>
          <span>
            {bytes(files.reduce((n, f) => n + new TextEncoder().encode(f.content || '').length, 0))}{' '}
            / 2 GiB
          </span>
          <span>
            <span className="live-dot" />
            Active
          </span>
        </div>
      </div>
      <div className="file-workspace" data-preview={editing ? true : undefined}>
        <Paper className="panel file-browser" withBorder>
          <div className="file-toolbar">
            <div className="path-crumb">
              <ActionIcon aria-label="File system root" onClick={() => setPath('/')}>
                <Folder size={16} />
              </ActionIcon>
              <UnstyledButton onClick={() => setPath('/')}>
                {systems.find((r) => r.id === system)?.name}
              </UnstyledButton>
              {path
                .split('/')
                .filter(Boolean)
                .map((s, i) => (
                  <React.Fragment key={i}>
                    <ChevronRight size={13} />
                    <UnstyledButton
                      onClick={() =>
                        setPath(
                          '/' +
                            path
                              .split('/')
                              .filter(Boolean)
                              .slice(0, i + 1)
                              .join('/'),
                        )
                      }
                    >
                      {s}
                    </UnstyledButton>
                  </React.Fragment>
                ))}
            </div>
            <div className="inline-controls">
              <div className="input-with-icon">
                <Search size={14} />
                <TextInput
                  aria-label="Search files"
                  placeholder="Filter files…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Button
                leftSection={React.createElement(FolderPlus, { size: 18 })}
                disabled={!system || busy}
                onClick={() => {
                  setNewItem('directory');
                  setError('');
                }}
              >
                New folder
              </Button>
              <Button
                leftSection={React.createElement(Plus, { size: 18 })}
                disabled={!system || busy}
                onClick={() => {
                  setNewItem('file');
                  setError('');
                }}
              >
                New file
              </Button>
            </div>
          </div>
          {systems.length ? (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Last modified</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {path !== '/' && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <UnstyledButton
                        className="file-name"
                        onClick={() => setPath(path.slice(0, path.lastIndexOf('/')) || '/')}
                      >
                        <Folder size={17} />
                        ..
                      </UnstyledButton>
                    </Table.Td>
                  </Table.Tr>
                )}
                {children.map((f) => (
                  <Table.Tr key={f.id} data-selected={editing?.id === f.id || undefined}>
                    <Table.Td>
                      <UnstyledButton
                        className="file-name"
                        aria-current={editing?.id === f.id ? 'true' : undefined}
                        onClick={(event) => {
                          if (f.type === 'directory') {
                            setPath(f.path);
                            setSearch('');
                          } else {
                            if (editing?.id === f.id) return;
                            const trigger = event.currentTarget;
                            requestPreviewChange(() => {
                              setPreviewTrigger(trigger);
                              setEditing(f);
                              setContent(f.content || '');
                              setError('');
                            });
                          }
                        }}
                      >
                        {f.type === 'directory' ? (
                          <Folder className="folder-icon" size={19} />
                        ) : f.path.endsWith('.md') ? (
                          <FileText size={18} />
                        ) : (
                          <FileCode2 size={18} />
                        )}
                        <span>
                          <strong>{f.path.split('/').pop()}</strong>
                          <small className="file-cell-meta">
                            {f.type === 'directory'
                              ? 'Folder'
                              : bytes(new TextEncoder().encode(f.content || '').length)}{' '}
                            · {relative(f.updatedAt)}
                          </small>
                        </span>
                      </UnstyledButton>
                    </Table.Td>
                    <Table.Td>
                      {f.type === 'directory'
                        ? '—'
                        : bytes(new TextEncoder().encode(f.content || '').length)}
                    </Table.Td>
                    <Table.Td>{relative(f.updatedAt)}</Table.Td>
                    <Table.Td>
                      <div className="row-actions">
                        {f.type === 'file' && (
                          <ActionIcon
                            className="icon-button"
                            aria-label={`Download ${f.path}`}
                            onClick={() => download(f.path.split('/').pop()!, f.content || '')}
                          >
                            <ArrowDownToLine size={15} />
                          </ActionIcon>
                        )}
                        <ActionIcon
                          className="icon-button"
                          aria-label={`Delete ${f.path}`}
                          disabled={busy}
                          onClick={() => {
                            setDeleting(f);
                            setError('');
                          }}
                        >
                          <Trash2 size={15} />
                        </ActionIcon>
                      </div>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Empty
              title="Add your first file system"
              description="Keep agent context available across sessions."
              action={<Button onClick={onCreate}>Create resource</Button>}
            />
          )}
          {systems.length > 0 && !children.length && (
            <Empty
              title={search ? 'No matching files' : 'An open canvas'}
              description={
                search
                  ? 'Try another file name.'
                  : 'Create a file or upload some context to get started.'
              }
            />
          )}
          <div className="file-browser-footer">
            <span>{children.length} items</span>
            <span>Local persistent storage · UTF-8 text files up to 256 KiB</span>
          </div>
        </Paper>
        {editing && (
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
              content={content}
              dirty={dirty}
              busy={busy}
              error={error}
              pendingChange={!!pendingAction}
              trigger={previewTrigger}
              onChange={setContent}
              onClose={() => requestPreviewChange(() => setEditing(null))}
              onKeepEditing={() => setPendingAction(null)}
              onDiscard={() => {
                const action = pendingAction;
                setPendingAction(null);
                action?.();
              }}
              onDownload={() => download(editing.path.split('/').pop()!, content)}
              onSave={async () => {
                const file = editing;
                const savedContent = content;
                if (await saveFile(file.path, 'file', savedContent, file.resourceId)) {
                  setEditing((current) =>
                    current?.id === file.id ? { ...current, content: savedContent } : current,
                  );
                  setPendingAction(null);
                }
              }}
            />
          </Suspense>
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
          title={`Delete ${deleting.type}?`}
          description={`“${deleting.path}” will be removed from this local workspace. Non-empty folders cannot be deleted.`}
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
              Delete {deleting.type}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Connect({ data, copy }: Shared) {
  const [tab, setTab] = useState('Agent');
  const snippet = `# Discover your workspace resources\ncurl ${apiOrigin}${base}/resources \\\n  -H "Authorization: Bearer $WORKSPACE_API_KEY"`;
  const python = `import os, json, urllib.request\n\nreq = urllib.request.Request(\n    "${apiOrigin}${base}/resources",\n    headers={"Authorization": "Bearer " + os.environ["WORKSPACE_API_KEY"]}\n)\nwith urllib.request.urlopen(req) as response:\n    print(json.load(response))`;
  const js = `const response = await fetch(\n  "${apiOrigin}${base}/resources",\n  { headers: { Authorization: \`Bearer \${process.env.WORKSPACE_API_KEY}\` } }\n);\nconsole.log(await response.json());`;
  const agents = `# TiDB Agent Workspace\n\nWorkspace: ${data.workspace.id}\nAPI: ${apiOrigin}/api/v1\nOpenAPI: ${apiOrigin}/openapi.json\n\nRead WORKSPACE_API_KEY from the environment.\nDiscover resources with GET /workspaces/${data.workspace.id}/resources.\nUse /files for UTF-8 file operations and /queries for demo SQL.\nOnly call endpoints permitted by your key actions and resource access. Use the same key for database queries and files. Do not request upstream provider credentials.\n\nThis is a local demo. Cloud provisioning and native DB connections are simulated.\nDo not upload credentials to the workspace or commit them to Git.\n`;
  return (
    <>
      <PageHeading
        eyebrow="BUILT FOR AGENTS"
        title="One workspace. Every workflow."
        description="Give your coding agent persistent memory and a shared place to work."
      />
      <section className="connect-hero">
        <div className="connect-hero-icon">
          <Workflow size={32} />
        </div>
        <Heading level={2}>
          Your agent brings the intelligence.
          <br />
          Your workspace keeps the context.
        </Heading>
        <Text component="p">
          Discover databases, work with files, and inspect usage through a scoped API.
        </Text>
        <div className="agent-clients">
          <span>
            <Terminal size={16} /> Claude Code
          </span>
          <span>
            <Code2 size={16} /> Codex
          </span>
          <span>
            <Command size={16} /> Cursor
          </span>
          <span>
            <Workflow size={16} /> Your own agent
          </span>
        </div>
      </section>
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
              <Button
                onClick={() => go('keys')}
                leftSection={React.createElement(KeyRound, { size: 18 })}
              >
                Manage API keys <ArrowUpRight size={13} />
              </Button>
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
                <a className="text-link" href="/openapi.json" target="_blank" rel="noreferrer">
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
  const active = data.keys.filter((k) => !k.revokedAt && Date.parse(k.expiresAt) > Date.now());
  async function doRevoke() {
    if (!revoke) return;
    setBusy(true);
    try {
      await api(base + '/keys/' + revoke.id, { method: 'DELETE' });
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
          <Button
            variant="filled"
            leftSection={React.createElement(Plus, { size: 18 })}
            onClick={onNewKey}
          >
            Create API key
          </Button>
        }
      />
      <Alert className="notice" color="peacock" icon={<ShieldCheck size={18} />}>
        <span>
          One Workspace Key can access MySQL, PostgreSQL, and files. Choose its allowed resources
          and actions; provider credentials are managed by the service.
        </span>
      </Alert>
      <div className="section-title">
        <Heading level={2}>
          Workspace keys <span>{active.length} active</span>
        </Heading>
        <Badge>Workspace scoped</Badge>
      </div>
      <Paper className="panel table-panel" withBorder>
        {data.keys.length ? (
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
              {data.keys.map((k) => (
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
      setResult(JSON.stringify(await api(base + endpoint), null, 2));
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
          <Anchor href="/openapi.json" target="_blank" rel="noreferrer" className="schema-link">
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
              value={`curl '${apiOrigin}${base + endpoint}' \\\n  -H "Authorization: Bearer $WORKSPACE_API_KEY"`}
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
                  value: data.resources.length,
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
                      <Table.Td>Local demo</Table.Td>
                      <Table.Td>
                        <span className="status">
                          <span className="live-dot" />
                          Available
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
            This prototype keeps spending at $0. Cloud allowances are tracked separately for each
            service.
          </Text>
        </div>
        <div className="billing-total">
          <span>Estimated charges</span>
          <strong>
            $0.00<small>/ month</small>
          </strong>
          <span>Local demo · No cloud charges generated</span>
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
                    <span>
                      {bytes(u.storageBytes)} <small>/ {u.storageLimitBytes / 1024 ** 3} GiB</small>
                    </span>
                    <Progress
                      value={Math.min((u.storageBytes / u.storageLimitBytes) * 100, 100)}
                      aria-label={`${u.name} storage used`}
                    />
                  </div>
                </Table.Td>
                <Table.Td>
                  {u.monthlyRULimit ? (
                    <>
                      {u.kind === 'postgresql' ? 'Not metered in demo' : '0'}{' '}
                      <small>/ {u.monthlyRULimit / 1000000}M</small>
                    </>
                  ) : (
                    'Read / write / storage / egress'
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge color="carbon">
                    {u.kind === 'mysql' ? 'Starter Free' : 'Free · Preview'}
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
          <Heading level={3}>File System free tier</Heading>
          <Text component="p">
            $5 monthly allowance shared across the cloud organization. Without a credit card: one
            file system per region, 2 GiB storage and 2,000 files per system.
          </Text>
          <Text className="muted" component="p">
            The $5 allowance reduces cloud charges; it is not a universal spend cap. This local demo
            does not meter cloud spend.
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
            MySQL Starter with a $0 spending limit can throttle or reject connections at its quota.
            PostgreSQL Preview can restrict usage at its allowance.
          </Text>
          <Text className="muted" component="p">
            At a File System capacity limit, existing files remain readable and new writes stop.
            Native cloud enforcement must be verified when connecting providers.
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
function WorkspaceSettings({ data, refresh, notify, copy }: Shared) {
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
      await api(base + '/settings', {
        method: 'PATCH',
        body: JSON.stringify({ name, workspaceName, description }),
      });
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
              <Text component="p">Your local developer profile.</Text>
            </div>
            <Badge>Local owner</Badge>
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
              <div>
                <strong>Guest session</strong>
                <Text component="p">
                  Sign-in and account linking are deferred. Your local workspace is saved on this
                  machine.
                </Text>
              </div>
              <Badge color="green">Active</Badge>
            </div>
          </div>
        </Paper>
        {error && (
          <Alert className="inline-error" color="red">
            {error}
          </Alert>
        )}
        <div className="settings-save">
          <Text component="p">Changes apply to this local workspace.</Text>
          <Button variant="filled" loading={busy} disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
      <Alert className="notice quiet" color="peacock" icon={<KeyRound size={17} />}>
        <span>
          For automation, create a scoped API key. The browser’s guest session cannot administer
          real TiDB Cloud accounts.
        </span>
      </Alert>
    </>
  );
}
function CreateResource({ data, refresh, notify, onClose }: Shared & { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('mysql'),
    [name, setName] = useState(''),
    [selectedRegion, setRegion] = useState(data.capabilities.mysql.regions[0]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  function changeKind(k: Kind) {
    setKind(k);
    setRegion(data.capabilities[k].regions[0]);
    setError('');
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(base + '/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ name, kind, region: selectedRegion }),
      });
      await refresh();
      notify('Demo resource created');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const existingFileSystem =
    kind === 'filesystem'
      ? data.resources.find((r) => r.kind === kind && r.region === selectedRegion)
      : undefined;
  const limited = !!existingFileSystem;
  return (
    <Modal
      title="Create a resource"
      description="Add a building block to your agent workspace."
      onClose={onClose}
    >
      <form onSubmit={create}>
        <NativeSelect
          label="Resource type"
          value={kind}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === 'mysql' || next === 'postgresql' || next === 'filesystem')
              changeKind(next);
          }}
          data={[
            { value: 'mysql', label: 'MySQL Starter' },
            { value: 'postgresql', label: 'PostgreSQL Starter' },
            { value: 'filesystem', label: 'File System' },
          ]}
        />
        <TextInput
          label="Resource name"
          description={<>3–40 lowercase letters, numbers, and hyphens.</>}
          required
          pattern="[a-z][a-z0-9-]{2,39}"
          minLength={3}
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'filesystem' ? 'agent-context' : 'agent-memory-dev'}
        />
        <NativeSelect
          label="Region"
          description={
            <>
              {kind === 'postgresql'
                ? 'PostgreSQL Preview is configured for N. Virginia in this prototype.'
                : kind === 'filesystem'
                  ? 'Defaults to AWS Singapore. The free-tier allowance applies per region.'
                  : 'Available regions depend on the resource provider.'}
            </>
          }
          value={selectedRegion}
          onChange={(e) => setRegion(e.target.value)}
        >
          {data.capabilities[kind].regions.map((r) => (
            <option key={r} value={r}>
              {region(r)}
            </option>
          ))}
        </NativeSelect>
        <div className="plan-selection">
          <div>
            <Zap size={17} />
            <strong>Free tier</strong>
            <Badge>{kind === 'mysql' ? 'Starter' : 'Preview'}</Badge>
          </div>
          <Text component="p">
            {data.capabilities[kind].storageGiB} GiB storage
            {kind === 'filesystem'
              ? ' · 2,000 files'
              : ` · ${data.capabilities[kind].monthlyRU! / 1000000}M RU / month`}
          </Text>
          <small>Local simulation. No real cloud resource will be provisioned.</small>
        </div>
        {limited && (
          <Alert className="notice" color="peacock" icon={<CircleHelp size={17} />}>
            <span>
              Your free file system already exists in this region. Use {existingFileSystem?.name} to
              continue.
            </span>
          </Alert>
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
            disabled={busy || limited}
            loading={busy}
            leftSection={<Plus size={18} />}
            type="submit"
          >
            {busy ? 'Creating…' : 'Create resource'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function CreateKey({ data, refresh, notify, copy, onClose }: Shared & { onClose: () => void }) {
  const [name, setName] = useState(''),
    [scopes, setScopes] = useState(['resources:read', 'files:read', 'usage:read']),
    [resourceIds, setResourceIds] = useState(data.resources.map((resource) => resource.id)),
    [expires, setExpires] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [secret, setSecret] = useState('');
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ secret: string }>(base + '/keys', {
        method: 'POST',
        body: JSON.stringify({ name, scopes, resourceIds, expiresInDays: expires }),
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
              Save this in your agent’s environment as WORKSPACE_API_KEY. This demo key only works
              against the local workspace API.
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
                              'resources:write': 'Create demo resources',
                              'files:read': 'Read files and context',
                              'files:write': 'Create, edit, and delete files',
                              'queries:execute': 'Run supported sample SQL',
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
            onChange={(e) => setExpires(Number(e.target.value))}
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
  const endpoint = `${apiOrigin}${base}${isFileSystem ? `/files?resourceId=${r.id}` : '/queries'}`;
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
          label="WORKSPACE API · LOCAL DEMO"
          value={tab === 'REST API' ? shell : tab === 'JavaScript' ? javascript : python}
        />
      </ChoiceTabs>
      <div className="connection-note">
        <ShieldCheck size={18} />
        <Text component="p">
          Provider credentials are handled by the service. This preview uses a local provider;
          native database connections and file mounts are not available yet.
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
            if (isFileSystem) go('files');
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
