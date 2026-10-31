import { test as base, expect } from '@playwright/test';

const createdAt = '2026-01-01T00:00:00.000Z';
export const sampleResources = [
  { id: 'db_fixture', name: 'mysql-fixture', kind: 'mysql', region: 'automatic' },
  {
    id: 'fs_fixture',
    name: 'filesystem-fixture',
    kind: 'filesystem',
    region: 'aws-ap-southeast-1',
  },
].map((resource) => ({ ...resource, provider: 'local', status: 'active', createdAt }));
const content = '# Fixture file\n\nRendered Markdown for **agents**.\n';

function bootstrap() {
  return {
    workspace: {
      id: 'ws_personal_fixture',
      name: 'Browser fixture',
      description: '',
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
          available: true,
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
    let tutorialRevision = 0;
    let rejectAutomaticName = false;
    let signInRequired = false;
    let guestEnabled = false;
    let guestCleanupEnabled = false;
    let signedInAsGuest = false;
    let signedInAsAccount = false;
    let rejectGuestLogout = false;
    page.on('pageerror', (error) => unexpected.push(error.message));
    const handler = async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:4389') {
        unexpected.push(`External request blocked: ${url.origin}`);
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const method = request.method();
      const body = request.postDataJSON();
      requests.push({ path: url.pathname, method, body });
      const reply = (json, status = 200) => route.fulfill({ status, json });
      if (url.pathname === '/api/auth/config')
        return reply(
          signInRequired || signedInAsGuest || signedInAsAccount
            ? {
                enabled: true,
                loginPath: '/api/auth/tidbcloud/login',
                logoutPath: '/api/auth/tidbcloud/logout',
                guestEnabled,
                guestCleanupEnabled,
                ...(signedInAsGuest ? { sessionKind: 'guest' } : {}),
                ...(signedInAsAccount ? { sessionKind: 'account' } : {}),
              }
            : { enabled: false },
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
      if (url.pathname === '/api/v1/workspaces' && method === 'GET')
        return signInRequired
          ? reply({ error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }, 401)
          : reply({ data: [state.workspace] });
      const path = url.pathname.replace(`/api/v1/workspaces/${state.workspace.id}`, '');
      if (path === '/bootstrap') return reply(state);
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
      if (path === '/resources' && method === 'POST') {
        if (rejectAutomaticName) {
          rejectAutomaticName = false;
          return reply({ error: { code: 'NAME_EXISTS', message: 'Fixture conflict' } }, 409);
        }
        const resource = {
          ...body,
          id: `fixture_${body.kind}_${state.resources.length}`,
          status: 'active',
          provider: 'local',
          createdAt,
        };
        state.resources.push(resource);
        return reply({ data: resource, mode: 'demo' }, 201);
      }
      if (path === '/resources') return reply({ data: state.resources, mode: 'demo' });
      if (path === '/queries' && method === 'POST')
        return reply({
          columns: ['event'],
          rows: [{ event: 'agent_started' }],
          rowCount: 1,
          mode: 'demo',
          durationMs: 1,
        });
      if (/\/tables$/.test(path)) return reply({ data: [], mode: 'demo', truncated: false });
      if (path === '/keys' && method === 'POST') {
        const key = {
          ...body,
          id: 'key_fixture',
          prefix: 'fixture',
          createdAt,
          expiresAt: '2099-01-01T00:00:00Z',
          lastUsedAt: null,
          revokedAt: null,
        };
        state.keys.push(key);
        return reply({ data: key, secret: 'synthetic-browser-key-never-valid-on-a-provider' }, 201);
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
      requests,
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
