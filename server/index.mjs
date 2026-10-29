import { publicPathPrefix } from './http-policy.mjs';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, capabilities, workspaceId, usage } from './store.mjs';
import { createDrive9, drive9Provider, drive9Region } from './providers/drive9.mjs';
import { createDb9, db9Provider, db9Region } from './providers/db9.mjs';
import { createZero, zeroProvider, zeroRegion } from './providers/zero.mjs';
import { createDuckdb, duckdbProvider } from './providers/duckdb.mjs';
import { parseSources, stageSources } from './duckdb-sources.mjs';
import { browseDatabase, demoColumns, demoRows } from './database-browser.mjs';
import { readUpload, previewFile, downloadFile } from './file-transfer.mjs';
import { canAccessResource, normalizeResourceGrant } from './access-policy.mjs';
import { createFileAnalysis } from './file-analysis.mjs';
import { createAnalysisSnapshot } from './file-analysis-snapshot.mjs';
import {
  applyHttpPolicy,
  consoleOrigins,
  trustedOrigins,
  trustedProxies,
  clientSource,
} from './http-policy.mjs';
import {
  loadSsoConfig,
  resolveEndpoints,
  buildAuthorizeUrl,
  exchangeCode,
  verifyIdToken,
  resolveIdentity,
  createPkcePair,
  randomToken,
  publicSsoInfo,
} from './sso.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const allowedScopes = [
  'resources:read',
  'resources:write',
  'files:read',
  'files:write',
  'files:analyze',
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
export async function createApp({
  dataFile = process.env.WORKSPACE_DATA_FILE || resolve(root, '.data/workspace.json'),
  allowedOrigins = consoleOrigins(),
  publicOrigins = trustedOrigins(),
  trustedProxyList = trustedProxies(),
  filesProvider = process.env.WORKSPACE_FILES_PROVIDER || 'local',
  drive9Transport,
  analysisRunner,
  analysisSnapshot,
  analysisOptions,
  sqlExecute,
  zeroTransport,
  postgresProvider = process.env.WORKSPACE_POSTGRES_PROVIDER || 'disabled',
  db9Transport,
  postgresExecute,
  mysqlProvider = process.env.WORKSPACE_MYSQL_PROVIDER || 'local',
  duckdbExtensionPath,
  duckdbExtensionSha256,
  duckdbExecute,
  duckdbSourceDirectory,
  ssoConfig = loadSsoConfig(),
  ssoFetch = fetch,
  publicPath = ssoConfig?.publicPath ?? process.env.WORKSPACE_PUBLIC_PATH ?? '',
} = {}) {
  publicPath = publicPathPrefix(publicPath);
  if (!['local', drive9Provider].includes(filesProvider))
    throw new Error('Unknown File System provider.');
  const drive9 = await createDrive9({
    credentialsFile: dataFile + '.providers.json',
    transport: drive9Transport,
  });
  if (!['local', zeroProvider].includes(mysqlProvider)) throw new Error('Unknown MySQL provider.');
  const zero = await createZero({
    credentialsFile: dataFile + '.databases.json',
    transport: zeroTransport,
    execute: sqlExecute,
  });
  const duckdb = await createDuckdb({
    credentialsFile: dataFile + '.duckdb.json',
    drive9,
    extensionPath: duckdbExtensionPath,
    extensionSha256: duckdbExtensionSha256,
    execute: duckdbExecute,
  });
  if (!['disabled', db9Provider].includes(postgresProvider))
    throw new Error('Unknown PostgreSQL provider.');
  const db9 = await createDb9({
    credentialsFile: dataFile + '.db9.json',
    transport: db9Transport,
    execute: postgresExecute,
  });
  const databaseAdapter = (resource) =>
    resource.kind === 'duckdb' ? duckdb : resource.kind === 'postgresql' ? db9 : zero;
  const availableCapabilities = structuredClone(capabilities);
  Object.assign(availableCapabilities.postgresql, {
    provider: db9Provider,
    available: postgresProvider === db9Provider,
    regions: [db9Region],
  });
  availableCapabilities.duckdb.provider = duckdbProvider;
  availableCapabilities.duckdb.available = duckdb.available;
  availableCapabilities.filesystem.provider = filesProvider;
  availableCapabilities.mysql.provider = mysqlProvider;
  if (mysqlProvider === zeroProvider) {
    Object.assign(availableCapabilities.mysql, {
      regions: [zeroRegion],
      storageGiB: null,
      monthlyRU: null,
    });
  }
  if (filesProvider === drive9Provider) {
    availableCapabilities.filesystem.regions = [drive9Region];
    availableCapabilities.filesystem.storageGiB = null;
    availableCapabilities.filesystem.maxFiles = null;
  }
  const store = await createStore(dataFile);
  // Session store. Value: { expiresAt, principal, principalId, kind }. `kind` is 'demo' for the
  // local demo session and 'sso' for a verified TiDB Account session (distinct principal id).
  const sessions = new Map();
  const SESSION_TTL = 28800000; // 8 hours
  const liveSession = (token) => {
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  };
  const mintSession = ({ principal, principalId, kind }) => {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL, principal, principalId, kind });
    for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
    return token;
  };
  // Transient OIDC login flows keyed by an opaque id carried in a short-lived cookie.
  // Each entry holds { state, nonce, verifier, expiresAt }; pruned on use and on expiry.
  // Bounded to resist unauthenticated memory growth: TTL eviction + a hard capacity cap +
  // a coarse per-window rate limit on login initiation.
  const loginFlows = new Map();
  const LOGIN_FLOW_TTL = 600000; // 10 minutes
  const MAX_LOGIN_FLOWS = 500; // hard cap on concurrent pending logins
  const LOGIN_RATE_WINDOW = 60000; // 1 minute
  const LOGIN_RATE_MAX = 60; // max login initiations per window, PER SOURCE (not global)
  const MAX_RATE_SOURCES = 10000; // bounded memory: cap on distinct tracked sources
  // Per-source sliding window: source address -> { windowStart, count }. A single abusive source
  // can only 429 itself; it cannot lock out other clients (no process-global counter).
  const loginRate = new Map();
  const pruneLoginFlows = () => {
    for (const [id, flow] of loginFlows) if (flow.expiresAt <= Date.now()) loginFlows.delete(id);
  };
  const loginRateLimited = (source) => {
    const now = Date.now();
    // Drop windows that have fully elapsed, then bound the map size (evict oldest sources).
    for (const [key, entry] of loginRate)
      if (now - entry.windowStart >= LOGIN_RATE_WINDOW) loginRate.delete(key);
    while (loginRate.size >= MAX_RATE_SOURCES) {
      const oldest = loginRate.keys().next().value;
      if (oldest === undefined) break;
      loginRate.delete(oldest);
    }
    let entry = loginRate.get(source);
    if (!entry || now - entry.windowStart >= LOGIN_RATE_WINDOW) {
      entry = { windowStart: now, count: 0 };
      loginRate.set(source, entry);
    }
    entry.count += 1;
    return entry.count > LOGIN_RATE_MAX;
  };
  const admitLoginFlow = (id, flow) => {
    pruneLoginFlows();
    // Evict oldest entries until there is room, so the map can never exceed the cap.
    while (loginFlows.size >= MAX_LOGIN_FLOWS) {
      const oldest = loginFlows.keys().next().value;
      if (oldest === undefined) break;
      loginFlows.delete(oldest);
    }
    loginFlows.set(id, flow);
  };
  const fileAnalysis = createFileAnalysis({
    snapshot: analysisSnapshot || createAnalysisSnapshot({ store, drive9 }),
    runner: analysisRunner,
    ...analysisOptions,
  });
  function visibleState() {
    const state = store.read();
    const retired = new Set(
      state.resources
        .filter(
          (r) =>
            !Object.hasOwn(capabilities, r.kind) ||
            (r.kind === 'postgresql' && r.provider !== db9Provider),
        )
        .map((r) => r.id),
    );
    state.resources = state.resources.filter((r) => !retired.has(r.id));
    state.events = state.events.filter((e) => !retired.has(e.resourceId));
    return state;
  }
  async function recordQuery(resourceId, principal) {
    await store.mutate((draft) => {
      draft.queryCount++;
      draft.resourceQueryCounts ??= {};
      draft.resourceQueryCounts[resourceId] = (draft.resourceQueryCounts[resourceId] || 0) + 1;
      event(draft, 'query.executed', resourceId, principal, resourceId);
    });
  }
  async function updateProvider(resource, provision = false) {
    if (![drive9Provider, zeroProvider, duckdbProvider, db9Provider].includes(resource.provider))
      return resource;
    let info;
    try {
      info =
        resource.provider === db9Provider
          ? await (provision ? db9.provision(resource) : db9.status(resource.id))
          : resource.provider === duckdbProvider
            ? await (provision ? duckdb.provision(resource) : duckdb.status(resource.id))
            : resource.provider === zeroProvider
              ? await (provision ? zero.provision(resource) : zero.status(resource.id))
              : await (provision ? drive9.provision(resource.id) : drive9.status(resource.id));
    } catch (error) {
      info = {
        ...(resource.provider === db9Provider
          ? db9.status(resource.id)
          : resource.provider === zeroProvider
            ? zero.status(resource.id)
            : resource.provider === duckdbProvider
              ? await duckdb.status(resource.id)
              : {}),
        connectionError: error.message,
      };
    }
    return store.mutate((draft) => {
      const current = draft.resources.find((r) => r.id === resource.id);
      Object.assign(current, { connectionError: undefined }, info);
      return current;
    });
  }
  async function recordFile(action, resourceId, path, actor) {
    await store.mutate((draft) => event(draft, action, path, actor, resourceId));
  }
  const app = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (applyHttpPolicy(req, res, allowedOrigins, fail, publicOrigins)) return;
      const url = new URL(req.url, `http://${req.headers.host}`),
        path = url.pathname;
      if (path === '/api/health' && req.method === 'GET')
        return send(200, {
          status: 'ok',
          mode:
            filesProvider === drive9Provider ||
            store
              .read()
              .resources.some((r) =>
                [zeroProvider, duckdbProvider, db9Provider].includes(r.provider),
              )
              ? 'hybrid'
              : 'demo',
          filesProvider,
        });
      if (path === '/openapi.json' && req.method === 'GET') {
        const schema = JSON.parse(await readFile(resolve(root, 'public/openapi.json'), 'utf8'));
        return send(200, schema);
      }
      if (path === '/api/session' && req.method === 'POST') {
        await body(req);
        // When SSO is configured, the anonymous demo session is disabled so it cannot bypass
        // authentication. The demo session exists ONLY in local demo mode (SSO unconfigured).
        if (ssoConfig)
          fail(
            403,
            'SSO_REQUIRED',
            'Sign in with your TiDB Account. The anonymous demo session is disabled.',
          );
        // Host and forwarded headers are caller-controlled. Only the actual
        // loopback peer may acquire the anonymous local owner's credentials.
        if (!['127.0.0.1', '::1'].includes(clientSource(req)))
          fail(403, 'LOCAL_ONLY', 'The anonymous demo session requires a loopback connection.');
        const token = mintSession({
          principal: 'You',
          principalId: 'local-owner',
          kind: 'demo',
        });
        res.setHeader(
          'Set-Cookie',
          `aw_session=${token}; HttpOnly; SameSite=Strict; Path=${publicPath}/; Max-Age=28800`,
        );
        return send(200, { workspaceId, mode: 'demo' });
      }
      // ---- TiDB Cloud SSO (OAuth2 / OIDC authorization-code + PKCE) ----
      // These endpoints sit before the owner gate, like /api/session. They mint the SAME
      // aw_session cookie on success, so all owner-gated logic works unchanged.
      if (path === '/api/auth/config' && req.method === 'GET')
        return send(200, publicSsoInfo(ssoConfig));
      if (path === '/api/auth/tidbcloud/login' && req.method === 'GET') {
        if (!ssoConfig) fail(404, 'SSO_NOT_CONFIGURED', 'TiDB Cloud SSO is not configured.');
        if (loginRateLimited(clientSource(req, trustedProxyList)))
          fail(429, 'SSO_RATE_LIMITED', 'Too many sign-in attempts. Try again shortly.');
        const endpoints = await resolveEndpoints(ssoConfig, ssoFetch);
        const { verifier, challenge } = createPkcePair();
        const state = randomToken(),
          nonce = randomToken(),
          flowId = randomToken();
        admitLoginFlow(flowId, { state, nonce, verifier, expiresAt: Date.now() + LOGIN_FLOW_TTL });
        const authorizeUrl = buildAuthorizeUrl(ssoConfig, endpoints, {
          state,
          nonce,
          codeChallenge: challenge,
        });
        res.setHeader(
          'Set-Cookie',
          `aw_sso_flow=${flowId}; HttpOnly; SameSite=Lax;${ssoConfig.cookieSecure ? ' Secure;' : ''} Path=${publicPath}/api/auth/tidbcloud; Max-Age=600`,
        );
        res.writeHead(302, { Location: authorizeUrl });
        res.end();
        return;
      }
      if (path === '/api/auth/tidbcloud/callback' && req.method === 'GET') {
        if (!ssoConfig) fail(404, 'SSO_NOT_CONFIGURED', 'TiDB Cloud SSO is not configured.');
        const clearFlowCookie = `aw_sso_flow=; HttpOnly; SameSite=Lax;${ssoConfig.cookieSecure ? ' Secure;' : ''} Path=${publicPath}/api/auth/tidbcloud; Max-Age=0`;
        const flowId = /(?:^|; )aw_sso_flow=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        pruneLoginFlows();
        const flow = flowId && loginFlows.get(flowId);
        if (flowId) loginFlows.delete(flowId); // single-use
        // A provider that reports an error (e.g. access_denied) surfaces it on the callback.
        const providerError = url.searchParams.get('error');
        if (providerError) {
          res.setHeader('Set-Cookie', clearFlowCookie);
          fail(400, 'SSO_PROVIDER_ERROR', 'The identity provider reported an error.');
        }
        if (!flow || flow.expiresAt <= Date.now()) {
          res.setHeader('Set-Cookie', clearFlowCookie);
          fail(400, 'SSO_STATE_INVALID', 'No active login request; start sign-in again.');
        }
        const returnedState = url.searchParams.get('state');
        if (!returnedState || returnedState !== flow.state) {
          res.setHeader('Set-Cookie', clearFlowCookie);
          fail(400, 'SSO_STATE_MISMATCH', 'The login state did not match.');
        }
        const code = url.searchParams.get('code');
        if (!code) {
          res.setHeader('Set-Cookie', clearFlowCookie);
          fail(400, 'SSO_CODE_MISSING', 'The provider did not return an authorization code.');
        }
        const endpoints = await resolveEndpoints(ssoConfig, ssoFetch);
        let identity;
        try {
          const tokens = await exchangeCode(
            ssoConfig,
            endpoints,
            { code, codeVerifier: flow.verifier },
            ssoFetch,
          );
          const idClaims = await verifyIdToken(ssoConfig, endpoints, tokens.id_token, flow.nonce);
          // Signature/issuer/audience/nonce verification is complete here. resolveIdentity then
          // derives the auditable subject and applies DEFAULT-DENY owner authorization: it throws
          // (no session minted) for an unverified user-id claim, an org-filter miss, or a subject
          // absent from both the exact-subject and verified-email owner grants.
          identity = resolveIdentity(ssoConfig, idClaims);
        } catch (error) {
          res.setHeader('Set-Cookie', clearFlowCookie);
          // A valid-but-unauthorized account gets a distinct, clear error from a bad credential.
          if (error.ssoError === 'not_authorized' || error.ssoError === 'org_not_allowed')
            fail(403, 'SSO_NOT_AUTHORIZED', 'This account is not authorized for this workspace.');
          fail(401, 'SSO_VERIFICATION_FAILED', 'Could not verify the TiDB Account sign-in.');
        }
        // Mint an owner session bound to the distinct, auditable SSO principal (never local-owner).
        const token = mintSession({
          principal: identity.principal,
          principalId: identity.principalId,
          kind: 'sso',
        });
        // Redirect allowlist: only the configured, same-origin post-login URL is permitted.
        res.writeHead(302, {
          Location: ssoConfig.postLoginUrl,
          'Set-Cookie': [
            `aw_session=${token}; HttpOnly; SameSite=Strict;${ssoConfig.cookieSecure ? ' Secure;' : ''} Path=${publicPath}/; Max-Age=28800`,
            clearFlowCookie,
          ],
        });
        res.end();
        return;
      }
      if (path === '/api/auth/tidbcloud/logout' && ['GET', 'POST'].includes(req.method)) {
        const sessionToken = /(?:^|; )aw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        if (sessionToken) sessions.delete(sessionToken);
        res.setHeader(
          'Set-Cookie',
          `aw_session=; HttpOnly; SameSite=Strict;${ssoConfig?.cookieSecure ? ' Secure;' : ''} Path=${publicPath}/; Max-Age=0`,
        );
        if (req.method === 'GET' && ssoConfig) {
          res.writeHead(302, { Location: ssoConfig.postLoginUrl });
          res.end();
          return;
        }
        return send(200, { loggedOut: true });
      }
      if (!path.startsWith('/api/'))
        fail(404, 'NOT_FOUND', 'This service provides the Workspace API only.');
      let state = visibleState();
      const sessionToken = /(?:^|; )aw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const session = liveSession(sessionToken);
      let isOwner = !!session;
      // Owner identity comes from the session: the generic local-owner for a demo session, or the
      // distinct, auditable SSO principal for a TiDB Account session. API keys override below.
      let principal = session?.principal || 'You',
        principalId = session?.principalId || 'local-owner',
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
        await Promise.all(
          state.resources
            .filter((r) =>
              [drive9Provider, zeroProvider, duckdbProvider, db9Provider].includes(r.provider),
            )
            .map((r) => updateProvider(r)),
        );
        state = visibleState();
        return send(200, {
          ...state,
          files: state.files.map(fileView),
          keys: state.keys.map(keyView),
          idempotency: undefined,
          capabilities: availableCapabilities,
          usage: usage(state),
          mode: state.resources.some((r) =>
            [drive9Provider, zeroProvider, duckdbProvider, db9Provider].includes(r.provider),
          )
            ? 'hybrid'
            : 'demo',
        });
      }
      if (route === '/resources' && req.method === 'GET') {
        requireScope('resources:read');
        const resources = await Promise.all(
          state.resources.filter((r) => hasResource(r.id)).map((r) => updateProvider(r)),
        );
        return send(200, { data: resources, capabilities: availableCapabilities });
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
        if (
          !Object.hasOwn(capabilities, input.kind) ||
          (input.kind === 'postgresql' && postgresProvider !== db9Provider)
        )
          fail(
            400,
            'INVALID_KIND',
            'Choose an available mysql, postgresql, duckdb or filesystem resource.',
          );
        if (typeof input.name !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(input.name))
          fail(
            400,
            'INVALID_NAME',
            'Use 3–40 lowercase letters, numbers, and hyphens; start with a letter.',
          );
        if (!availableCapabilities[input.kind].regions.includes(input.region))
          fail(400, 'UNSUPPORTED_REGION', 'This region is not available for this resource.');
        if (input.kind === 'duckdb') await duckdb.verifyRuntime();
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
            return draft.resources.find((r) => r.id === previous.resource.id) || previous.resource;
          }
          if (draft.resources.some((r) => r.name === input.name))
            fail(409, 'NAME_EXISTS', 'A resource with this name already exists.');
          if (
            input.kind === 'filesystem' &&
            draft.resources.some(
              (r) =>
                r.kind === 'filesystem' &&
                r.region === input.region &&
                (r.provider || 'local') === filesProvider,
            )
          )
            fail(
              409,
              'FREE_TIER_LIMIT',
              'One File System per provider and region is supported in this prototype. Use the existing File System.',
            );
          const limit = 5;
          if (
            input.kind !== 'filesystem' &&
            draft.resources.filter(
              (r) =>
                r.kind === input.kind &&
                (input.kind !== 'postgresql' || r.provider === db9Provider),
            ).length >= limit
          )
            fail(
              409,
              'FREE_TIER_LIMIT',
              'This prototype supports at most five database resources. Use an existing database.',
            );
          const resource = {
            id: `${input.kind === 'filesystem' ? 'fs' : 'db'}_${randomBytes(6).toString('hex')}`,
            name: input.name,
            kind: input.kind,
            region: input.region,
            status:
              (input.kind === 'filesystem' && filesProvider === drive9Provider) ||
              (input.kind === 'mysql' && mysqlProvider === zeroProvider) ||
              input.kind === 'postgresql' ||
              input.kind === 'duckdb'
                ? 'provisioning'
                : 'active',
            provider:
              input.kind === 'filesystem'
                ? filesProvider
                : input.kind === 'duckdb'
                  ? duckdbProvider
                  : input.kind === 'postgresql'
                    ? db9Provider
                    : mysqlProvider,
            createdAt: new Date().toISOString(),
          };
          draft.resources.push(resource);
          event(draft, 'resource.created', resource.name, principal, resource.id);
          if (idem) draft.idempotency[idemSlot] = { fingerprint, resource };
          return resource;
        });
        return send(201, {
          data: await updateProvider(resource, true),
          mode: [drive9Provider, zeroProvider, duckdbProvider, db9Provider].includes(
            resource.provider,
          )
            ? 'live'
            : 'demo',
        });
      }
      const setupMatch = /^\/resources\/([^/]+)\/setup$/.exec(route);
      if (setupMatch && req.method === 'POST') {
        requireScope('resources:write');
        const resource = requireResource(setupMatch[1]);
        if (![zeroProvider, duckdbProvider, db9Provider].includes(resource.provider))
          fail(400, 'UNSUPPORTED_PROVIDER', 'Setup is available only for managed databases.');
        return send(200, { data: await updateProvider(resource, true) });
      }
      if (
        (route === '/file-analyses/capabilities' && req.method === 'GET') ||
        (route === '/file-analyses' && req.method === 'POST')
      ) {
        requireScope('files:read');
        const execute = req.method === 'POST';
        if (execute) requireScope('files:analyze');
        const input = execute ? await body(req) : Object.fromEntries(url.searchParams);
        const resource = requireResource(input.resourceId, 'filesystem');
        input.path = cleanPath(input.path);
        if (resource.status !== 'active')
          fail(409, 'FILESYSTEM_UNAVAILABLE', 'This File System is not active.');
        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.on('close', onClose);
        try {
          const result = execute
            ? await fileAnalysis.execute(resource, input, controller.signal)
            : await fileAnalysis.capabilities(
                resource,
                input.path,
                AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
              );
          if (execute) await recordFile('file.analyzed', resource.id, input.path, principal);
          return send(200, result);
        } finally {
          res.off('close', onClose);
        }
      }
      if (route === '/files' && req.method === 'GET') {
        requireScope('files:read');
        const resourceId = url.searchParams.get('resourceId');
        const resource = requireResource(resourceId, 'filesystem');
        const directory = url.searchParams.has('path')
          ? cleanPath(url.searchParams.get('path'))
          : null;
        if (resource.provider === drive9Provider)
          return send(200, { data: await drive9.list(resourceId, directory || '/') });
        return send(200, {
          data: state.files
            .filter(
              (f) =>
                f.resourceId === resourceId &&
                (!directory || (f.path.slice(0, f.path.lastIndexOf('/')) || '/') === directory),
            )
            .map(fileView),
        });
      }
      if (route === '/files/content' && ['GET', 'PUT'].includes(req.method)) {
        requireScope(req.method === 'GET' ? 'files:read' : 'files:write');
        const resourceId = url.searchParams.get('resourceId');
        const resource = requireResource(resourceId, 'filesystem');
        const targetPath = cleanPath(url.searchParams.get('path'));
        if (targetPath === '/') fail(400, 'INVALID_PATH', 'Select a file.');
        if (resource.provider !== drive9Provider)
          fail(400, 'LOCAL_FILE_API', 'Use the JSON files endpoint for local files.');
        if (req.method === 'PUT') {
          const bytes = await readUpload(req);
          await drive9.write(resourceId, targetPath, bytes, req.headers['if-none-match'] === '*');
          await recordFile('file.uploaded', resourceId, targetPath, principal);
          return send(200, { saved: true, size: bytes.length });
        }
        if (url.searchParams.get('preview') === '1')
          return send(200, await previewFile(drive9, resourceId, targetPath));
        await downloadFile(drive9, resourceId, targetPath, res);
        return;
      }
      if (route === '/files' && req.method === 'PUT') {
        requireScope('files:write');
        const input = await body(req),
          targetPath = cleanPath(input.path);
        const resource = requireResource(input.resourceId, 'filesystem');
        if (targetPath === '/') fail(400, 'INVALID_PATH', 'Choose a file or directory name.');
        if (!['file', 'directory'].includes(input.type))
          fail(400, 'INVALID_TYPE', 'Choose file or directory.');
        if (
          input.type === 'file' &&
          (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 256 * 1024)
        )
          fail(413, 'FILE_TOO_LARGE', 'The JSON endpoint supports UTF-8 text files up to 256 KiB.');
        if (resource.provider === drive9Provider) {
          if (input.type === 'directory') await drive9.mkdir(resource.id, targetPath);
          else await drive9.write(resource.id, targetPath, Buffer.from(input.content));
          await recordFile(
            input.type === 'directory' ? 'directory.created' : 'file.saved',
            resource.id,
            targetPath,
            principal,
          );
          return send(200, {
            data: {
              id: `${resource.id}:${targetPath}`,
              resourceId: resource.id,
              path: targetPath,
              type: input.type,
              size: input.type === 'file' ? Buffer.byteLength(input.content) : 0,
              updatedAt: new Date().toISOString(),
            },
          });
        }
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
        const resource = requireResource(input.resourceId, 'filesystem');
        if (targetPath === '/') fail(400, 'INVALID_PATH', 'The root directory cannot be deleted.');
        if (resource.provider === drive9Provider) {
          await drive9.remove(resource.id, targetPath);
          await recordFile('file.deleted', resource.id, targetPath, principal);
          return send(200, { deleted: true });
        }
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
      const browseMatch = /^\/resources\/([^/]+)\/(tables|table|table\/rows)$/.exec(route);
      if (browseMatch && req.method === 'GET') {
        requireScope('queries:execute');
        const resource = requireResource(browseMatch[1]);
        if (resource.kind === 'filesystem') fail(404, 'NOT_FOUND', 'Database not found.');
        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.on('close', onClose);
        try {
          return send(
            200,
            await browseDatabase({
              resource,
              action: browseMatch[2] === 'table/rows' ? 'rows' : browseMatch[2],
              name: url.searchParams.get('name'),
              createdAt: state.workspace.createdAt,
              execute: (sql) =>
                resource.kind === 'duckdb'
                  ? duckdb.catalog(resource, sql, controller.signal)
                  : databaseAdapter(resource).execute(resource, sql, controller.signal),
            }),
          );
        } finally {
          res.off('close', onClose);
        }
      }
      if (route === '/queries' && req.method === 'POST') {
        requireScope('queries:execute');
        const input = await body(req);
        const resource = requireResource(input.resourceId);
        if (resource.kind === 'filesystem') fail(404, 'NOT_FOUND', 'Database not found.');
        const sources = parseSources(input.sources);
        if (sources.length && resource.provider !== duckdbProvider)
          fail(
            400,
            'SOURCES_REQUIRE_DUCKDB',
            'File sources are available only on DuckDB databases.',
          );
        const authorizeSources = () => {
          if (!sources.length) return;
          const current = visibleState();
          const key = isOwner ? undefined : current.keys.find((key) => key.id === principalId);
          if (
            isOwner
              ? !liveSession(sessionToken)
              : !key || key.revokedAt || Date.parse(key.expiresAt) <= Date.now()
          )
            fail(401, 'INVALID_KEY', 'The session or key is invalid, expired, or revoked.');
          for (const action of ['queries:execute', 'files:read', 'files:analyze'])
            if (!isOwner && !key.scopes.includes(action))
              fail(403, 'INSUFFICIENT_SCOPE', `This action requires ${action}.`);
          for (const [id, kind] of [
            [resource.id, 'duckdb'],
            ...sources.map((source) => [source.resourceId, 'filesystem']),
          ]) {
            if (!isOwner && !canAccessResource(key.resourceIds, id))
              fail(
                403,
                'RESOURCE_ACCESS_DENIED',
                'This key cannot access a selected query resource.',
              );
            const selected = current.resources.find((item) => item.id === id && item.kind === kind);
            if (!selected) fail(404, 'NOT_FOUND', 'A selected resource is unavailable.');
            if (selected.status !== 'active')
              fail(409, 'SOURCE_UNAVAILABLE', 'Wait until every selected resource is active.');
          }
        };
        authorizeSources();
        const selectedSources = sources.map((source) => ({
          ...source,
          resource: requireResource(source.resourceId, 'filesystem'),
        }));
        if ([zeroProvider, duckdbProvider, db9Provider].includes(resource.provider)) {
          if (resource.status === 'expired')
            fail(
              410,
              'DATABASE_EXPIRED',
              'This Zero database has expired. Its data is no longer available.',
            );
          if (resource.status !== 'active')
            fail(409, 'DATABASE_UNAVAILABLE', 'This database is not active.');
          const controller = new AbortController();
          const onClose = () => controller.abort();
          res.on('close', onClose);
          try {
            const result = await databaseAdapter(resource).execute(
              resource,
              input.sql,
              controller.signal,
              sources.length
                ? (signal) =>
                    stageSources(selectedSources, {
                      drive9,
                      readState: () => store.read(),
                      authorize: authorizeSources,
                      signal,
                      directory: duckdbSourceDirectory,
                    })
                : undefined,
            );
            authorizeSources();
            try {
              await recordQuery(resource.id, principal);
            } catch {
              fail(
                500,
                'QUERY_RECORD_FAILED',
                'SQL completed, but its activity record could not be saved. Do not repeat a write; refresh the workspace instead.',
              );
            }
            authorizeSources();
            return send(200, result);
          } finally {
            res.off('close', onClose);
          }
        }
        if (resource.provider && resource.provider !== 'local')
          fail(503, 'DATABASE_NOT_CONFIGURED', 'This database provider is not configured.');
        const sql = String(input.sql || '')
          .trim()
          .replace(/;$/, '')
          .trim();
        let columns, rows;
        if (/^select\s+1(?:\s+as\s+connected)?$/i.test(sql)) {
          columns = ['connected'];
          rows = [{ connected: 1 }];
        } else if (
          /^select\s+\*\s+from\s+(?:agent_events|`agent_events`)(?:\s+limit\s+(\d{1,3}))?$/i.test(
            sql,
          )
        ) {
          columns = demoColumns;
          const limit = Math.min(Number(/limit\s+(\d+)/i.exec(sql)?.[1] || 10), 100);
          rows = demoRows(state.workspace.createdAt).slice(0, limit);
        } else
          fail(
            422,
            'DEMO_QUERY_ONLY',
            'The local provider supports SELECT 1 and SELECT * FROM agent_events LIMIT n. Connect a cloud provider to execute arbitrary SQL.',
          );
        await recordQuery(input.resourceId, principal);
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
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      send(error.status || 500, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: error.status ? error.message : 'An unexpected error occurred.',
          requestId,
        },
      });
    }
  });
  app.on('close', () => {
    void duckdb.close();
  });
  return app;
}
export async function startServer(options = {}) {
  const host = options.host ?? process.env.WORKSPACE_API_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host))
    throw new Error('WORKSPACE_API_HOST must be 127.0.0.1 or 0.0.0.0.');
  const server = await createApp(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? Number(process.env.WORKSPACE_API_PORT || 4318), host, resolve);
  });
  console.log(`Workspace API: http://${host}:${server.address().port}`);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startServer();
