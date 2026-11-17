// Run by the Rust fixture; no browser API routes are mocked.
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import { createConsoleServer } from '../scripts/serve-console.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const origin = new URL(config.origin);
const base = '/studio/api/global';
const consoleServer = createConsoleServer();
const proxy = https.createServer(
  {
    cert: await readFile(config.certificateFile),
    key: await readFile(config.privateKeyFile),
  },
  (request, response) => {
    if (request.url.startsWith('/studio/api/')) {
      const upstream = http.request(
        new URL(request.url, config.backend),
        { method: request.method, headers: request.headers },
        (reply) => {
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502).end();
      });
      request.pipe(upstream);
    } else if (['/config.json', '/studio/config.json'].includes(request.url)) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          apiOrigin: config.origin,
          apiPathPrefix: base,
          portalMode: 'distributed',
        }),
      );
    } else {
      request.url = request.url.replace(/^\/studio\//, '/');
      consoleServer.emit('request', request, response);
    }
  },
);
await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(Number(origin.port), '127.0.0.1', resolve);
});
const browser = await chromium.launch();
const results = [];
try {
  const agent = await browser.newContext({ ignoreHTTPSErrors: true });
  const callback = await agent.request.get(config.agentCallback);
  expect(callback.status()).toBe(200);
  expect((await callback.json()).access_token).toBeUndefined();
  const contextUrl = `${config.origin}${base}/api/raft/actions/context`;
  const actor = await (await agent.request.get(contextUrl)).json();
  expect(actor.actor).toMatchObject({ kind: 'agent', serverId: config.serverId });
  expect(actor.workspaces).toEqual([]);
  for (const [theme, viewport] of [
    ['light', { width: 1280, height: 800 }],
    ['dark', { width: 390, height: 844 }],
    ['dark', { width: 1280, height: 800 }],
    ['light', { width: 390, height: 844 }],
  ]) {
    const human = await browser.newContext({
      ignoreHTTPSErrors: true,
      colorScheme: theme,
      viewport,
    });
    const page = await human.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${config.origin}/studio/raft`);
    await page.getByRole('link', { name: 'Sign in with Raft', exact: true }).click();
    await page.waitForURL((url) => url.origin === config.issuer);
    const authorization = new URL(page.url());
    const { code } = JSON.parse(await page.locator('body').innerText());
    const redirect = new URL(authorization.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', authorization.searchParams.get('state'));
    await page.goto(redirect.href);
    const loggedIn = await (await human.request.get(contextUrl)).json();
    expect(loggedIn.actor.kind).toBe('human');
    expect(loggedIn.actor.id).not.toBe(actor.actor.id);
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    const name = `${theme}-${viewport.width}`;
    await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill(name);
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/raft/workspaces') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    const workspace = (await (await created).json()).data.id;
    const resources = `${config.origin}${base}/api/raft/workspaces/${workspace}/resources`;
    const list = `${config.origin}${base}/api/raft/actions/list-resources?workspaceId=${workspace}`;
    await page.getByRole('textbox', { name: 'Resource name', exact: true }).fill('private-files');
    const resourceResponse = page.waitForResponse(
      (r) => r.url() === resources && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create resource', exact: true }).click();
    const resource = (await (await resourceResponse).json()).data.id;
    await page.getByRole('textbox', { name: 'Relative file path', exact: true }).fill('note.txt');
    const content = `Real native storage: ${name}`;
    await page.getByRole('textbox', { name: 'File content', exact: true }).fill(content);
    await page.getByRole('button', { name: 'Create file', exact: true }).click();
    await expect(page.getByText('File saved.', { exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Identity ID from the agent’s context action', exact: true })
      .fill(actor.actor.id);
    await page.getByRole('button', { name: 'Review admission', exact: true }).click();
    const admission = page.getByRole('dialog', { name: 'Approve this identity?' });
    await expect(admission.getByText('agent · browser-agent', { exact: true })).toBeVisible();
    await admission.getByRole('button', { name: 'Approve membership', exact: true }).click();
    await expect(admission).not.toBeVisible();
    expect((await (await agent.request.get(list)).json()).resources).toEqual([]);
    const read = `${config.origin}${base}/api/raft/actions/read-file?${new URLSearchParams({ workspaceId: workspace, resourceId: resource, path: 'note.txt' })}`;
    expect((await agent.request.get(read)).status()).toBe(404);
    await page.getByRole('button', { name: 'Share resources', exact: true }).click();
    const share = page.getByRole('dialog', { name: 'Share exact resources' });
    await share.getByRole('combobox', { name: 'Member', exact: true }).selectOption(actor.actor.id);
    await share.getByRole('textbox', { name: 'Resources to share', exact: true }).click();
    await page.getByRole('option', { name: `private-files (${resource})`, exact: true }).click();
    await share.getByRole('button', { name: 'Share selected resources', exact: true }).click();
    await expect(share).not.toBeVisible();
    expect((await (await agent.request.get(list)).json()).resources.map((r) => r.id)).toEqual([
      resource,
    ]);
    expect((await (await agent.request.get(read)).json()).content).toBe(content);
    const deniedWrite = await agent.request.put(`${resources}/${resource}/files`, {
      data: { path: 'note.txt', content: 'must not overwrite' },
    });
    expect(deniedWrite.status()).toBe(403);
    expect((await (await human.request.get(read)).json()).content).toBe(content);
    await page
      .getByRole('combobox', { name: 'Inspect resource access', exact: true })
      .selectOption(resource);
    const agentGrant = page.getByText('browser-agent', { exact: true }).locator('../..');
    await agentGrant.getByRole('button', { name: 'Revoke grant', exact: true }).click();
    expect((await agent.request.get(read)).status()).toBe(404);
    expect((await (await agent.request.get(list)).json()).resources).toEqual([]);
    expect((await (await human.request.get(read)).json()).content).toBe(content);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    results.push({ theme, width: viewport.width, workspace, resource, status: 'passed' });
    await human.close();
  }
  console.log(JSON.stringify({ nativeBrowser: results, externalIdentityProvider: 'fixture' }));
} finally {
  await browser.close();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
}
