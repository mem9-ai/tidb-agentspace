import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const globalContract = JSON.parse(
  await readFile(new URL('../public/agent-entry-openapi.json', import.meta.url), 'utf8'),
);
const regionalContract = JSON.parse(
  await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'),
);

const createdAt = '2026-01-01T00:00:00.000Z';
export const sampleResources = [
  { id: 'db_fixture', name: 'postgresql-fixture', kind: 'postgresql', region: 'automatic' },
  {
    id: 'fs_fixture',
    name: 'filesystem-fixture',
    kind: 'filesystem',
    region: 'aws-ap-southeast-1',
  },
].map((resource) => ({
  ...resource,
  regionId: 'region:local',
  provider: 'local',
  status: 'active',
  createdAt,
}));
const content = '# Fixture file\n\nRendered Markdown for **agents**.\n';

function bootstrap() {
  return {
    workspace: {
      id: 'ws_personal_fixture',
      name: 'My Workspace',
      description: '',
      defaultRegionId: 'region:local',
      plan: 'Free',
      createdAt,
    },
    profile: { name: 'Fixture owner', email: '', role: 'Local developer' },
    resources: [],
    files: [],
    keys: [],
    events: [],
    usage: [],
    queryCount: 0,
    mode: 'demo',
    capabilities: Object.fromEntries(
      ['mysql', 'postgresql', 'duckdb', 'filesystem'].map((kind) => [
        kind,
        {
          label: kind,
          regions:
            kind === 'mysql' || kind === 'postgresql' ? ['automatic'] : ['aws-ap-southeast-1'],
          storageGiB: 2,
          monthlyRU: 50000000,
          preview: kind !== 'mysql',
          available: kind !== 'mysql' && kind !== 'duckdb',
          provider: kind === 'mysql' ? 'tidb-cloud-zero' : 'local',
        },
      ]),
    ),
  };
}

export const test = base.extend({
  workspace: async ({ context, page }, use, testInfo) => {
    const state = bootstrap();
    const requests = [];
    const unexpected = [];
    const tutorials = new Map();
    const history = { audit: [], requests: [], retention: {} };
    const historyPages = { audit: new Map(), requests: new Map() };
    let tutorialRevision = 0;
    let rejectAutomaticName = false;
    let salesSample = null;
    let signInRequired = false;
    let guestEnabled = false;
    let guestCleanupEnabled = false;
    let signedInAsGuest = false;
    let signedInAsAccount = false;
    let rejectGuestLogout = false;
    const resourcePages = new Map();
    const keyPages = new Map();
    page.on('pageerror', (error) => unexpected.push(error.message));
    const handler = async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:4389') {
        unexpected.push(`External request blocked: ${url.origin}`);
        return route.abort();
      }
      if (url.pathname === '/openapi.json') return route.fulfill({ json: regionalContract });
      if (url.pathname === '/api/openapi.json') return route.fulfill({ json: globalContract });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/global/analytics/config')
        return route.fulfill({
          json: { enabled: false, campaigns: [], policy: 'session_only', version: 1 },
        });
      const method = request.method();
      const body = request.postDataJSON();
      requests.push({
        path: url.pathname,
        method,
        body,
        query: Object.fromEntries(url.searchParams),
      });
      const reply = (json, status = 200) => route.fulfill({ status, json });
      if (url.pathname === '/api/global/api/auth/session')
        return reply({ workspaceId: state.workspace.id, regionId: 'region:fixture' });
      if (url.pathname === '/api/auth/config')
        return reply(
          signInRequired || signedInAsGuest || signedInAsAccount
            ? {
                ...(!state.globalApiUnavailable && {
                  globalApi: { apiOrigin: url.origin, apiPathPrefix: '/api/global' },
                }),
                regionId: 'region:fixture',
                enabled: true,
                loginPath: '/api/auth/tidbcloud/login',
                logoutPath: '/api/auth/tidbcloud/logout',
                guestEnabled,
                guestCleanupEnabled,
                ...(signedInAsGuest ? { sessionKind: 'guest' } : {}),
                ...(signedInAsAccount ? { sessionKind: 'account' } : {}),
              }
            : {
                enabled: false,
                ...(!state.globalApiUnavailable && {
                  globalApi: { apiOrigin: url.origin, apiPathPrefix: '/api/global' },
                }),
                regionId: 'region:fixture',
              },
        );
      if (url.pathname === '/api/auth/guest' && method === 'POST' && guestEnabled) {
        signInRequired = false;
        signedInAsGuest = true;
        return reply({ workspaceId: state.workspace.id });
      }
      if (url.pathname === '/api/auth/guest/logout' && method === 'POST' && signedInAsGuest) {
        if (rejectGuestLogout) {
          rejectGuestLogout = false;
          return reply({ error: { code: 'UNAVAILABLE', message: 'Cleanup unavailable' } }, 503);
        }
        signedInAsGuest = false;
        signInRequired = true;
        return reply({ loggedOut: true, cleanup: 'scheduled' });
      }
      if (url.pathname === '/api/auth/tidbcloud/login') return reply({ fixture: 'login' });
      if (url.pathname === '/api/session') return reply({ ok: true });
      if (url.pathname === '/api/portal/v1/workspaces' && method === 'GET')
        return signInRequired
          ? reply({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401)
          : reply({ data: [state.workspace] });
      const path = url.pathname
        .replace('/api/global', '')
        .replace('/api/portal/v1/', '/api/v1/')
        .replace(`/api/v1/workspaces/${state.workspace.id}`, '');
      if (method === 'GET' && ['/audit-history', '/request-history'].includes(path)) {
        const kind = path === '/audit-history' ? 'audit' : 'requests';
        const cursor = url.searchParams.get('cursor');
        const result = cursor
          ? historyPages[kind].get(cursor)
          : historyPages[kind].get('') || { data: history[kind], nextCursor: null };
        if (!result)
          return reply({ error: { code: 'HISTORY_CURSOR_EXPIRED', message: 'Page expired' } }, 410);
        return reply({
          ...result,
          coverage: {
            status: 'partial',
            startedAt: null,
            operations: [],
            exclusions: [
              kind === 'audit'
                ? 'Global Key activity is not included'
                : 'Global requests are not included',
              'Some outcomes are unknown',
            ],
          },
          retention: {
            maxAgeDays: kind === 'audit' ? 30 : 7,
            maxRecords: 100000,
            earliestAt: null,
            truncated: null,
            ...history.retention[kind],
          },
          health: { status: 'unknown', droppedCount: null, lossDetectedAt: null },
        });
      }
      if (path === '/bootstrap') {
        return reply({
          ...state,
          files: [],
        });
      }
      if (path === '/tutorials' && method === 'GET')
        return reply({
          data: [...tutorials.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
          nextCursor: null,
        });
      if (path.startsWith('/tutorials/') && method === 'PUT') {
        const resourceId = path.split('/').at(-1);
        const prior = tutorials.get(resourceId);
        const headers = request.headers();
        if (prior ? headers['if-match'] !== prior.version : headers['if-none-match'] !== '*')
          return reply(
            { error: { code: 'PRECONDITION_FAILED', message: 'Tutorial changed' } },
            412,
          );
        const record = {
          ...body,
          resourceId,
          version: '"tutorial-' + (++tutorialRevision).toString(16).padStart(32, '0') + '"',
          updatedAt: createdAt,
        };
        tutorials.set(resourceId, record);
        return reply({ data: record }, prior ? 200 : 201);
      }
      if (path === '/sales-sample-attempts' && method === 'GET')
        return reply({ data: salesSample ? [salesSample] : [] });
      if (path === '/sales-sample-attempts' && method === 'POST') {
        const resource = (body.resourceId &&
          state.resources.find((item) => item.id === body.resourceId)) || {
          id: 'fs_sales',
          name: 'sales-workspace',
          kind: 'filesystem',
          region: 'aws-ap-southeast-1',
          regionId: 'region:local',
          provider: 'local',
          status: 'active',
          createdAt,
        };
        if (!body.resourceId) state.resources.push(resource);
        state.files.push({
          id: 'sales-file',
          resourceId: resource.id,
          path: '/us-sales.csv',
          type: 'file',
          content: 'state,sales_usd\nCalifornia,48000\n',
          size: 35,
          version: '"sales-version"',
          updatedAt: createdAt,
        });
        salesSample = {
          id: 'a1b2c3d4-1111-4111-8111-111111111111',
          fixture: 'us-sales-v1',
          status: 'ready',
          resourceId: resource.id,
          path: '/us-sales.csv',
          fileVersion: '"sales-version"',
          errorCode: null,
          createdAt,
          updatedAt: createdAt,
        };
        return reply({ data: salesSample }, 201);
      }
      if (path === '/files/metadata' && method === 'GET') {
        const file = state.files.find(
          (item) =>
            item.resourceId === url.searchParams.get('resourceId') &&
            item.path === url.searchParams.get('path'),
        );
        return file
          ? reply({
              data: {
                resourceId: file.resourceId,
                path: file.path,
                type: file.type,
                size: file.size,
                version: file.version || '"fixture-version"',
                conditionalWrites: true,
              },
            })
          : reply({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      }
      if (
        path === '/files/tabular-preview' &&
        method === 'GET' &&
        url.searchParams.get('resourceId') === 'fs_sales' &&
        url.searchParams.get('path') === '/us-sales.csv'
      )
        return reply({
          columns: ['state', 'sales_usd'],
          columnTypes: ['VARCHAR', 'BIGINT'],
          schema: [
            { column_name: 'state', column_type: 'VARCHAR' },
            { column_name: 'sales_usd', column_type: 'BIGINT' },
          ],
          rows: [{ state: 'California', sales_usd: '48000' }],
          rowCount: 1,
          totalRows: null,
          typesInferred: true,
          truncated: false,
        });
      if (path === '/resources' && method === 'POST') {
        if (body.onlyIfNew) {
          const existing = state.resources.find((item) => item.isDefault);
          if (existing) return reply({ data: existing, mode: 'demo' }, 201);
          if (state.resources.length)
            return reply(
              { error: { code: 'WORKSPACE_NOT_NEW', message: 'Workspace is not new' } },
              409,
            );
          const resource = {
            id: 'fs_sales',
            name: body.name,
            kind: 'filesystem',
            region: body.region,
            regionId: state.workspace.defaultRegionId,
            provider: 'local',
            status: 'active',
            isDefault: true,
            createdAt,
          };
          state.resources.push(resource);
          return reply({ data: resource, mode: 'demo' }, 201);
        }
        if (rejectAutomaticName) {
          rejectAutomaticName = false;
          return reply({ error: { code: 'NAME_EXISTS', message: 'Fixture conflict' } }, 409);
        }
        const resource = {
          ...body,
          regionId: state.workspace.defaultRegionId,
          id: `fixture_${body.kind}_${state.resources.length}`,
          status: 'active',
          provider: 'local',
          createdAt,
        };
        state.resources.push(resource);
        return reply({ data: resource, mode: 'demo' }, 201);
      }
      if (path === '/resources') {
        const cursor = url.searchParams.get('cursor');
        if (cursor && resourcePages.has(cursor)) return reply(resourcePages.get(cursor));
        return reply({ data: state.resources, capabilities: state.capabilities, nextCursor: null });
      }
      if (path === '/usage')
        return reply({
          data: state.usage,
          mode: 'demo',
          queryCount: state.queryCount,
          queryCountScope: 'workspace',
          nextCursor: null,
        });
      if (path === '/files' && method === 'GET') {
        const resourceId = url.searchParams.get('resourceId');
        const folder = url.searchParams.get('path');
        const offset = Number(url.searchParams.get('cursor') || 0);
        const matching = state.files.filter(
          (file) =>
            file.resourceId === resourceId &&
            (!folder || (file.path.slice(0, file.path.lastIndexOf('/')) || '/') === folder),
        );
        return reply({
          data: matching.slice(offset, offset + 32),
          nextCursor: offset + 32 < matching.length ? String(offset + 32) : null,
        });
      }
      if (path === '/files/content' && method === 'GET') {
        const file = state.files.find(
          (item) =>
            item.resourceId === url.searchParams.get('resourceId') &&
            item.path === url.searchParams.get('path'),
        );
        return file
          ? reply({ content: file.content || '', size: Buffer.byteLength(file.content || '') })
          : reply({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      }
      if (method === 'GET' && /^\/resources\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.slice('/resources/'.length));
        const resource = [
          ...state.resources,
          ...[...resourcePages.values()].flatMap((entry) => entry.data),
        ].find((item) => item.id === id);
        return resource
          ? reply({ data: resource })
          : reply({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      }
      if (path === '/queries' && method === 'POST')
        return reply({
          columns: ['event'],
          rows: [{ event: 'agent_started' }],
          rowCount: 1,
          mode: 'demo',
          durationMs: 1,
        });
      if (/\/tables$/.test(path)) return reply({ data: [], mode: 'demo', truncated: false });
      const summary = (key) => ({
        data: {
          workspaceId: state.workspace.id,
          keyId: key.id,
          name: key.name,
          createdAt: Math.floor(Date.parse(key.createdAt) / 1000),
          keyVersion: 1,
          principalId: 'fixture-owner',
          grantRef: 'fixture-grant',
          expiresAt: Math.floor(Date.parse(key.expiresAt) / 1000),
          revoked: Boolean(key.revokedAt),
        },
        grants: { scopes: key.scopes, resourceIds: key.resourceIds, regionId: 'region:fixture' },
        regionalStatus: key.regionalStatus || 'applied',
      });
      if (path === '/key-policy-deliveries' && method === 'POST') {
        const key = state.keys.find((key) => key.id === body.keyId);
        key.regionalStatus = 'applied';
        return reply(
          {
            data: {
              id: 'fixture-delivery',
              keyId: key.id,
              keyVersion: body.keyVersion,
              regionalStatus: 'applied',
              regionalContinuity: 'unavailable',
            },
          },
          201,
        );
      }
      if (path === '/keys' && method === 'GET') {
        const cursor = url.searchParams.get('cursor');
        const value = (cursor && keyPages.get(cursor)) || {
          data: state.keys,
          nextCursor: state.keysNextCursor || null,
        };
        return reply({ ...value, data: value.data.map(summary) });
      }
      if (path.startsWith('/keys/') && method === 'GET')
        return reply(summary(state.keys.find((key) => key.id === path.slice('/keys/'.length))));
      if (path === '/keys' && method === 'POST') {
        const key = {
          ...body,
          id: 'key_fixture',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(body.expiresAt * 1000).toISOString(),
          revokedAt: null,
          regionalStatus: state.keyCreateRegionalStatus || 'applied',
        };
        state.keys.push(key);
        return reply(
          { ...summary(key), secret: 'synthetic-browser-key-never-valid-on-a-provider' },
          201,
        );
      }
      if (path === '/file-analyses/capabilities')
        return reply({
          available: false,
          engine: null,
          engines: [],
          reason: 'Fixture preview only',
        });
      unexpected.push(`Unexpected fixture route: ${method} ${path}`);
      return reply(
        { error: { code: 'FIXTURE_ROUTE_MISSING', message: 'Unexpected request' } },
        501,
      );
    };
    await context.route('**/*', handler);
    await use({
      state,
      history,
      setHistoryPage(kind, cursor, data, nextCursor = null) {
        historyPages[kind].set(cursor, { data, nextCursor });
      },
      requests,
      setResourcePage(cursor, data, nextCursor = null) {
        resourcePages.set(cursor, { data, nextCursor, capabilities: state.capabilities });
      },
      setKeyPage(cursor, data, nextCursor = null) {
        keyPages.set(cursor, { data, nextCursor });
      },
      tutorials,
      async connectContext(otherContext) {
        otherContext.on('page', (otherPage) =>
          otherPage.on('pageerror', (error) => unexpected.push(error.message)),
        );
        await otherContext.route('**/*', handler);
      },
      signInAsAccount() {
        signedInAsAccount = true;
      },
      requireSignIn(options = {}) {
        signInRequired = true;
        guestEnabled = options.guestEnabled === true;
        guestCleanupEnabled = options.guestCleanupEnabled ?? guestEnabled;
      },
      rejectNextGuestLogout() {
        rejectGuestLogout = true;
      },
      rejectNextName() {
        rejectAutomaticName = true;
      },
      addResources() {
        state.resources = structuredClone(sampleResources);
        state.files = [
          {
            id: 'file_fixture',
            resourceId: 'fs_fixture',
            path: '/README.md',
            type: 'file',
            content,
            size: Buffer.byteLength(content),
            updatedAt: createdAt,
          },
        ];
      },
      async open(hash = '#overview') {
        await page.goto('/' + hash);
        await expect(
          page.getByRole('combobox', { name: 'Color theme', exact: true }),
        ).toBeVisible();
        await page
          .getByRole('combobox', { name: 'Color theme', exact: true })
          .selectOption(testInfo.project.metadata.theme);
        await expect(page.getByRole('main')).toBeVisible();
      },
    });
    expect(unexpected, 'Browser errors and unhandled/external requests').toEqual([]);
  },
});

export { expect };
