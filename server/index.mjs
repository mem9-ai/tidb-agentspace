import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, capabilities, workspaceId, usage } from './store.mjs';
import { canAccessResource, normalizeResourceGrant } from './access-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const allowedScopes = [
  'resources:read',
  'resources:write',
  'files:read',
  'files:write',
  'queries:execute',
  'usage:read',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
const keyView = ({ digest, ...key }) => ({ ...key, resourceIds: key.resourceIds ?? [] });
function fileView(file) {
  return { ...file, size: Buffer.byteLength(file.content || '') };
}
function event(state, action, resource, actor, resourceId = null) {
  state.events.unshift({
    id: randomUUID(),
    action,
    resourceId,
    resource,
    actor,
    at: new Date().toISOString(),
    outcome: 'success',
  });
  state.events = state.events.slice(0, 200);
}
function cleanPath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.length > 512 ||
    value.split('/').some((p) => p === '.' || p === '..')
  )
    fail(400, 'INVALID_PATH', 'Use an absolute path without . or .. segments.');
  return value.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json'))
    fail(415, 'JSON_REQUIRED', 'Send Content-Type: application/json.');
  let bytes = 0,
    chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) fail(413, 'BODY_TOO_LARGE', 'Request exceeds 1 MiB.');
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    fail(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  return parsed;
}
export async function createApp({ dataFile = resolve(root, '.data/workspace.json') } = {}) {
  const store = await createStore(dataFile);
  const sessions = new Map();
  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const hostname = (req.headers.host || '').split(':')[0];
      if (!['localhost', '127.0.0.1'].includes(hostname))
        fail(403, 'LOCAL_ONLY', 'This prototype is available on loopback only.');
      if (
        req.headers.origin &&
        ![
          'http://127.0.0.1:5173',
          'http://localhost:5173',
          'http://127.0.0.1:4318',
          'http://localhost:4318',
          `http://${req.headers.host}`,
        ].includes(req.headers.origin)
      )
        fail(403, 'ORIGIN_DENIED', 'Untrusted origin.');
      const url = new URL(req.url, `http://${req.headers.host}`),
        path = url.pathname;
      if (path === '/api/health')
        return send(200, { status: 'ok', mode: 'demo', cloudConnected: false });
      if (path === '/openapi.json') {
        const schema = JSON.parse(await readFile(resolve(root, 'public/openapi.json'), 'utf8'));
        return send(200, schema);
      }
      if (path === '/api/session' && req.method === 'POST') {
        await body(req);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 28800000);
        for (const [id, expiresAt] of sessions) if (expiresAt <= Date.now()) sessions.delete(id);
        res.setHeader(
          'Set-Cookie',
          `aw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return send(200, { workspaceId, mode: 'demo' });
      }
      if (!path.startsWith('/api/')) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const staticRoot = resolve(root, 'dist');
        let location = resolve(staticRoot, file);
        if (!location.startsWith(staticRoot + '/')) fail(404, 'NOT_FOUND', 'Not found.');
        let content;
        try {
          content = await readFile(location);
        } catch {
          location = resolve(staticRoot, 'index.html');
          content = await readFile(location);
        }
        res.writeHead(200, {
          'Content-Type':
            {
              '.html': 'text/html',
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.svg': 'image/svg+xml',
            }[extname(location)] || 'application/octet-stream',
        });
        return res.end(content);
      }
      let state = store.read();
      const sessionToken = /(?:^|; )aw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      let isOwner = !!sessionToken && (sessions.get(sessionToken) || 0) > Date.now();
      let principal = 'You',
        principalId = 'local-owner',
        resourceIds = ['*'],
        scopes = ['*'];
      if (req.headers.authorization) {
        isOwner = false;
        const token = /^Bearer (\S+)$/.exec(req.headers.authorization)?.[1];
        const key = token && state.keys.find((k) => k.digest === hash(token));
        if (!key || key.revokedAt || Date.parse(key.expiresAt) <= Date.now())
          fail(401, 'INVALID_KEY', 'API key is invalid, expired, or revoked.');
        scopes = key.scopes;
        principal = key.name;
        principalId = key.id;
        resourceIds = key.resourceIds ?? [];
        await store.mutate((draft) => {
          draft.keys.find((k) => k.id === key.id).lastUsedAt = new Date().toISOString();
        });
      } else if (!isOwner)
        fail(401, 'UNAUTHENTICATED', 'Start a local demo session or provide a workspace API key.');
      const requireScope = (scope) => {
        if (!scopes.includes('*') && !scopes.includes(scope))
          fail(403, 'INSUFFICIENT_SCOPE', `This action requires ${scope}.`);
      };
      const requireOwner = () => {
        if (!isOwner) fail(403, 'OWNER_REQUIRED', 'This action requires the local owner session.');
      };
      const hasResource = (resourceId) => isOwner || canAccessResource(resourceIds, resourceId);
      const requireResource = (resourceId, kind) => {
        if (!hasResource(resourceId))
          fail(403, 'RESOURCE_ACCESS_DENIED', 'This key cannot access the requested resource.');
        const resource = state.resources.find((r) => r.id === resourceId);
        if (!resource || (kind && resource.kind !== kind))
          fail(404, 'NOT_FOUND', 'Resource not found.');
        return resource;
      };
      const prefix = `/api/v1/workspaces/${workspaceId}`;
      if (path === '/api/v1/workspaces' && req.method === 'GET') {
        requireScope('resources:read');
        return send(200, { data: [state.workspace] });
      }
      if (!path.startsWith(prefix + '/') && path !== prefix)
        fail(404, 'NOT_FOUND', 'Workspace or endpoint not found.');
      const route = path.slice(prefix.length);
      if (route === '' && req.method === 'GET') {
        requireScope('resources:read');
        return send(200, { data: state.workspace });
      }
      if (route === '/bootstrap' && req.method === 'GET') {
        requireOwner();
        return send(200, {
          ...state,
          keys: state.keys.map(keyView),
          idempotency: undefined,
          capabilities,
          usage: usage(state),
          mode: 'demo',
        });
      }
      if (route === '/resources' && req.method === 'GET') {
        requireScope('resources:read');
        return send(200, { data: state.resources.filter((r) => hasResource(r.id)), capabilities });
      }
      if (route === '/resources' && req.method === 'POST') {
        requireScope('resources:write');
        if (!isOwner && !resourceIds.includes('*'))
          fail(
            403,
            'WORKSPACE_GRANT_REQUIRED',
            'Creating resources requires access to all current and future workspace resources.',
          );
        const input = await body(req);
        if (!Object.hasOwn(capabilities, input.kind))
          fail(400, 'INVALID_KIND', 'Choose mysql, postgresql, or filesystem.');
        if (typeof input.name !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(input.name))
          fail(
            400,
            'INVALID_NAME',
            'Use 3–40 lowercase letters, numbers, and hyphens; start with a letter.',
          );
        if (!capabilities[input.kind].regions.includes(input.region))
          fail(400, 'UNSUPPORTED_REGION', 'This region is not available for this resource.');
        const idem = req.headers['idempotency-key'];
        if (idem && (typeof idem !== 'string' || idem.length > 128))
          fail(400, 'INVALID_IDEMPOTENCY_KEY', 'Use an idempotency key of at most 128 characters.');
        const idemSlot = `${principalId}:${idem}`,
          fingerprint = hash(JSON.stringify(input));
        const resource = await store.mutate((draft) => {
          if (idem && draft.idempotency[idemSlot]) {
            const previous = draft.idempotency[idemSlot];
            if (previous.fingerprint !== fingerprint)
              fail(409, 'IDEMPOTENCY_CONFLICT', 'This key was used with a different request.');
            return previous.resource;
          }
          if (draft.resources.some((r) => r.name === input.name))
            fail(409, 'NAME_EXISTS', 'A resource with this name already exists.');
          if (
            input.kind === 'filesystem' &&
            draft.resources.some((r) => r.kind === 'filesystem' && r.region === input.region)
          )
            fail(
              409,
              'FREE_TIER_LIMIT',
              'The free tier supports one file system per region. Use shared-files in this region.',
            );
          const limit = input.kind === 'mysql' ? 5 : 10;
          if (
            input.kind !== 'filesystem' &&
            draft.resources.filter((r) => r.kind === input.kind).length >= limit
          )
            fail(409, 'FREE_TIER_LIMIT', 'The demo free-tier instance limit has been reached.');
          const resource = {
            id: `${input.kind === 'filesystem' ? 'fs' : 'db'}_${randomBytes(6).toString('hex')}`,
            name: input.name,
            kind: input.kind,
            region: input.region,
            status: 'active',
            createdAt: new Date().toISOString(),
          };
          draft.resources.push(resource);
          event(draft, 'resource.created', resource.name, principal, resource.id);
          if (idem) draft.idempotency[idemSlot] = { fingerprint, resource };
          return resource;
        });
        return send(201, { data: resource, mode: 'demo' });
      }
      if (route === '/files' && req.method === 'GET') {
        requireScope('files:read');
        const resourceId = url.searchParams.get('resourceId');
        requireResource(resourceId, 'filesystem');
        return send(200, {
          data: state.files.filter((f) => f.resourceId === resourceId).map(fileView),
        });
      }
      if (route === '/files' && req.method === 'PUT') {
        requireScope('files:write');
        const input = await body(req),
          targetPath = cleanPath(input.path);
        requireResource(input.resourceId, 'filesystem');
        if (targetPath === '/') fail(400, 'INVALID_PATH', 'Choose a file or directory name.');
        if (!['file', 'directory'].includes(input.type))
          fail(400, 'INVALID_TYPE', 'Choose file or directory.');
        if (
          input.type === 'file' &&
          (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 256 * 1024)
        )
          fail(413, 'FILE_TOO_LARGE', 'The demo supports UTF-8 text files up to 256 KiB.');
        const result = await store.mutate((draft) => {
          if (!draft.resources.some((r) => r.id === input.resourceId && r.kind === 'filesystem'))
            fail(404, 'NOT_FOUND', 'File system not found.');
          const parent = targetPath.slice(0, targetPath.lastIndexOf('/')) || '/';
          if (
            parent !== '/' &&
            !draft.files.some(
              (f) =>
                f.resourceId === input.resourceId && f.path === parent && f.type === 'directory',
            )
          )
            fail(404, 'PARENT_MISSING', 'Parent directory does not exist.');
          const existing = draft.files.find(
            (f) => f.resourceId === input.resourceId && f.path === targetPath,
          );
          if (existing && existing.type !== input.type)
            fail(409, 'TYPE_CONFLICT', 'A different item type already exists at this path.');
          if (
            !existing &&
            draft.files.filter((f) => f.resourceId === input.resourceId).length >= 2000
          )
            fail(409, 'FREE_TIER_LIMIT', 'File count limit reached.');
          const file = {
            id: existing?.id || randomUUID(),
            resourceId: input.resourceId,
            path: targetPath,
            type: input.type,
            ...(input.type === 'file' ? { content: input.content } : {}),
            updatedAt: new Date().toISOString(),
          };
          if (existing) Object.assign(existing, file);
          else draft.files.push(file);
          event(
            draft,
            existing ? 'file.updated' : 'file.created',
            targetPath,
            principal,
            input.resourceId,
          );
          return fileView(file);
        });
        return send(200, { data: result });
      }
      if (route === '/files' && req.method === 'DELETE') {
        requireScope('files:write');
        const input = await body(req),
          targetPath = cleanPath(input.path);
        requireResource(input.resourceId, 'filesystem');
        await store.mutate((draft) => {
          const file = draft.files.find(
            (f) => f.resourceId === input.resourceId && f.path === targetPath,
          );
          if (!file) fail(404, 'NOT_FOUND', 'File not found.');
          if (
            draft.files.some(
              (f) => f.resourceId === input.resourceId && f.path.startsWith(targetPath + '/'),
            )
          )
            fail(409, 'DIRECTORY_NOT_EMPTY', 'Move or delete directory contents first.');
          draft.files = draft.files.filter((f) => f.id !== file.id);
          event(draft, 'file.deleted', targetPath, principal, input.resourceId);
        });
        return send(200, { deleted: true });
      }
      if (route === '/queries' && req.method === 'POST') {
        requireScope('queries:execute');
        const input = await body(req);
        if (requireResource(input.resourceId).kind === 'filesystem')
          fail(404, 'NOT_FOUND', 'Database not found.');
        const sql = String(input.sql || '')
          .trim()
          .replace(/;$/, '')
          .trim();
        let columns, rows;
        if (/^select\s+1(?:\s+as\s+connected)?$/i.test(sql)) {
          columns = ['connected'];
          rows = [{ connected: 1 }];
        } else if (/^select\s+\*\s+from\s+agent_events(?:\s+limit\s+(\d{1,3}))?$/i.test(sql)) {
          columns = ['id', 'agent', 'event', 'status', 'created_at'];
          const limit = Math.min(Number(/limit\s+(\d+)/i.exec(sql)?.[1] || 10), 100);
          rows = [
            {
              id: 1,
              agent: 'research-agent',
              event: 'context.loaded',
              status: 'completed',
              created_at: state.workspace.createdAt,
            },
            {
              id: 2,
              agent: 'coding-agent',
              event: 'memory.recalled',
              status: 'completed',
              created_at: state.workspace.createdAt,
            },
            {
              id: 3,
              agent: 'research-agent',
              event: 'output.saved',
              status: 'completed',
              created_at: state.workspace.createdAt,
            },
          ].slice(0, limit);
        } else
          fail(
            422,
            'DEMO_QUERY_ONLY',
            'The local provider supports SELECT 1 and SELECT * FROM agent_events LIMIT n. Connect a cloud provider to execute arbitrary SQL.',
          );
        await store.mutate((draft) => {
          draft.queryCount++;
          draft.resourceQueryCounts ??= {};
          draft.resourceQueryCounts[input.resourceId] =
            (draft.resourceQueryCounts[input.resourceId] || 0) + 1;
          event(draft, 'query.executed', input.resourceId, principal, input.resourceId);
        });
        return send(200, { columns, rows, rowCount: rows.length, mode: 'demo', durationMs: 0 });
      }
      if (route === '/keys' && req.method === 'GET') {
        requireOwner();
        return send(200, { data: state.keys.map(keyView) });
      }
      if (route === '/keys' && req.method === 'POST') {
        requireOwner();
        const input = await body(req);
        if (
          typeof input.name !== 'string' ||
          input.name.trim().length < 2 ||
          input.name.length > 60
        )
          fail(400, 'INVALID_NAME', 'Use a key name of 2–60 characters.');
        if (
          !Array.isArray(input.scopes) ||
          !input.scopes.length ||
          input.scopes.some((s) => !allowedScopes.includes(s))
        )
          fail(400, 'INVALID_SCOPE', 'Select at least one supported scope.');
        if (![7, 30, 90].includes(input.expiresInDays))
          fail(400, 'INVALID_EXPIRY', 'Choose 7, 30, or 90 days.');
        const grant = normalizeResourceGrant(input.resourceIds, state.resources);
        const secret = `aw_demo_${randomBytes(24).toString('hex')}`;
        const key = {
          id: randomUUID(),
          name: input.name.trim(),
          prefix: secret.slice(0, 16),
          digest: hash(secret),
          scopes: [...new Set(input.scopes)],
          resourceIds: grant,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + input.expiresInDays * 86400000).toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        };
        await store.mutate((draft) => {
          draft.keys.push(key);
          event(draft, 'key.created', key.name, principal);
        });
        return send(201, { data: keyView(key), secret });
      }
      if (route.startsWith('/keys/') && req.method === 'DELETE') {
        requireOwner();
        const id = route.split('/')[2];
        await store.mutate((draft) => {
          const key = draft.keys.find((k) => k.id === id);
          if (!key) fail(404, 'NOT_FOUND', 'Key not found.');
          key.revokedAt ||= new Date().toISOString();
          event(draft, 'key.revoked', key.name, principal);
        });
        return send(200, { revoked: true });
      }
      if (route === '/usage' && req.method === 'GET') {
        requireScope('usage:read');
        return send(200, {
          data: usage(store.read()).filter((item) => hasResource(item.resourceId)),
          mode: 'demo',
          queryCount:
            isOwner || resourceIds.includes('*')
              ? store.read().queryCount
              : Object.entries(store.read().resourceQueryCounts || {}).reduce(
                  (total, [id, count]) => total + (hasResource(id) ? count : 0),
                  0,
                ),
        });
      }
      if (route === '/events' && req.method === 'GET') {
        requireScope('resources:read');
        return send(200, {
          data: isOwner
            ? state.events
            : state.events.filter((e) => e.resourceId && hasResource(e.resourceId)),
        });
      }
      if (route === '/settings' && req.method === 'PATCH') {
        requireOwner();
        const input = await body(req);
        if (
          typeof input.workspaceName !== 'string' ||
          input.workspaceName.trim().length < 2 ||
          input.workspaceName.length > 50 ||
          typeof input.name !== 'string' ||
          input.name.trim().length < 1 ||
          input.name.length > 50
        )
          fail(400, 'INVALID_NAME', 'Enter a display name and a workspace name (2–50 characters).');
        await store.mutate((draft) => {
          draft.workspace.name = input.workspaceName.trim();
          draft.workspace.description = String(input.description || '').slice(0, 200);
          draft.profile.name = input.name.trim();
          event(draft, 'workspace.updated', draft.workspace.name, principal);
        });
        return send(200, { saved: true });
      }
      fail(404, 'NOT_FOUND', 'Endpoint or method not found.');
    } catch (error) {
      send(error.status || 500, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: error.status ? error.message : 'An unexpected error occurred.',
          requestId,
        },
      });
    }
  });
}
export async function startServer(options = {}) {
  const server = await createApp(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4318, '127.0.0.1', resolve);
  });
  console.log(`Workspace API: http://127.0.0.1:${server.address().port} (local demo provider)`);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startServer();
