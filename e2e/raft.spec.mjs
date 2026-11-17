import { test, expect } from '@playwright/test';

const workspaceId = '49f39779-bd75-455d-aa9b-82024f35601a';
const agentId = '49d3da88-cdef-4f56-9ae7-74c90154c628';
const humanId = '58143566-2a40-41f2-a0d0-71ff8712c069';
const serverId = 'd2048c22-fb58-44d5-9ad3-14abcbe0085c';
const base = '/api/global';
const capabilities = {
  filesystem: { regions: ['aws-us-west-2'], provider: 'local' },
  postgresql: { regions: ['automatic'], provider: 'db9-anonymous', available: true },
};
const enrollment = {
  principal: {
    id: agentId,
    identity: { provider: 'raft', serverId, subject: 'research-agent', kind: 'agent' },
  },
  status: 'pending',
};
const ws = {
  id: workspaceId,
  name: 'Research',
  serverId,
  regionId: 'region:local',
  generation: 1,
  canManage: true,
};
async function setup(page, handler) {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: { apiOrigin: 'http://127.0.0.1:4389', apiPathPrefix: base, portalMode: 'distributed' },
    }),
  );
  await page.route('**/api/global/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `${base}/api/raft/config`)
      return route.fulfill({
        json: { loginUrl: `${base}/auth/raft/login`, regions: ['region:local'] },
      });
    const reply = await handler(request, url);
    expect(reply, `Unexpected ${request.method()} ${url.pathname}`).toBeTruthy();
    return route.fulfill(reply);
  });
}

test('Human creates a private file, approves a member and shares exact resources @visual', async ({
  page,
}, testInfo) => {
  let admitted = false;
  let created = false;
  let resource;
  let file;
  let approved = false;
  let shared;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page, async (request, url) => {
    const path = url.pathname.slice(base.length);
    if (path === '/api/raft/actions/context')
      return {
        json: {
          actor: { id: humanId, kind: 'human', serverId },
          expiresAt: 1900000000,
          enrollmentRequired: !admitted,
          resourceReady: null,
          workspaces: admitted ? [ws] : [],
          nextCursor: null,
        },
      };
    if (path === '/api/raft/workspaces' && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.name).toBe('Research');
      expect(body.requestId).toMatch(/^[\da-f-]{36}$/);
      admitted = true;
      return { status: 201, json: { data: ws, resourceReady: false } };
    }
    if (path === `/api/raft/workspaces/${workspaceId}`) return { json: { data: ws } };
    if (path === `/api/raft/workspaces/${workspaceId}/enrollments`)
      return {
        json: {
          records: [{ value: { ...enrollment, status: approved ? 'approved' : 'pending' } }],
          nextCursor: null,
        },
      };
    if (path.endsWith(`/enrollments/${agentId}`)) {
      expect(request.postDataJSON()).toEqual({ approved: true });
      expect(request.headers()['if-match']).toBe('"1"');
      approved = true;
      return { json: { data: { ...enrollment, status: 'approved' } } };
    }
    if (path === '/api/raft/actions/list-resources')
      return { json: { resources: resource ? [resource] : [], nextCursor: null } };
    if (path === `/api/raft/workspaces/${workspaceId}/resources`) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body).toMatchObject({
          name: 'project-files',
          kind: 'filesystem',
          region: 'aws-us-west-2',
        });
        created = true;
        resource = {
          id: 'fs_research',
          name: body.name,
          kind: body.kind,
          region: body.region,
          status: 'active',
          provider: 'local',
          allowedActions: ['resources:read', 'files:read', 'files:write', 'tags:write'],
          tags: { version: 0, values: {} },
        };
        return { json: { data: resource } };
      }
      return { json: { data: resource ? [resource] : [], capabilities, nextCursor: null } };
    }
    if (path.endsWith('/resources/fs_research/files') && request.method() === 'PUT') {
      const body = request.postDataJSON();
      expect(body).toEqual({ path: 'note.txt', content: 'Our private research note.' });
      file = { content: body.content, encoding: 'utf8', size: 26, revision: '"native-1"' };
      return { json: { data: {} } };
    }
    if (path === '/api/raft/actions/read-file') {
      expect(url.searchParams.get('path')).toBe('note.txt');
      return { json: file };
    }
    if (path.endsWith('/resources/share-batches')) {
      shared = request.postDataJSON();
      expect(shared.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(request.headers()['if-match']).toBe('"1"');
      expect(shared).toMatchObject({
        principalId: agentId,
        resourceIds: ['fs_research'],
        actions: ['resources:read', 'files:read'],
      });
      return {
        json: {
          requestId: shared.requestId,
          results: [{ resourceId: 'fs_research', status: 'applied' }],
        },
      };
    }
  });
  await page.goto('/raft');
  await expect(page.getByRole('heading', { name: 'Your workspace starts here' })).toBeVisible();
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Research');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(
    page.getByText('No resources are available to you yet.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Resource name', exact: true }).fill('project-files');
  await page.getByRole('button', { name: 'Create resource', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'project-files', exact: true })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'File content', exact: true })
    .fill('Our private research note.');
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Create file', exact: true }).click();
  await expect(page.getByText('File saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue(
    file.content,
  );
  await page.getByRole('button', { name: 'Share resources', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share exact resources' });
  await dialog.getByRole('combobox', { name: 'Member', exact: true }).selectOption(agentId);
  await dialog.getByRole('textbox', { name: 'Resources to share', exact: true }).click();
  await page.getByRole('option', { name: 'project-files (fs_research)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Share selected resources', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(created).toBe(true);
  expect(shared.resourceIds).toEqual(['fs_research']);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (process.env.VISUAL_SCREENSHOTS === '1')
    await page.screenshot({ path: testInfo.outputPath('raft-workspace.png'), fullPage: true });
});

test('query keeps its original request through a lost response and browser reload', async ({
  page,
}) => {
  let submissions = 0;
  let retained;
  let missing = false;
  await setup(page, async (request, url) => {
    const path = url.pathname.slice(base.length);
    if (path === '/api/raft/actions/context')
      return {
        json: {
          actor: { id: agentId, kind: 'agent', serverId },
          expiresAt: 1900000000,
          enrollmentRequired: false,
          resourceReady: null,
          workspaces: [{ ...ws, canManage: false }],
          nextCursor: null,
        },
      };
    if (path === '/api/raft/actions/list-resources')
      return {
        json: {
          resources: [
            {
              id: 'db_research',
              name: 'research-data',
              kind: 'postgresql',
              region: 'automatic',
              status: 'active',
              provider: 'db9-anonymous',
              allowedActions: ['resources:read', 'queries:execute'],
            },
          ],
          nextCursor: null,
        },
      };
    if (path === '/api/raft/actions/query') {
      submissions++;
      retained = request.postDataJSON();
      return {
        status: 503,
        json: { error: { code: 'REGIONAL_OUTCOME_UNKNOWN', message: '', requestId: 'fixture' } },
      };
    }
    if (path === '/api/raft/actions/query-status') {
      expect(url.searchParams.get('requestId')).toBe(retained.requestId);
      if (missing) return { status: 404, json: { error: { code: 'NOT_FOUND' } } };
      return {
        json: {
          requestId: retained.requestId,
          operationId: retained.requestId,
          status: 'outcomeUnknown',
          result: null,
          errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
        },
      };
    }
  });
  await page.goto('/raft');
  await page.getByRole('button', { name: 'research-data', exact: true }).click();
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Keep the same request');
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'research-data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check query status', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('database outcome is unknown');
  missing = true;
  await page.getByRole('button', { name: 'Check query status', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('NOT_FOUND');
  await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New query', exact: true })).not.toBeVisible();
  expect(submissions).toBe(1);
});

test('Human reviews the verified identity reported by an unadmitted agent before approving membership', async ({
  page,
}) => {
  let invited = false;
  let creates = 0;
  await setup(page, async (request, url) => {
    const path = url.pathname.slice(base.length);
    if (path === '/api/raft/actions/context')
      return {
        json: {
          actor: { id: humanId, kind: 'human', serverId },
          expiresAt: 1900000000,
          enrollmentRequired: false,
          resourceReady: null,
          workspaces: [ws],
          nextCursor: null,
        },
      };
    if (path === `/api/raft/workspaces/${workspaceId}`) return { json: { data: ws } };
    if (path === `/api/raft/workspaces/${workspaceId}/enrollments`)
      return {
        json: {
          records: invited ? [{ value: { ...enrollment, status: 'approved' } }] : [],
          nextCursor: null,
        },
      };
    if (path === '/api/raft/actions/list-resources')
      return { json: { resources: [], nextCursor: null } };
    if (path === `/api/raft/workspaces/${workspaceId}/resources`) {
      if (request.method() === 'POST') creates++;
      return { json: { data: [], capabilities, nextCursor: null } };
    }
    if (path === `/api/raft/workspaces/${workspaceId}/principals/${agentId}`)
      return { json: { data: enrollment.principal } };
    if (path === `/api/raft/workspaces/${workspaceId}/invitations`) {
      expect(request.headers()['if-match']).toBe('"1"');
      expect(request.postDataJSON()).toMatchObject({ principalId: agentId });
      expect(request.postDataJSON().requestId).toMatch(/^[\da-f-]{36}$/);
      invited = true;
      return { status: 201, json: { data: { ...enrollment, status: 'approved' } } };
    }
  });
  await page.goto('/raft');
  await page
    .getByRole('textbox', { name: 'Identity ID from the agent’s context action', exact: true })
    .fill(agentId);
  await page.getByRole('button', { name: 'Review admission', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve this identity?', exact: true });
  await expect(dialog).toContainText('research-agent');
  await expect(dialog).toContainText(serverId);
  expect(invited).toBe(false);
  await dialog.getByRole('button', { name: 'Approve membership', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  expect(invited).toBe(true);
  expect(creates).toBe(0);
});

for (const [status, code] of [
  [400, 'INVALID_SQL'],
  [403, 'READ_ONLY_SQL_REQUIRED'],
]) {
  test(`SQL can be corrected after definite pre-execution rejection ${code}`, async ({ page }) => {
    let submissions = 0;
    await setup(page, async (request, url) => {
      const path = url.pathname.slice(base.length);
      if (path === '/api/raft/actions/context')
        return {
          json: {
            actor: { id: agentId, kind: 'agent', serverId },
            expiresAt: 1900000000,
            enrollmentRequired: false,
            resourceReady: null,
            workspaces: [{ ...ws, canManage: false }],
            nextCursor: null,
          },
        };
      if (path === '/api/raft/actions/list-resources')
        return {
          json: {
            resources: [
              {
                id: 'db_research',
                name: 'research-data',
                kind: 'postgresql',
                region: 'automatic',
                status: 'active',
                provider: 'db9-anonymous',
                allowedActions: ['resources:read', 'queries:read'],
              },
            ],
            nextCursor: null,
          },
        };
      if (path === '/api/raft/actions/query') {
        submissions++;
        if (submissions === 1) return { status, json: { error: { code } } };
        const input = request.postDataJSON();
        expect(input.sql).toBe('SELECT 1 AS hello;');
        return {
          json: {
            requestId: input.requestId,
            operationId: input.requestId,
            status: 'succeeded',
            result: { columns: ['hello'], rows: [{ hello: 1 }] },
            errorCode: null,
          },
        };
      }
    });
    await page.goto('/raft');
    await page.getByRole('button', { name: 'research-data', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'SQL query', exact: true });
    const run = page.getByRole('button', { name: 'Run query', exact: true });
    await editor.fill('');
    await run.click();
    await expect(page.getByRole('alert')).toContainText('Enter a SQL query');
    expect(submissions).toBe(0);
    await expect(editor).toBeEditable();
    await editor.fill('DELETE FROM example');
    await run.click();
    await expect(page.getByRole('alert')).toContainText(
      code === 'INVALID_SQL' ? 'Enter a valid SQL' : 'Only read-only SQL',
    );
    await expect(editor).toBeEditable();
    await expect(run).toBeEnabled();
    expect(submissions).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: 'research-data', exact: true }).click();
    await expect(run).toBeEnabled();
    await run.click();
    await expect(
      page.getByRole('region', { name: 'Query result data', exact: true }),
    ).toContainText('hello');
    await expect(page.getByRole('button', { name: 'New query', exact: true })).toBeVisible();
    expect(submissions).toBe(2);
  });
}
