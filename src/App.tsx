import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  Copy,
  CreditCard,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ResourceAccessPicker } from './features/keys/ResourceAccessPicker';
import { ThemePicker } from './features/theme/ThemePicker';

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
type Route =
  | 'overview'
  | 'databases'
  | 'sql'
  | 'files'
  | 'connect'
  | 'keys'
  | 'api'
  | 'monitoring'
  | 'billing'
  | 'settings';
const routes: Record<Route, { label: string; icon: LucideIcon; group: string }> = {
  overview: { label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  databases: { label: 'Databases', icon: Database, group: 'Workspace' },
  sql: { label: 'SQL editor', icon: Code2, group: 'Workspace' },
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
function currentRoute(): Route {
  const value = location.hash.slice(1);
  return value in routes ? (value as Route) : 'overview';
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
function region(value: string) {
  return value === 'aws-us-east-1' ? 'AWS · N. Virginia' : 'AWS · Oregon';
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
function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Button({
  children,
  variant = 'secondary',
  icon: Icon,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; icon?: LucideIcon }) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {Icon && <Icon size={15} />} {children}
    </button>
  );
}
function Empty({
  icon: Icon = Folder,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={28} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Code({
  value,
  copy,
  label,
}: {
  value: string;
  copy: (value: string) => void;
  label?: string;
}) {
  return (
    <div className="code-block">
      {label && (
        <div className="code-label">
          <span>{label}</span>
          <button aria-label="Copy code" onClick={() => copy(value)}>
            <Copy size={14} />
          </button>
        </div>
      )}
      <pre>{value}</pre>
      {!label && (
        <button className="code-copy" aria-label="Copy code" onClick={() => copy(value)}>
          <Copy size={15} />
        </button>
      )}
    </div>
  );
}
function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href]') || [],
      ).filter((e) => !e.hasAttribute('disabled'));
    focusable()[0]?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const list = focusable(),
          first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <button className="modal-close icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={19} />
        </button>
        <h2 id="modal-title">{title}</h2>
        {description && <p className="modal-description">{description}</p>}
        {children}
      </div>
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
    [route, setRoute] = useState<Route>(currentRoute),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [modal, setModal] = useState<'resource' | 'key' | 'search' | null>(null),
    [connection, setConnection] = useState<Resource | null>(null),
    [sidebar, setSidebar] = useState(false);
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
      setRoute(currentRoute());
      setSidebar(false);
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
            <h2>Couldn’t open your workspace</h2>
            <p>{error}</p>
            <Button onClick={start}>Try again</Button>
          </>
        ) : (
          <>
            <Loader2 className="spin" />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <a href="#overview" className="brand">
          <span className="brand-mark">
            <svg width="21" height="24" viewBox="0 0 24 28">
              <path
                d="m12 1 11 6.5v13L12 27 1 20.5v-13Zm0 5-7 4v8l7 4 7-4v-8Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <strong>TiDB</strong>
          <span className="brand-divider" />
          <span className="brand-product">Workspace</span>
        </a>
        <button className="workspace-switch" onClick={() => go('settings')}>
          <span className="workspace-avatar">S</span>
          <span>
            <strong>Personal workspace</strong>
            <small>Free plan</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <nav aria-label="Main navigation">
          {['Workspace', 'Build', 'Manage'].map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {Object.entries(routes)
                .filter(([, r]) => r.group === group)
                .map(([key, r]) => (
                  <a
                    key={key}
                    href={`#${key}`}
                    className={`nav-item ${route === key ? 'active' : ''}`}
                    aria-current={route === key ? 'page' : undefined}
                  >
                    <r.icon size={17} />
                    <span>{r.label}</span>
                    {key === 'connect' && <span className="new-dot" />}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="free-plan">
            <div>
              <Zap size={14} />
              <strong>Built to start free</strong>
            </div>
            <p>Your next idea starts here.</p>
            <button onClick={() => go('billing')}>
              View your usage <ArrowUpRight size={13} />
            </button>
          </div>
          <a
            className="nav-item"
            href="https://docs.pingcap.com/tidbcloud/"
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={16} /> Documentation <ExternalLink size={12} />
          </a>
          <button className="profile" onClick={() => go('settings')}>
            <span className="profile-avatar">{data.profile.name.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{data.profile.name}</strong>
              <small>Personal account</small>
            </span>
            <MoreHorizontal size={17} />
          </button>
        </div>
      </aside>
      {sidebar && <div className="sidebar-backdrop" onClick={() => setSidebar(false)} />}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Open navigation"
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span className="breadcrumb-icon">
              <Workflow size={15} />
            </span>
            <span>{data.workspace.name}</span>
            <ChevronRight size={13} />
            <strong>{routes[route].label}</strong>
          </div>
          <div className="topbar-right">
            <ThemePicker />
            <button
              className="search-button"
              aria-label="Search workspace"
              onClick={() => setModal('search')}
            >
              <Search size={14} />
              <span>Search workspace</span>
              <kbd>⌘ K</kbd>
            </button>
            <Badge tone="demo">
              <span className="live-dot" /> Local demo
            </Badge>
            <button
              className="icon-button help-button"
              aria-label="Open documentation"
              onClick={() =>
                window.open('https://docs.pingcap.com/tidbcloud/', '_blank', 'noopener')
              }
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <main key={route}>
          {route === 'overview' && <Overview {...shared} />}
          {route === 'databases' && <Databases {...shared} />}
          {route === 'sql' && <SqlEditor {...shared} />}
          {route === 'files' && <Files {...shared} />}
          {route === 'connect' && <Connect {...shared} />}
          {route === 'keys' && <Keys {...shared} onNewKey={() => setModal('key')} />}
          {route === 'api' && <ApiExplorer {...shared} />}
          {route === 'monitoring' && <Monitoring {...shared} />}
          {route === 'billing' && <Billing {...shared} />}
          {route === 'settings' && <WorkspaceSettings {...shared} />}
        </main>
        <footer className="footer">
          <span>
            <span className="live-dot" /> Local provider operational
          </span>
          <span>
            Product prototype <span>·</span> Cloud resources & telemetry are simulated
          </span>
          <a href="https://docs.pingcap.com/tidbcloud/" target="_blank" rel="noreferrer">
            TiDB documentation <ArrowUpRight size={12} />
          </a>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {modal === 'resource' && <CreateResource {...shared} onClose={() => setModal(null)} />}
      {modal === 'key' && <CreateKey {...shared} onClose={() => setModal(null)} />}
      {modal === 'search' && (
        <SearchModal data={data} onClose={() => setModal(null)} onConnect={setConnection} />
      )}
      {connection && (
        <Connection resource={connection} copy={copy} onClose={() => setConnection(null)} />
      )}
    </div>
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
        <h1>{title}</h1>
        <p>{description}</p>
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
            <Button icon={Workflow} onClick={() => go('connect')}>
              Connect an agent
            </Button>
            <Button variant="primary" icon={Plus} onClick={onCreate}>
              Create resource
            </Button>
          </>
        }
      />
      <section className="welcome-panel">
        <div className="welcome-copy">
          <Badge tone="white">
            <Sparkles size={12} /> BUILT FOR DEVELOPERS & AGENTS
          </Badge>
          <h2>
            Give your next idea
            <br />a place to grow.
          </h2>
          <p>
            SQL for memory. Files for context.
            <br />
            One workspace for everything you build.
          </p>
          <button className="text-link" onClick={() => go('connect')}>
            Connect your first agent <ArrowRight size={15} />
          </button>
        </div>
        <WorkspaceIllustration />
      </section>
      <div className="section-title">
        <h2>
          Your resources <span>{data.resources.length}</span>
        </h2>
        <button className="text-link subtle" onClick={onCreate}>
          <Plus size={14} /> Add resource
        </button>
      </div>
      <section className="resource-grid">
        {(['mysql', 'postgresql', 'filesystem'] as Kind[]).map((kind) => {
          const items = data.resources.filter((r) => r.kind === kind),
            r = items[0];
          return (
            <div className="resource-card" key={kind}>
              <div className="resource-card-top">
                <KindIcon kind={kind} />
                <Badge tone={kind === 'mysql' ? 'neutral' : 'purple'}>
                  {kind === 'mysql' ? 'Starter' : 'Preview'}
                </Badge>
              </div>
              <h3>
                {kindLabel[kind]}
                {kind !== 'filesystem' && <span className="resource-type">database</span>}
              </h3>
              <p>{kindDescription[kind]}</p>
              <button
                className="resource-name"
                onClick={() => go(kind === 'filesystem' ? 'files' : 'databases')}
              >
                <span className="live-dot" />
                {r?.name || 'No resource yet'}
                {items.length > 1 && <span className="count">+{items.length - 1}</span>}
                <ChevronRight size={14} />
              </button>
              <div className="resource-card-bottom">
                <span>{r ? region(r.region) : 'Ready when you are'}</span>
                <button onClick={() => (r ? onConnect(r) : onCreate())}>
                  {r ? 'Connect' : 'Create'} <ArrowUpRight size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </section>
      <div className="overview-grid">
        <section className="panel activity-panel">
          <div className="panel-header">
            <div>
              <h2>Workspace activity</h2>
              <p>Illustrative activity · demo data</p>
            </div>
            <div className="segmented">
              {['24h', '7d'].map((r) => (
                <button
                  className={range === r ? 'selected' : ''}
                  key={r}
                  onClick={() => setRange(r)}
                >
                  {r === '24h' ? '24 hours' : '7 days'}
                </button>
              ))}
            </div>
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
        </section>
        <section className="panel spend-panel">
          <div className="panel-header">
            <h2>Usage this month</h2>
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
            <div className="progress">
              <i style={{ width: '0%' }} />
            </div>
            <div>
              <span>File System allowance</span>
              <strong>$5 / month</strong>
            </div>
            <small>Shared across the cloud organization.</small>
          </div>
          <button className="text-link" onClick={() => go('billing')}>
            View usage & limits <ArrowRight size={14} />
          </button>
        </section>
      </div>
      <div className="overview-grid bottom-grid">
        <section className="panel quickstart-panel">
          <div className="panel-header">
            <h2>From workspace to workflow</h2>
            <Terminal size={17} />
          </div>
          <p className="section-description">
            Let your agent discover its resources through one API.
          </p>
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
            <button className="text-link" onClick={() => go('connect')}>
              Setup guide <ArrowUpRight size={13} />
            </button>
          </div>
        </section>
        <section className="panel events-panel">
          <div className="panel-header">
            <h2>Recent activity</h2>
            <button className="text-link subtle" onClick={() => go('monitoring')}>
              View all <ArrowUpRight size={13} />
            </button>
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
        </section>
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
function Databases({ data, onCreate, onConnect }: Shared) {
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE RESOURCES"
        title="Databases"
        description="Persistent memory, structured data, and vectors for your agents."
        actions={
          <Button variant="primary" icon={Plus} onClick={onCreate}>
            Create database
          </Button>
        }
      />
      <div className="notice">
        <Database size={17} />
        <span>
          MySQL and PostgreSQL are separate resources. Use one Workspace Key with access to the
          databases and actions your workflow needs.
        </span>
      </div>
      <div className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Database</th>
              <th>Compatibility</th>
              <th>Region</th>
              <th>Status</th>
              <th>Plan</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.resources
              .filter((r) => r.kind !== 'filesystem')
              .map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="table-resource">
                      <KindIcon small kind={r.kind} />
                      <div>
                        <strong>{r.name}</strong>
                        <small>{r.id}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    {kindLabel[r.kind]}{' '}
                    {r.kind === 'postgresql' && <Badge tone="purple">Preview</Badge>}
                  </td>
                  <td>{region(r.region)}</td>
                  <td>
                    <span className="status">
                      <span className="live-dot" />
                      Active
                    </span>
                  </td>
                  <td>Starter · Free</td>
                  <td>
                    <Button onClick={() => onConnect(r)}>
                      Connect <ArrowUpRight size={13} />
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="two-column">
        <div className="panel info-panel">
          <Code2 size={22} />
          <h3>Start with a query</h3>
          <p>
            Explore sample agent events in the SQL editor. The demo provider supports two read-only
            query patterns.
          </p>
          <button className="text-link" onClick={() => go('sql')}>
            Open SQL editor <ArrowRight size={14} />
          </button>
        </div>
        <div className="panel info-panel">
          <Workflow size={22} />
          <h3>Built for your existing tools</h3>
          <p>
            Use a single Workspace Key through the API. MySQL and PostgreSQL compatibility is
            handled by the database service; native client connections are a future integration.
          </p>
          <a
            className="text-link"
            href="https://docs.pingcap.com/tidbcloud/connect-to-tidb-cluster/"
            target="_blank"
            rel="noreferrer"
          >
            Connection documentation <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
    </>
  );
}
function SqlEditor({ data, refresh, notify }: Shared) {
  const dbs = data.resources.filter((r) => r.kind !== 'filesystem');
  const [resourceId, setResourceId] = useState(dbs[0]?.id || ''),
    [sql, setSql] = useState('SELECT * FROM agent_events LIMIT 10;'),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<QueryResult | null>(null),
    [error, setError] = useState('');
  async function run() {
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
      <PageHeading title="SQL editor" description="Explore your database, one query at a time." />
      <div className="notice">
        <Sparkles size={17} />
        <span>
          Local query sandbox. Supports <code>SELECT 1</code> and{' '}
          <code>SELECT * FROM agent_events LIMIT n</code>. Cloud SQL execution is not connected.
        </span>
      </div>
      <div className="panel sql-panel">
        <div className="sql-toolbar">
          <div className="inline-controls">
            <Database size={16} />
            <select
              aria-label="Database"
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                setResult(null);
              }}
            >
              {dbs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {kindLabel[r.kind]}
                </option>
              ))}
            </select>
            <Badge>Demo</Badge>
          </div>
          <Button
            variant="primary"
            icon={busy ? Loader2 : Play}
            disabled={busy || !resourceId}
            onClick={run}
          >
            {busy ? 'Running…' : 'Run query'}
          </Button>
        </div>
        <div className="editor">
          <div className="line-numbers">
            {sql.split('\n').map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            aria-label="SQL query"
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
          />
        </div>
        <div className="editor-bottom">
          <span>SQL · {kindLabel[dbs.find((r) => r.id === resourceId)?.kind || 'mysql']}</span>
          <span>⌘ / Ctrl + Enter to run</span>
        </div>
      </div>
      <div className="sample-queries">
        <span>Try a sample:</span>
        <button onClick={() => setSql('SELECT 1 AS connected;')}>Test connection</button>
        <button onClick={() => setSql('SELECT * FROM agent_events LIMIT 10;')}>
          Read agent events
        </button>
      </div>
      <section className="panel result-panel">
        <div className="panel-header">
          <h2>Results {result && <Badge tone="green">{result.rowCount} rows</Badge>}</h2>
          {result && (
            <Button
              icon={ArrowDownToLine}
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
          <div className="inline-error">{error}</div>
        ) : result ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {result.columns.map((c: string) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r: Record<string, unknown>, i: number) => (
                  <tr key={i}>
                    {result.columns.map((c: string) => (
                      <td key={c}>
                        <code>{String(r[c])}</code>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
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
      </section>
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
  async function saveFile(target: string, type: string, text = '') {
    setBusy(true);
    setError('');
    try {
      await api(base + '/files', {
        method: 'PUT',
        body: JSON.stringify({ resourceId: system, path: target, type, content: text }),
      });
      await refresh();
      notify(type === 'directory' ? 'Folder created' : 'File saved');
      setNewItem(null);
      setEditing(null);
      setName('');
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message);
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
              icon={Terminal}
              onClick={() => {
                const r = systems.find((r) => r.id === system);
                if (r) onConnect(r);
              }}
            >
              Connect
            </Button>
            <Button
              variant="primary"
              icon={Upload}
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
            <select
              aria-label="File system"
              className="heading-select"
              value={system}
              onChange={(e) => {
                setSystem(e.target.value);
                setPath('/');
              }}
            >
              {systems.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <small>
              {systems[0] ? region(systems.find((r) => r.id === system)!.region) : 'No file system'}
            </small>
          </div>
          <Badge tone="purple">Preview</Badge>
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
      <div className="panel file-browser">
        <div className="file-toolbar">
          <div className="path-crumb">
            <button aria-label="File system root" onClick={() => setPath('/')}>
              <Folder size={16} />
            </button>
            <button onClick={() => setPath('/')}>shared-files</button>
            {path
              .split('/')
              .filter(Boolean)
              .map((s, i) => (
                <React.Fragment key={i}>
                  <ChevronRight size={13} />
                  <button
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
                  </button>
                </React.Fragment>
              ))}
          </div>
          <div className="inline-controls">
            <div className="input-with-icon">
              <Search size={14} />
              <input
                aria-label="Search files"
                placeholder="Filter files…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button
              icon={FolderPlus}
              disabled={!system}
              onClick={() => {
                setNewItem('directory');
                setError('');
              }}
            >
              New folder
            </Button>
            <Button
              icon={Plus}
              disabled={!system}
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
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Last modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {path !== '/' && (
                <tr>
                  <td colSpan={4}>
                    <button
                      className="file-name"
                      onClick={() => setPath(path.slice(0, path.lastIndexOf('/')) || '/')}
                    >
                      <Folder size={17} />
                      ..
                    </button>
                  </td>
                </tr>
              )}
              {children.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button
                      className="file-name"
                      onClick={() => {
                        if (f.type === 'directory') {
                          setPath(f.path);
                          setSearch('');
                        } else {
                          setEditing(f);
                          setContent(f.content || '');
                          setError('');
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
                      <strong>{f.path.split('/').pop()}</strong>
                    </button>
                  </td>
                  <td>
                    {f.type === 'directory'
                      ? '—'
                      : bytes(new TextEncoder().encode(f.content || '').length)}
                  </td>
                  <td>{relative(f.updatedAt)}</td>
                  <td>
                    <div className="row-actions">
                      {f.type === 'file' && (
                        <button
                          className="icon-button"
                          aria-label={`Download ${f.path}`}
                          onClick={() => download(f.path.split('/').pop()!, f.content || '')}
                        >
                          <ArrowDownToLine size={15} />
                        </button>
                      )}
                      <button
                        className="icon-button"
                        aria-label={`Delete ${f.path}`}
                        onClick={() => {
                          setDeleting(f);
                          setError('');
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
      </div>
      <div className="notice quiet">
        <ShieldCheck size={17} />
        <span>
          Use the same Workspace Key for databases and files. File operations require access to this
          File System and the corresponding read or write permission.
        </span>
      </div>
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
            <label>
              Name
              <input
                autoFocus
                required
                maxLength={100}
                placeholder={newItem === 'file' ? 'context.md' : 'research'}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {error && <p className="inline-error">{error}</p>}
            <div className="modal-actions">
              <Button type="button" onClick={() => setNewItem(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy}>
                Create {newItem === 'file' ? 'file' : 'folder'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal
          wide
          title={editing.path.split('/').pop()!}
          description={editing.path + ' · Local file editor'}
          onClose={() => setEditing(null)}
        >
          <textarea
            className="file-editor"
            aria-label="File content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
          {error && <p className="inline-error">{error}</p>}
          <div className="modal-actions">
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => saveFile(editing.path, 'file', content)}
            >
              Save changes
            </Button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.type}?`}
          description={`“${deleting.path}” will be removed from this local workspace. Non-empty folders cannot be deleted.`}
          onClose={() => setDeleting(null)}
        >
          {error && <p className="inline-error">{error}</p>}
          <div className="modal-actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={remove}>
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
        <h2>
          Your agent brings the intelligence.
          <br />
          Your workspace keeps the context.
        </h2>
        <p>Discover databases, work with files, and inspect usage through a scoped API.</p>
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
        <section className="panel setup-steps">
          <h2>Connect in three steps</h2>
          <div className="setup-step">
            <span>1</span>
            <div>
              <h3>Create a workspace key</h3>
              <p>
                Grant only the permissions your agent needs. Keys expire automatically and can be
                revoked anytime.
              </p>
              <Button onClick={() => go('keys')} icon={KeyRound}>
                Manage API keys <ArrowUpRight size={13} />
              </Button>
            </div>
          </div>
          <div className="setup-step">
            <span>2</span>
            <div>
              <h3>Make your workspace discoverable</h3>
              <p>
                Provide the OpenAPI schema or reference WORKSPACE.md from your project’s existing
                agent instructions.
              </p>
              <div className="inline-controls">
                <Button onClick={() => download('WORKSPACE.md', agents)} icon={ArrowDownToLine}>
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
              <h3>Build with persistent context</h3>
              <p>
                Call the REST API from an agent shell or your application. No custom SDK is required
                for this prototype.
              </p>
            </div>
          </div>
        </section>
        <section className="panel connect-code-panel">
          <div className="tabs">
            {['Agent', 'JavaScript', 'Python'].map((t) => (
              <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <Code
            value={tab === 'Agent' ? snippet : tab === 'Python' ? python : js}
            copy={copy}
            label={tab === 'Agent' ? 'SHELL' : tab.toUpperCase()}
          />
          <div className="connection-note">
            <ShieldCheck size={17} />
            <p>
              Inject <code>WORKSPACE_API_KEY</code> through your environment. The full key is
              displayed once when created.
            </p>
          </div>
          <div className="capability-note">
            <Badge>REST API · Available locally</Badge>
            <p>
              Native MCP support is part of the proposed next phase. These instructions use the
              working REST API.
            </p>
          </div>
        </section>
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
          <Button variant="primary" icon={Plus} onClick={onNewKey}>
            Create API key
          </Button>
        }
      />
      <div className="notice">
        <ShieldCheck size={18} />
        <span>
          One Workspace Key can access MySQL, PostgreSQL, and files. Choose its allowed resources
          and actions; provider credentials are managed by the service.
        </span>
      </div>
      <div className="section-title">
        <h2>
          Workspace keys <span>{active.length} active</span>
        </h2>
        <Badge>Workspace scoped</Badge>
      </div>
      <div className="panel table-panel">
        {data.keys.length ? (
          <table>
            <thead>
              <tr>
                <th>Name & key</th>
                <th>Resource access</th>
                <th>Permissions</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div className="key-name">
                      <KeyRound size={17} />
                      <div>
                        <strong>{k.name}</strong>
                        <code>{k.prefix}…</code>
                      </div>
                    </div>
                  </td>
                  <td>
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
                  </td>
                  <td>
                    <div className="scope-chips">
                      {k.scopes.map((s) => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </div>
                  </td>
                  <td>{k.lastUsedAt ? relative(k.lastUsedAt) : 'Never'}</td>
                  <td>{new Date(k.expiresAt).toLocaleDateString()}</td>
                  <td>
                    <Badge
                      tone={
                        k.revokedAt
                          ? 'neutral'
                          : Date.parse(k.expiresAt) <= Date.now()
                            ? 'neutral'
                            : 'green'
                      }
                    >
                      {k.revokedAt
                        ? 'Revoked'
                        : Date.parse(k.expiresAt) <= Date.now()
                          ? 'Expired'
                          : 'Active'}
                    </Badge>
                  </td>
                  <td>
                    {!k.revokedAt && (
                      <button
                        className="text-link danger-link"
                        onClick={() => {
                          setRevoke(k);
                          setError('');
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={KeyRound}
            title="A key for every workflow"
            description="Create your first API key to give an agent access to this workspace."
            action={
              <Button variant="primary" icon={Plus} onClick={onNewKey}>
                Create API key
              </Button>
            }
          />
        )}
      </div>
      <div className="two-column">
        <div className="panel info-panel">
          <ShieldCheck size={22} />
          <h3>Least privilege by default</h3>
          <p>
            Use read-only access for exploration. Add write and query permissions only when your
            workflow needs them.
          </p>
        </div>
        <div className="panel info-panel">
          <RefreshCw size={22} />
          <h3>Rotate without surprises</h3>
          <p>
            Create a replacement key, update your agent’s environment, then revoke the old key. Full
            keys are never stored on the server.
          </p>
        </div>
      </div>
      {revoke && (
        <Modal
          title="Revoke API key?"
          description={`Agents using “${revoke.name}” will immediately lose access. Create a replacement first if the workflow should keep running.`}
          onClose={() => setRevoke(null)}
        >
          {error && <p className="inline-error">{error}</p>}
          <div className="modal-actions">
            <Button onClick={() => setRevoke(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={doRevoke}>
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
          <a className="button secondary" href="/openapi.json" target="_blank" rel="noreferrer">
            <ArrowUpRight size={15} />
            OpenAPI 3.1 schema
          </a>
        }
      />
      <div className="api-layout">
        <section className="panel endpoint-list">
          <div className="panel-header">
            <h2>Workspace API</h2>
            <Badge>v1</Badge>
          </div>
          {endpoints.map((e) => (
            <button
              className={endpoint === e.path ? 'selected' : ''}
              key={e.path}
              onClick={() => {
                setEndpoint(e.path);
                setResult('');
                setError('');
              }}
            >
              <span className="http-method">GET</span>
              <span>
                <strong>{e.label}</strong>
                <code>{e.path.split('?')[0]}</code>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          <div className="endpoint-note">
            The schema also documents resource creation, file writes, queries, and key management.
          </div>
        </section>
        <div className="api-main">
          <section className="panel">
            <div className="panel-header">
              <h2>{endpoints.find((e) => e.path === endpoint)?.label}</h2>
              <Badge>{endpoints.find((e) => e.path === endpoint)?.scope}</Badge>
            </div>
            <div className="api-url">
              <span className="http-method">GET</span>
              <code>{base + endpoint}</code>
              <Button variant="dark" icon={busy ? Loader2 : Play} onClick={run} disabled={busy}>
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
          </section>
          <section className="panel api-response">
            <div className="panel-header">
              <h2>Response</h2>
              {result && <Badge tone="green">200 OK</Badge>}
            </div>
            {error ? (
              <p className="inline-error">{error}</p>
            ) : result ? (
              <Code label="JSON" value={result} copy={copy} />
            ) : (
              <Empty
                icon={Terminal}
                title="See the API in action"
                description="Send a request to inspect the real local response."
              />
            )}
          </section>
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
          <div className="segmented">
            {['24h', '7d'].map((r) => (
              <button key={r} className={r === range ? 'selected' : ''} onClick={() => setRange(r)}>
                {r === '24h' ? '24 hours' : '7 days'}
              </button>
            ))}
          </div>
        }
      />
      <div className="tabs standalone">
        {['Metrics', 'Activity log'].map((t) => (
          <button className={tab === t ? 'selected' : ''} key={t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Metrics' ? (
        <>
          <div className="notice">
            <Activity size={17} />
            <span>
              Charts below are illustrative. Resource counts and local action counts come from the
              running prototype. Cloud QPS and latency are not connected.
            </span>
          </div>
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
                value: data.keys.filter((k) => !k.revokedAt && Date.parse(k.expiresAt) > Date.now())
                  .length,
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
              <div className="panel metric-card" key={m.name}>
                <div>
                  <span>{m.name}</span>
                  <m.icon size={16} />
                </div>
                <strong>{m.value}</strong>
                <small>{m.unit}</small>
              </div>
            ))}
          </div>
          <div className="two-column">
            <section className="panel monitoring-chart">
              <div className="panel-header">
                <h2>Request activity</h2>
                <Badge>Illustrative</Badge>
              </div>
              <div className="chart-wrap">
                <Sparkline large range={range} />
                <div className="chart-axis">
                  <span>{range === '7d' ? '7 days ago' : '24 hours ago'}</span>
                  <span>Now</span>
                </div>
              </div>
            </section>
            <section className="panel monitoring-chart blue-chart">
              <div className="panel-header">
                <h2>Query duration</h2>
                <Badge>Illustrative</Badge>
              </div>
              <div className="chart-wrap">
                <Sparkline large range={range === '7d' ? '24h' : '7d'} />
                <div className="chart-axis">
                  <span>{range === '7d' ? '7 days ago' : '24 hours ago'}</span>
                  <span>Now</span>
                </div>
              </div>
            </section>
          </div>
          <div className="section-title">
            <h2>Resource health</h2>
          </div>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.resources.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="table-resource">
                        <KindIcon small kind={r.kind} />
                        <strong>{r.name}</strong>
                      </div>
                    </td>
                    <td>{kindLabel[r.kind]}</td>
                    <td>Local demo</td>
                    <td>
                      <span className="status">
                        <span className="live-dot" />
                        Available
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="log-toolbar">
            <div className="input-with-icon">
              <Search size={15} />
              <input
                aria-label="Filter activity"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by action, resource, or actor…"
              />
            </div>
            <span>{events.length} events · Latest 200 local events</span>
          </div>
          <div className="panel table-panel">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Actor</th>
                  <th>Result</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td>{e.resource}</td>
                    <td>{e.actor}</td>
                    <td>
                      <Badge tone="green">Success</Badge>
                    </td>
                    <td>{new Date(e.at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!events.length && (
              <Empty title="No matching events" description="Try a different filter." />
            )}
          </div>
        </>
      )}
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
          <Badge tone="green">
            <ShieldCheck size={13} />
            No payment method
          </Badge>
        }
      />
      <div className="billing-overview panel">
        <div>
          <Badge>FREE PLAN</Badge>
          <h2>Room to experiment.</h2>
          <p>
            This prototype keeps spending at $0. Cloud allowances are tracked separately for each
            service.
          </p>
        </div>
        <div className="billing-total">
          <span>Estimated charges</span>
          <strong>
            $0.00<small>/ month</small>
          </strong>
          <span>Local demo · No cloud charges generated</span>
        </div>
      </div>
      <div className="section-title">
        <h2>Resource allowances</h2>
        <a
          className="text-link"
          href="https://docs.pingcap.com/tidbcloud/select-cluster-tier/"
          target="_blank"
          rel="noreferrer"
        >
          Current cloud limits <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Resource</th>
              <th>Storage</th>
              <th>Request units / month</th>
              <th>Plan</th>
            </tr>
          </thead>
          <tbody>
            {data.usage.map((u) => (
              <tr key={u.resourceId}>
                <td>
                  <div className="table-resource">
                    <KindIcon small kind={u.kind} />
                    <div>
                      <strong>{u.name}</strong>
                      <small>{kindLabel[u.kind]}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="usage-cell">
                    <span>
                      {bytes(u.storageBytes)} <small>/ {u.storageLimitBytes / 1024 ** 3} GiB</small>
                    </span>
                    <div className="progress">
                      <i
                        style={{
                          width: `${Math.min((u.storageBytes / u.storageLimitBytes) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </td>
                <td>
                  {u.monthlyRULimit ? (
                    <>
                      {u.kind === 'postgresql' ? 'Not metered in demo' : '0'}{' '}
                      <small>/ {u.monthlyRULimit / 1000000}M</small>
                    </>
                  ) : (
                    'Read / write / storage / egress'
                  )}
                </td>
                <td>
                  <Badge tone={u.kind === 'mysql' ? 'neutral' : 'purple'}>
                    {u.kind === 'mysql' ? 'Starter Free' : 'Free · Preview'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="two-column">
        <section className="panel info-panel">
          <Folder size={22} />
          <h3>File System free tier</h3>
          <p>
            $5 monthly allowance shared across the cloud organization. Without a credit card: one
            file system per region, 2 GiB storage and 2,000 files per system.
          </p>
          <p className="muted">
            The $5 allowance reduces cloud charges; it is not a universal spend cap. This local demo
            does not meter cloud spend.
          </p>
          <a
            className="text-link"
            href="https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-limits/"
            target="_blank"
            rel="noreferrer"
          >
            File System limits <ArrowUpRight size={13} />
          </a>
        </section>
        <section className="panel info-panel">
          <ShieldCheck size={22} />
          <h3>Predictable limits</h3>
          <p>
            MySQL Starter with a $0 spending limit can throttle or reject connections at its quota.
            PostgreSQL Preview can restrict usage at its allowance.
          </p>
          <p className="muted">
            At a File System capacity limit, existing files remain readable and new writes stop.
            Native cloud enforcement must be verified when connecting providers.
          </p>
        </section>
      </div>
      <div className="notice quiet">
        <CreditCard size={18} />
        <span>
          Payments, invoices, and paid upgrades are deferred for this validation release. No payment
          information is collected.
        </span>
      </div>
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
        <section className="panel settings-panel">
          <div className="panel-header">
            <div>
              <h2>Workspace details</h2>
              <p>The home for your resources and agent workflows.</p>
            </div>
          </div>
          <div className="settings-fields">
            <label>
              Workspace name
              <input
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
                minLength={2}
                maxLength={50}
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Workspace ID
              <div className="copy-input">
                <code>{data.workspace.id}</code>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Copy workspace ID"
                  onClick={() => copy(data.workspace.id)}
                >
                  <Copy size={15} />
                </button>
              </div>
            </label>
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="panel-header">
            <div>
              <h2>Personal account</h2>
              <p>Your local developer profile.</p>
            </div>
            <Badge>Local owner</Badge>
          </div>
          <div className="settings-fields">
            <label>
              Display name
              <input
                required
                maxLength={50}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="account-row">
              <span className="profile-avatar">{name.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>Guest session</strong>
                <p>
                  Sign-in and account linking are deferred. Your local workspace is saved on this
                  machine.
                </p>
              </div>
              <Badge tone="green">Active</Badge>
            </div>
          </div>
        </section>
        {error && <p className="inline-error">{error}</p>}
        <div className="settings-save">
          <p>Changes apply to this local workspace.</p>
          <Button variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
      <div className="notice quiet">
        <KeyRound size={17} />
        <span>
          For automation, create a scoped API key. The browser’s guest session cannot administer
          real TiDB Cloud accounts.
        </span>
      </div>
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
  const limited =
    kind === 'filesystem' &&
    data.resources.some((r) => r.kind === kind && r.region === selectedRegion);
  return (
    <Modal
      title="Create a resource"
      description="Add a building block to your agent workspace."
      onClose={onClose}
    >
      <form onSubmit={create}>
        <label>Resource type</label>
        <div className="resource-picker">
          {(['mysql', 'postgresql', 'filesystem'] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={k === kind ? 'selected' : ''}
              onClick={() => changeKind(k)}
            >
              <KindIcon small kind={k} />
              <span>{kindLabel[k]}</span>
              {k === kind && <Check size={15} />}
            </button>
          ))}
        </div>
        <label>
          Resource name
          <input
            required
            pattern="[a-z][a-z0-9-]{2,39}"
            minLength={3}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'filesystem' ? 'agent-context' : 'agent-memory-dev'}
          />
          <small>3–40 lowercase letters, numbers, and hyphens.</small>
        </label>
        <label>
          Region
          <select value={selectedRegion} onChange={(e) => setRegion(e.target.value)}>
            {data.capabilities[kind].regions.map((r) => (
              <option key={r} value={r}>
                {region(r)}
              </option>
            ))}
          </select>
          <small>
            {kind === 'postgresql'
              ? 'PostgreSQL Preview is configured for N. Virginia in this prototype.'
              : 'Available regions depend on the resource provider.'}
          </small>
        </label>
        <div className="plan-selection">
          <div>
            <Zap size={17} />
            <strong>Free tier</strong>
            <Badge>{kind === 'mysql' ? 'Starter' : 'Preview'}</Badge>
          </div>
          <p>
            {data.capabilities[kind].storageGiB} GiB storage
            {kind === 'filesystem'
              ? ' · 2,000 files'
              : ` · ${data.capabilities[kind].monthlyRU! / 1000000}M RU / month`}
          </p>
          <small>Local simulation. No real cloud resource will be provisioned.</small>
        </div>
        {limited && (
          <div className="notice">
            <CircleHelp size={17} />
            <span>
              Your free file system already exists in this region. Use shared-files to continue.
            </span>
          </div>
        )}
        {error && <p className="inline-error">{error}</p>}
        <div className="modal-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || limited} icon={busy ? Loader2 : Plus}>
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
          <div className="notice">
            <ShieldCheck size={17} />
            <span>
              Save this in your agent’s environment as WORKSPACE_API_KEY. This demo key only works
              against the local workspace API.
            </span>
          </div>
          <div className="modal-actions">
            <Button icon={Copy} onClick={() => copy(secret)}>
              Copy key
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={create}>
          <label>
            Key name
            <input
              required
              minLength={2}
              maxLength={60}
              placeholder="e.g. coding-agent-dev"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <ResourceAccessPicker
            resources={data.resources}
            resourceIds={resourceIds}
            onChange={(ids) => {
              setResourceIds(ids);
              if (!ids.includes('*'))
                setScopes((current) => current.filter((scope) => scope !== 'resources:write'));
            }}
          />
          <label>Allowed actions</label>
          <div className="scope-picker">
            {allScopes.map((s) => (
              <label key={s}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  disabled={s === 'resources:write' && !resourceIds.includes('*')}
                  onChange={(e) =>
                    setScopes(e.target.checked ? [...scopes, s] : scopes.filter((v) => v !== s))
                  }
                />
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
              </label>
            ))}
          </div>
          <label>
            Expiration
            <select value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          {error && <p className="inline-error">{error}</p>}
          <div className="modal-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={KeyRound}
              disabled={busy || !scopes.length || !resourceIds.length}
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
      <div className="notice">
        <KeyRound size={17} />
        <span>
          Use a Workspace Key with access to <strong>{r.name}</strong> and{' '}
          <code>{isFileSystem ? 'files:read' : 'queries:execute'}</code>. The same key can access
          your other permitted resources.
        </span>
      </div>
      <div className="tabs standalone">
        {['REST API', 'JavaScript', 'Python'].map((item) => (
          <button
            key={item}
            className={tab === item ? 'selected' : ''}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <Code
        copy={copy}
        label="WORKSPACE API · LOCAL DEMO"
        value={tab === 'REST API' ? shell : tab === 'JavaScript' ? javascript : python}
      />
      <div className="connection-note">
        <ShieldCheck size={18} />
        <p>
          Provider credentials are handled by the service. This preview uses a local provider;
          native database connections and file mounts are not available yet.
        </p>
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
          variant="dark"
          onClick={() => {
            onClose();
            go(isFileSystem ? 'files' : 'sql');
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
        <input
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
          <button
            key={key}
            onClick={() => {
              go(key as Route);
              onClose();
            }}
          >
            <r.icon size={17} />
            <span>{r.label}</span>
            <ArrowUpRight size={14} />
          </button>
        ))}
        <div className="nav-label">Resources</div>
        {resources.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              onClose();
              setTimeout(() => onConnect(r), 0);
            }}
          >
            <KindIcon small kind={r.kind} />
            <span>{r.name}</span>
            <Badge>{kindLabel[r.kind]}</Badge>
          </button>
        ))}
        {!pages.length && !resources.length && <p>No results for “{query}”.</p>}
      </div>
    </Modal>
  );
}

export default App;
