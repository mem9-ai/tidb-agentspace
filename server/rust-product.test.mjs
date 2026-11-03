import { restWorkflowCases } from './test-support/rest-workflow-cases.mjs';
import { tutorialCases } from './test-support/tutorial-cases.mjs';
import { revokeAndConfirmRegion } from './test-support/revoke-confirm.mjs';
import './test-support/tutorial-sample-cases.mjs';
import './test-support/sales-sample-cases.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { workspaceFixture } from './test-support/workspace-fixture.mjs';
import { providerFixture, nativeSecret } from './test-support/provider-fixture.mjs';
import { metaFixture, port, reservePorts, until } from './test-support/meta-fixture.mjs';
import { seedRecords, readState, readBinding } from './test-support/record-fixture.mjs';
import { agentRestCases } from './test-support/agent-rest-cases.mjs';
import { productApiCases } from './test-support/product-api-cases.mjs';
import { globalOwnerFixture } from './test-support/global-owner-fixture.mjs';
import { productApiFixture } from './test-support/product-api-fixture.mjs';
const contract = JSON.parse(
  await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'),
);
const portalContract = JSON.parse(
  await readFile(
    new URL('../tools/api-contract/portal-regional-openapi.json', import.meta.url),
    'utf8',
  ),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const operations = [contract, portalContract].flatMap((document) =>
  Object.entries(document.paths).flatMap(([path, entry]) => {
    const root = entry.servers?.[0].url || document.servers[0].url;
    const full = root.replace(/\/$/, '') + path;
    return Object.entries(entry)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, op]) => ({
        method: method.toUpperCase(),
        pattern: new RegExp('^' + full.replace(/\{[^}]+\}/g, '[^/]+') + '$'),
        op,
        document,
      }));
  }),
);
function validateResponse(path, method, status, body) {
  const entry = operations.find((e) => e.method === method && e.pattern.test(path.split('?')[0]));
  const schema = (entry?.op.responses[status] || entry?.op.responses.default)?.content?.[
    'application/json'
  ]?.schema;
  if (!schema) return;
  const validate = ajv.compile({ ...schema, components: entry.document.components });
  assert.ok(validate(body), `${method} ${path}: ${ajv.errorsText(validate.errors)}`);
}
const base = '/api/v1/workspaces/ws_agentlab';
const secret = 'retained-public-workspace-key';
const privateWrite = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
test(
  'MySQL capability names reflect the configured provider in Portal and Agent contexts',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    for (const [provider, label] of [
      ['tidb-cloud-zero', 'MySQL · TiDB Cloud Zero'],
      ['local', 'MySQL demo'],
    ]) {
      await t.test(provider, async (child) => {
        const fixture = await productApiFixture(child, 'inProcess', undefined, {
          mysqlProvider: provider,
        });
        const portal = await fixture.request('/bootstrap');
        assert.equal(portal.status, 200, JSON.stringify(portal.body));
        assert.equal(portal.body.capabilities.mysql.provider, provider);
        assert.equal(portal.body.capabilities.mysql.label, label);
        const key = await fixture.issueKey({
          name: 'capability-reader',
          scopes: ['resources:read'],
          resourceIds: ['db_live'],
          expiresInDays: 7,
        });
        assert.equal(key.status, 201, JSON.stringify(key.body));
        const agent = await fixture.request('/context', { token: key.body.secret });
        assert.equal(agent.status, 200, JSON.stringify(agent.body));
        assert.equal(agent.body.capabilities.mysql.provider, provider);
        assert.equal(agent.body.capabilities.mysql.label, label);
      });
    }
  },
);
test(
  'an unavailable audit journal rejects a file mutation before provider I/O',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    assert.equal((await fixture.request('/resources')).status, 200);
    await fixture.stopRegionMetadata();
    const calls = fixture.provider.calls;
    const result = await fixture.request(
      '/files/content?resourceId=fs_live&path=%2Fmust-not-exist',
      {
        method: 'PUT',
        raw: Buffer.from('private-content'),
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    );
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.error.code, 'AUDIT_UNAVAILABLE');
    assert.match(result.body.error.message, /did not start/);
    assert.equal(fixture.provider.calls, calls);
  },
);
test(
  'audit history journals covered effects without storing customer content',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const write = await fixture.request('/files', {
      method: 'PUT',
      body: {
        resourceId: 'fs_shared',
        path: '/audit-private-canary',
        type: 'file',
        content: 'audit-content-canary',
      },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    const id = write.headers.get('x-request-id');
    const history = await until(async () => {
      const response = await fixture.request('/audit-history');
      assert.equal(response.status, 200);
      const records = response.body.data.filter((entry) => entry.requestId === id);
      assert.equal(records.length, 2);
      return response.body;
    });
    const records = history.data.filter((entry) => entry.requestId === id);
    assert.deepEqual(
      records.map((entry) => entry.outcome),
      ['succeeded', 'attempted'],
    );
    assert.equal(records[0].action, 'file.write');
    assert.deepEqual(records[0].target, { type: 'filesystem', id: 'fs_shared' });
    assert.equal(Object.hasOwn(records[1], 'target'), false);
    assert.equal(records[0].actor.kind, 'owner');
    assert.equal(records[0].operationId, records[1].operationId);
    assert.equal(records[1].resolution, 'succeeded');
    assert.equal(history.coverage.status, 'partial');
    assert.equal(JSON.stringify(history).includes('audit-private-canary'), false);
    assert.equal(JSON.stringify(history).includes('audit-content-canary'), false);
    const key = await fixture.issueKey({
      name: 'read-only-agent',
      scopes: ['resources:read', 'files:read'],
      resourceIds: ['*'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const denied = await fixture.request('/files', {
      method: 'PUT',
      token: key.body.secret,
      body: {
        resourceId: 'fs_shared',
        path: '/denied-private-canary',
        type: 'file',
        content: 'must-not-write',
      },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const deniedId = denied.headers.get('x-request-id');
    const deniedHistory = await until(async () => {
      const response = await fixture.request('/audit-history');
      const records = response.body.data.filter((entry) => entry.requestId === deniedId);
      assert.equal(records.length, 2);
      return records;
    });
    assert.deepEqual(
      deniedHistory.map((entry) => entry.outcome),
      ['denied', 'attempted'],
    );
    assert.equal(deniedHistory[0].decision, 'denied');
    assert.equal(Object.hasOwn(deniedHistory[0], 'target'), false);
    assert.equal(deniedHistory[0].actor.id, key.body.data.id);
    assert.equal(JSON.stringify(deniedHistory).includes('denied-private-canary'), false);
    assert.equal(JSON.stringify(deniedHistory).includes(key.body.secret), false);
    let providerAttempts = 0;
    fixture.provider.writeRace = (path, files) => {
      providerAttempts++;
      files.set(path, Buffer.from('provider may already have applied this'));
      return { status: 503, body: { error: 'private-provider-error' } };
    };
    const uncertain = await fixture.request('/files', {
      method: 'PUT',
      body: {
        resourceId: 'fs_live',
        path: '/uncertain-private-canary',
        type: 'file',
        content: 'uncertain-content-canary',
      },
    });
    assert.ok(uncertain.status >= 500, JSON.stringify(uncertain.body));
    const uncertainId = uncertain.headers.get('x-request-id');
    const uncertainRecords = await until(async () => {
      const response = await fixture.request('/audit-history');
      const records = response.body.data.filter((entry) => entry.requestId === uncertainId);
      assert.equal(records.length, 2);
      return records;
    });
    assert.deepEqual(
      uncertainRecords.map((entry) => entry.outcome),
      ['unknown', 'attempted'],
    );
    assert.equal(providerAttempts, 1);
    assert.equal(JSON.stringify(uncertainRecords).includes('private-provider-error'), false);
    assert.equal(JSON.stringify(uncertainRecords).includes('uncertain-private-canary'), false);
    assert.equal(JSON.stringify(uncertainRecords).includes('uncertain-content-canary'), false);
    const other = await fixture.request('/audit-history', {}, 1);
    assert.equal(other.status, 200);
    assert.equal(
      other.body.data.some((entry) => entry.requestId === id),
      false,
    );
  },
);
test(
  'request history records authenticated responses without paths, secrets or cross-Workspace leakage',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const key = await fixture.issueKey({
      name: 'read-resources-only',
      scopes: ['resources:read'],
      resourceIds: ['*'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const invalid = await fixture.request('/resources', { token: 'synthetic-invalid-token' });
    assert.equal(invalid.status, 401);
    const invalidId = invalid.headers.get('x-request-id');
    const denied = await fixture.request('/files?resourceId=fs_shared&path=%2Fprivate-canary', {
      token: key.body.secret,
      headers: { 'x-sensitive-canary': 'sensitive-canary' },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const deniedId = denied.headers.get('x-request-id');
    const history = await until(async () => {
      const response = await fixture.request('/request-history');
      assert.equal(response.status, 200);
      const record = response.body.data.find((entry) => entry.requestId === deniedId);
      assert.ok(record);
      return response.body;
    });
    const record = history.data.find((entry) => entry.requestId === deniedId);
    assert.equal(history.coverage.status, 'partial');
    assert.equal(history.health.status, 'unknown');
    assert.equal(history.health.droppedCount, null);
    assert.equal(record.operation, 'files');
    assert.equal(record.method, 'GET');
    assert.equal(record.status, 403);
    assert.equal(record.actor.kind, 'workspaceKey');
    assert.equal(record.actor.id, key.body.data.id);
    assert.equal(
      history.data.some((entry) => entry.requestId === invalidId),
      false,
    );
    const serialized = JSON.stringify(history);
    for (const secret of [
      'private-canary',
      'sensitive-canary',
      key.body.secret,
      'synthetic-invalid-token',
    ])
      assert.equal(serialized.includes(secret), false);
    const other = await fixture.request('/request-history', {}, 1);
    assert.equal(other.status, 200);
    assert.deepEqual(other.body.data, []);
    const after = await fixture.request('/request-history');
    assert.equal(
      after.body.data.some((entry) => entry.requestId === after.headers.get('x-request-id')),
      false,
    );
  },
);
test(
  'history pages require the current Workspace owner and disclose unavailable collection',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const key = await fixture.issueKey({
      name: 'broad-agent',
      scopes: ['resources:read', 'files:read'],
      resourceIds: ['*'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    for (const route of ['/audit-history', '/request-history']) {
      const page = await fixture.request(route);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.deepEqual(page.body.data, []);
      assert.equal(page.body.coverage.status, 'partial');
      assert.equal(page.body.health.status, 'unavailable');
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.equal((await fixture.request(`${route}?limit=bad`, { token: null })).status, 401);
      assert.equal(
        (await fixture.request(`${route}?limit=bad`, { token: key.body.secret })).status,
        403,
      );
      assert.equal((await fixture.request(`${route}?limit=1&limit=2`)).status, 400);
      assert.equal((await fixture.request(`/api/v1/workspaces/ws_other${route}`)).status, 404);
      assert.equal(
        (await fixture.request(`/api/v1/workspaces/${fixture.endpoints.workspaceId}${route}`))
          .status,
        200,
      );
    }
  },
);
test(
  'image preview enforces the size boundary before reading and validates image type',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    const atLimit = Buffer.alloc(1024 * 1024);
    signature.copy(atLimit);
    fixture.provider.setFile('/limit.png', atLimit);
    fixture.provider.setFile('/too-large.png', Buffer.alloc(1024 * 1024 + 1));
    fixture.provider.setFile('/wrong.png', Buffer.from('not an image'));
    const url = (path) => `/files/content?resourceId=fs_live&path=${path}&preview=1`;
    const exact = await fixture.request(url('/limit.png'));
    assert.equal(exact.status, 200);
    assert.equal(exact.body.size, atLimit.length);
    assert.match(exact.body.unavailableReason, /this version/);
    assert.deepEqual(Buffer.from(exact.body.image.base64, 'base64'), atLimit);
    const readsBeforeLarge = fixture.provider.fileReads;
    const tooLarge = await fixture.request(url('/too-large.png'));
    assert.equal(fixture.provider.fileReads, readsBeforeLarge);
    assert.equal(tooLarge.status, 200);
    assert.match(tooLarge.body.unavailableReason, /1 MiB/);
    assert.equal(tooLarge.body.image, undefined);
    const invalid = await fixture.request(url('/wrong.png'));
    assert.match(invalid.body.unavailableReason, /invalid/);
  },
);
test(
  'independent local File Systems can commit concurrent writes without losing events',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    await fixture.seedLocalFileSystem('fs_second');
    const write = (resourceId) =>
      fixture.request('/files', {
        method: 'PUT',
        body: { resourceId, path: '/parallel.txt', type: 'file', content: resourceId },
      });
    const responses = await Promise.all([write('fs_shared'), write('fs_second')]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
      JSON.stringify(responses),
    );
    for (const resourceId of ['fs_shared', 'fs_second']) {
      const files = await fixture.request(`/files?resourceId=${resourceId}`);
      assert.equal(
        files.body.data.find((file) => file.path === '/parallel.txt').content,
        resourceId,
      );
    }
    const events = await fixture.events();
    assert.equal(events.filter((event) => event.resource === '/parallel.txt').length, 2);
  },
);
test(
  'local File System deletion clears indexed files in bounded batches',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    await fixture.seedFiles(64, 'fs_shared');
    for (const [path, type, content] of [
      ['/nested', 'directory', ''],
      ['/nested/item.txt', 'file', 'item'],
    ]) {
      const result = await fixture.request('/files', {
        method: 'PUT',
        body: { resourceId: 'fs_shared', path, type, content },
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const deleted = await fixture.request('/resources/fs_shared', { method: 'DELETE' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.status, 'deleted');
    const records = await fixture.records([
      'state/files/file_scale_00000000',
      'state/files/file_scale_00000063',
    ]);
    assert.equal(records['state/files/file_scale_00000000'], null);
    assert.equal(records['state/files/file_scale_00000063'], null);
    assert.equal((await fixture.request('/files?resourceId=fs_shared')).status, 409);
  },
);
test(
  'concurrent local file writes preserve directory and version checks',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const put = (path, type, content, headers = {}) =>
      fixture.request('/files', {
        method: 'PUT',
        headers,
        body: { resourceId: 'fs_shared', path, type, content },
      });
    assert.equal((await put('/race', 'directory', '')).status, 200);
    const [child, remove] = await Promise.all([
      put('/race/child.txt', 'file', 'child'),
      fixture.request('/files/entry?resourceId=fs_shared&path=%2Frace', { method: 'DELETE' }),
    ]);
    assert.ok(
      !(child.status === 200 && remove.status === 200),
      JSON.stringify([child.body, remove.body]),
    );
    if (child.status === 200) assert.equal(remove.body.error.code, 'DIRECTORY_NOT_EMPTY');
    if (remove.status === 200) assert.equal(child.body.error.code, 'PARENT_MISSING');
    assert.equal((await put('/compare.txt', 'file', 'before')).status, 200);
    const metadata = await fixture.request(
      '/files/metadata?resourceId=fs_shared&path=%2Fcompare.txt',
    );
    assert.equal(metadata.status, 200);
    const headers = { 'If-Match': metadata.body.data.version };
    const writes = await Promise.all([
      put('/compare.txt', 'file', 'one', headers),
      put('/compare.txt', 'file', 'two', headers),
    ]);
    assert.deepEqual(writes.map((result) => result.status).sort(), [200, 412]);
  },
);
test(
  'a local File System with 10000 files supports bounded pages and point operations',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    await fixture.seedFiles(10000, 'fs_shared');
    const bootstrap = await fixture.request('/bootstrap');
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
    assert.deepEqual(bootstrap.body.files, []);
    assert.equal(
      bootstrap.body.usage.find((item) => item.resourceId === 'fs_shared').fileCount,
      10001,
    );
    const first = await fixture.request('/files?resourceId=fs_shared&limit=16');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.length, 16);
    assert.ok(first.body.nextCursor);
    const second = await fixture.request(
      `/files?resourceId=fs_shared&limit=16&cursor=${first.body.nextCursor}`,
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.length, 16);
    assert.ok(
      first.body.data.every((file) => !second.body.data.some((other) => other.id === file.id)),
    );
    const path = '/synthetic-00009999.txt';
    const metadata = await fixture.request(
      `/files/metadata?resourceId=fs_shared&path=${encodeURIComponent(path)}`,
    );
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
    const write = await fixture.request('/files', {
      method: 'PUT',
      body: { resourceId: 'fs_shared', path, type: 'file', content: 'updated' },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    const preview = await fixture.request(
      `/files/content?resourceId=fs_shared&path=${encodeURIComponent(path)}&preview=1`,
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.content, 'updated');
    const usage = await fixture.request('/usage');
    assert.equal(usage.body.data.find((item) => item.resourceId === 'fs_shared').fileCount, 10001);
  },
);
test(
  'local file operations read only their File System after resumable index migration',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    await fixture.seedFiles(4100);
    const bootstrap = await fixture.request('/bootstrap');
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
    assert.deepEqual(bootstrap.body.files, []);
    assert.equal(bootstrap.body.usage.find((item) => item.resourceId === 'fs_shared').fileCount, 1);
    const initial = await fixture.request('/files?resourceId=fs_shared');
    assert.deepEqual(
      initial.body.data.map((file) => file.path),
      ['/identity.txt'],
    );
    const write = await fixture.request('/files', {
      method: 'PUT',
      body: { resourceId: 'fs_shared', path: '/added.txt', type: 'file', content: 'ok' },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    const again = await fixture.request('/files?resourceId=fs_shared');
    assert.deepEqual(again.body.data.map((file) => file.path).sort(), [
      '/added.txt',
      '/identity.txt',
    ]);
    await fixture.restart({ crash: false });
    const recovered = await fixture.request('/files?resourceId=fs_shared');
    assert.deepEqual(recovered.body.data.map((file) => file.path).sort(), [
      '/added.txt',
      '/identity.txt',
    ]);
  },
);
test(
  'retired regional Keys are discarded in bounded batches without losing resources or Global Tokens',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const key = await fixture.issueKey({
      name: 'retained-global-key',
      scopes: ['queries:execute'],
      resourceIds: ['db_memory'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    await fixture.seedKeys(4100);
    await fixture.restart();
    const bootstrap = await fixture.request('/bootstrap');
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
    assert.equal(bootstrap.body.keys.length, 0);
    assert.equal(
      (await fixture.request('/resources', { token: 'key_scale_00000000' })).status,
      401,
    );
    assert.equal((await fixture.request('/keys')).status, 404);
    const query = await fixture.request('/queries', {
      method: 'POST',
      token: key.body.secret,
      body: { resourceId: 'db_memory', sql: 'SELECT 1' },
    });
    assert.equal(query.status, 200, JSON.stringify(query.body));
  },
);
test(
  'Region registration rejects a trusted certificate claiming another Region or endpoint',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const { address, tls, regionId, apiOrigin } = fixture.controlProbe;
    const port = Number(address.split(':').at(-1));
    const credentials = {
      ca: await readFile(tls.caFile),
      cert: await readFile(tls.certificateFile),
      key: await readFile(tls.privateKeyFile),
    };
    const unauthenticated = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: 'localhost',
      ca: credentials.ca,
    });
    unauthenticated.on('error', () => {});
    await new Promise((resolve, reject) => {
      unauthenticated.once('close', resolve);
      unauthenticated.setTimeout(3000, () => {
        unauthenticated.destroy();
        reject(new Error('Unauthenticated control connection remained open'));
      });
    });
    for (const [claimedRegion, claimedOrigin] of [
      ['region:forged', apiOrigin],
      [regionId, 'https://untrusted.example'],
    ]) {
      const socket = tlsConnect({
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ...credentials,
      });
      await once(socket, 'secureConnect');
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk;
      });
      const closed = once(socket, 'close');
      socket.write(
        JSON.stringify({
          type: 'register',
          region_id: claimedRegion,
          api_origin: claimedOrigin,
          api_path_prefix: '',
          instance_id: crypto.randomUUID(),
        }) + '\n',
      );
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Invalid registration was not closed')), 3000),
        ),
      ]);
      assert.equal(received, '');
    }
    const key = await fixture.issueKey({
      name: 'still-connected',
      scopes: ['resources:read'],
      resourceIds: ['*'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    assert.equal((await fixture.request('/resources', { token: key.body.secret })).status, 200);
  },
);
test(
  'Portal session and Agent Token share resource operations without sharing authentication',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const portalPath = `/api/portal/v1/workspaces/${fixture.endpoints.workspaceId}/resources`;
    const session = await fixture.request(portalPath);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(
      (await fixture.request(`/api/v1/workspaces/${fixture.endpoints.workspaceId}/resources`))
        .status,
      401,
    );
    assert.equal((await fixture.request(portalPath, { token: null })).status, 401);
    const key = await fixture.issueKey({
      name: 'agent-reader',
      scopes: ['resources:read'],
      resourceIds: ['*'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const agent = await fixture.request('/resources', { token: key.body.secret });
    assert.equal(agent.status, 200);
    assert.deepEqual(agent.body.data, session.body.data);
    assert.equal((await fixture.request(portalPath, { token: key.body.secret })).status, 401);
    assert.equal((await fixture.globalRequest('/keys', { pathProfile: 'agent' })).status, 401);
    assert.equal(
      (await fixture.globalRequest('/keys', { pathProfile: 'portal', token: key.body.secret }))
        .status,
      401,
    );
    assert.equal((await fixture.globalRequest('/keys', { pathProfile: 'portal' })).status, 200);
  },
);
test(
  'legacy resource placement and credentials survive regional metadata migration and restart',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const regionId = fixture.endpoints.regionId;
    const storedBefore = await fixture.storedResource('db_live');
    const bindingBefore = await fixture.binding('zero', 'db_live');
    assert.equal(storedBefore.regionId, undefined);
    const bootstrap = await fixture.request('/bootstrap');
    assert.equal(bootstrap.body.workspace.defaultRegionId, regionId);
    validateResponse(new URL(bootstrap.url).pathname, 'GET', bootstrap.status, bootstrap.body);
    const original = bootstrap.body.resources.find((resource) => resource.id === 'db_live');
    assert.equal(original.regionId, regionId);
    assert.equal(original.region, 'automatic');
    const detail = await fixture.request('/resources/fs_live');
    validateResponse(new URL(detail.url).pathname, 'GET', detail.status, detail.body);
    assert.equal(detail.body.data.regionId, regionId);
    assert.equal(detail.body.data.region, 'aws-ap-southeast-1');
    const key = await fixture.issueKey({
      name: 'migration-reader',
      scopes: ['queries:execute', 'files:read'],
      resourceIds: ['db_live', 'fs_live'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const read = () =>
      fixture.request('/queries', {
        method: 'POST',
        token: key.body.secret,
        body: { resourceId: 'db_live', sql: 'SELECT 1' },
      });
    assert.equal((await read()).status, 200);
    assert.equal(
      (await fixture.request('/files?resourceId=fs_live', { token: key.body.secret })).status,
      200,
    );
    await fixture.restart();
    assert.equal((await read()).status, 200);
    assert.equal(
      (await fixture.request('/files?resourceId=fs_live', { token: key.body.secret })).status,
      200,
    );
    const after = await fixture.request('/resources/db_live');
    assert.equal(after.body.data.id, original.id);
    assert.equal(after.body.data.regionId, regionId);
    assert.equal(after.body.data.region, original.region);
    assert.deepEqual(await fixture.binding('zero', 'db_live'), bindingBefore);
  },
);
test(
  'concurrent Key authentication preserves access and revocation',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const created = await fixture.issueKey({
      name: 'concurrent-reader',
      scopes: ['resources:read'],
      resourceIds: ['*'],
      expiresInDays: 7,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = created.body.secret;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => fixture.request('/context', { token })),
    );
    assert.ok(
      responses.every((response) => response.status === 200),
      JSON.stringify(responses),
    );
    await revokeAndConfirmRegion(fixture, created.body.data);
    assert.equal((await fixture.request('/context', { token })).status, 401);
  },
);
test(
  'concurrent resource creation preserves idempotency without a Workspace writer lock',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    // An existing legacy Workspace builds its resource index asynchronously. Exercise
    // the concurrent idempotency guarantee after that separate migration is ready.
    await until(async () => {
      const existing = await fixture.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'index-readiness' },
        body: { kind: 'mysql', name: 'fixture-mysql', region: 'automatic' },
      });
      if (existing.status === 503 && existing.body.error?.code === 'RESOURCE_INDEX_MIGRATING')
        throw new Error('Resource index is still migrating');
      assert.equal(existing.status, 409, JSON.stringify(existing.body));
      assert.equal(existing.body.error.code, 'NAME_EXISTS');
    });
    const create = () =>
      fixture.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'concurrent-same' },
        body: { kind: 'mysql', name: 'concurrent-same', region: 'automatic' },
      });
    const results = await Promise.all([create(), create()]);
    assert.deepEqual(
      results.map((item) => item.status),
      [201, 201],
      JSON.stringify(results),
    );
    assert.equal(results[0].body.data.id, results[1].body.data.id);
  },
);
test(
  'resource indexes backfill existing records and preserve name, quota and idempotency rules',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    await fixture.request('/resources?limit=1');
    const create = (name, key) =>
      fixture.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { kind: 'mysql', name, region: 'automatic' },
      });
    const existing = await create('fixture-mysql', 'existing');
    assert.equal(existing.status, 409);
    assert.equal(existing.body.error.code, 'NAME_EXISTS');
    const concurrent = await Promise.all([
      create('indexed-race', 'race-a'),
      create('indexed-race', 'race-b'),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [201, 409]);
    const winner = concurrent.find((result) => result.status === 201);
    const winnerKey = concurrent[0].status === 201 ? 'race-a' : 'race-b';
    assert.equal((await create('indexed-race', winnerKey)).body.data.id, winner.body.data.id);
    assert.equal((await create('changed-name', winnerKey)).body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await create('indexed-two', 'two')).status, 201);
    assert.equal((await create('indexed-three', 'three')).status, 201);
    assert.equal((await create('indexed-limit', 'limit')).body.error.code, 'FREE_TIER_LIMIT');
    assert.equal((await fixture.request('/resources/db_memory', { method: 'DELETE' })).status, 200);
    assert.equal((await create('fixture-mysql', 'reused')).status, 201);
  },
);
test(
  'bounded resource pages work beyond the legacy Workspace view limit',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    await fixture.request('/resources?limit=1'); // establish the owner session before seeding
    await fixture.seedResources(4100);
    assert.equal((await fixture.request('/api/health')).status, 200);
    assert.equal((await fixture.request('/api/portal/v1/workspaces')).status, 200);
    const bootstrap = await fixture.request('/bootstrap');
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
    assert.ok(bootstrap.body.resources.length <= 100);
    assert.ok(bootstrap.body.resourceNextCursor);
    const query = await fixture.request('/queries', {
      method: 'POST',
      body: { resourceId: 'db_scale_00000000', sql: 'SELECT 1' },
    });
    assert.equal(query.status, 200, JSON.stringify(query.body));
    const usage = await fixture.request('/usage?limit=10');
    assert.equal(usage.status, 200, JSON.stringify(usage.body));
    assert.ok(usage.body.data.length <= 10);
    assert.ok(usage.body.nextCursor);
    const localFile = await fixture.request('/files', {
      method: 'PUT',
      body: { resourceId: 'fs_shared', path: '/local-scale.txt', type: 'file', content: 'ok' },
    });
    assert.equal(localFile.status, 200, JSON.stringify(localFile.body));
    const details = await Promise.all(
      ['db_live', 'db_pg'].map((id) => fixture.request(`/resources/${id}`)),
    );
    assert.ok(details.every((response) => response.status === 200));
    const write = await fixture.request('/files', {
      method: 'PUT',
      body: { resourceId: 'fs_live', path: '/large-workspace.txt', type: 'file', content: 'ok' },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    assert.ok(
      (await fixture.events()).some(
        (event) => event.action === 'file.saved' && event.resource === '/large-workspace.txt',
      ),
    );
    const key = await fixture.issueKey({
      name: 'scale-key',
      scopes: ['resources:read'],
      resourceIds: ['db_scale_00000000'],
      expiresInDays: 7,
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const allowed = await fixture.request('/resources?limit=1', { token: key.body.secret });
    assert.deepEqual(
      allowed.body.data.map((resource) => resource.id),
      ['db_scale_00000000'],
    );
    assert.equal((await fixture.request('/keys')).status, 404);
    assert.equal((await fixture.request('/events')).status, 200);
    assert.equal(
      (
        await fixture.request('/settings', {
          method: 'PATCH',
          body: { workspaceName: 'Scale workspace', name: 'Developer' },
        })
      ).status,
      200,
    );
    await revokeAndConfirmRegion(fixture, key.body.data);
    assert.equal(
      (await fixture.request('/resources?limit=1', { token: key.body.secret })).status,
      401,
    );
    let cursor;
    let count = 0;
    do {
      const query = new URLSearchParams({ limit: '512' });
      if (cursor) query.set('cursor', cursor);
      const page = await fixture.request(`/resources?${query}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(page.body.data.length <= 512);
      count += page.body.data.filter((resource) => resource.id.startsWith('db_scale_')).length;
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.equal(count, 4100);
    const createIndexed = () =>
      fixture.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'large-backfill' },
        body: { kind: 'postgresql', name: 'large-backfill', region: 'automatic' },
      });
    let indexedCreate = await createIndexed();
    assert.equal(indexedCreate.status, 503, JSON.stringify(indexedCreate.body));
    assert.equal(indexedCreate.body.error.code, 'RESOURCE_INDEX_MIGRATING');
    assert.equal((await fixture.request('/resources?limit=1')).status, 200);
    const deadline = Date.now() + 120_000;
    while (indexedCreate.body.error?.code === 'RESOURCE_INDEX_MIGRATING' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      indexedCreate = await createIndexed();
    }
    assert.equal(indexedCreate.status, 201, JSON.stringify(indexedCreate.body));
    const duplicate = await fixture.request('/resources', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'large-duplicate' },
      body: { kind: 'postgresql', name: 'scale-1', region: 'automatic' },
    });
    assert.equal(duplicate.body.error.code, 'NAME_EXISTS');
    const deleted = await fixture.request('/resources/db_scale_00000000', { method: 'DELETE' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.status, 'deleted');
    assert.equal(
      (await fixture.request('/resources/db_scale_00000000')).body.data.status,
      'deleted',
    );
    const defaultPage = await fixture.request('/resources');
    assert.equal(defaultPage.status, 200);
    assert.ok(defaultPage.body.data.length <= 100);
    assert.ok(defaultPage.body.nextCursor);
  },
);
for (const transport of ['remote', 'inProcess']) {
  test(
    `Workspace tutorial progress through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => tutorialCases(t, transport),
  );
  test(
    `REST workflow resources through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => restWorkflowCases(t, transport),
  );
  test(
    `Agent REST P0 through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => agentRestCases(t, transport),
  );
  test(
    `OpenAPI behavioral coverage through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    (t) => productApiCases(t, transport),
  );
}

test(
  'Region data API and retained credentials survive an independent Global Meta process outage',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const saved = new Map();
    const f = await productApiFixture(t, 'inProcess', async ({ binding, sql }) => {
      assert.equal(binding.password, nativeSecret);
      if (sql === 'INSERT INTO outage_test VALUES (7)') {
        saved.set(binding.kind, 7);
        return { body: { columns: [], rows: [], rowCount: 0, affectedRows: 1 } };
      }
      if (sql === 'SELECT value FROM outage_test')
        return {
          body: {
            columns: ['value'],
            rows: saved.has(binding.kind) ? [{ value: saved.get(binding.kind) }] : [],
            rowCount: saved.has(binding.kind) ? 1 : 0,
            affectedRows: 0,
          },
        };
    });
    const global = await f.startIndependentGlobalMeta();
    const created = await f.issueKey({
      name: 'local-outage-check',
      scopes: ['queries:execute', 'files:read', 'files:write'],
      resourceIds: ['db_live', 'fs_live'],
      expiresInDays: 7,
    });
    assert.equal(created.status, 201);
    const token = created.body.secret;
    const query = (sql) =>
      f.request('/queries', {
        method: 'POST',
        token,
        body: { resourceId: 'db_live', sql },
      });
    const path =
      '/files/content?' + new URLSearchParams({ resourceId: 'fs_live', path: '/outage.bin' });
    assert.equal((await query('INSERT INTO outage_test VALUES (7)')).status, 200);
    await global.stop('SIGKILL');
    assert.equal(global.child.signalCode, 'SIGKILL');
    assert.deepEqual((await query('SELECT value FROM outage_test')).body.rows, [{ value: 7 }]);
    const upload = await f.request(path, {
      method: 'PUT',
      token,
      raw: Buffer.from([0, 255, 42]),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(upload.status, 200);
    assert.deepEqual((await f.request(path, { token })).body, Buffer.from([0, 255, 42]));
    await f.restart();
    assert.deepEqual((await query('SELECT value FROM outage_test')).body.rows, [{ value: 7 }]);
    assert.deepEqual((await f.request(path, { token })).body, Buffer.from([0, 255, 42]));
    assert.equal((await query('INSERT INTO outage_test VALUES (7)')).status, 200);
    assert.deepEqual((await query('SELECT value FROM outage_test')).body.rows, [{ value: 7 }]);
    assert.equal(
      (
        await f.request(path, {
          method: 'PUT',
          token,
          raw: Buffer.from('after restart'),
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      ).status,
      200,
    );
    assert.deepEqual((await f.request(path, { token })).body, Buffer.from('after restart'));
    assert.equal(global.child.signalCode, 'SIGKILL');
  },
);
async function connect(origin) {
  const session = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body, token, headers = {}, binary = false } = {}) => {
    const actualPath = token ? path : path.replace(/^\/api\/v1\//, '/api/portal/v1/');
    const r = await fetch(origin + actualPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
    const responseBody =
      binary && method === 'GET' ? Buffer.from(await r.arrayBuffer()) : await r.json();
    if (!binary) validateResponse(actualPath, method, r.status, responseBody);
    return {
      status: r.status,
      body: responseBody,
      headers: r.headers,
    };
  };
}
function parquetImportInput() {
  return readFile(new URL('./test-support/fixtures/import.parquet', import.meta.url));
}
async function scenarios(request, provider, global) {
  const main = await global.issueKey({
    name: 'full-contract',
    scopes: [
      'resources:read',
      'resources:write',
      'files:read',
      'files:write',
      'files:analyze',
      'queries:execute',
      'usage:read',
    ],
    resourceIds: ['*'],
    expiresInDays: 7,
  });
  assert.equal(main.status, 201, JSON.stringify(main.body));
  const secret = main.body.secret;
  async function run(
    path,
    options,
    expected = options?.method === 'POST' && path.split('?')[0].endsWith('-preparations')
      ? 201
      : 200,
  ) {
    const r = await request(path, options);
    assert.equal(
      r.status,
      expected,
      JSON.stringify({ path, command: options?.body?.command, status: r.status, body: r.body }),
    );
    return r;
  }
  const boot = await run(base + '/bootstrap');
  assert.equal(boot.body.resources.length, 6);
  assert.equal(boot.body.mode, 'hybrid');
  assert.equal(JSON.stringify(boot.body).includes(nativeSecret), false);
  const resources = await run(base + '/resources', { token: secret });
  assert.equal(resources.body.data.length, 6);
  const paged = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '2' });
    if (cursor) query.set('cursor', cursor);
    const page = (await run(`${base}/resources?${query}`)).body;
    assert.ok(page.data.length <= 2);
    paged.push(...page.data.map((resource) => resource.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(paged, resources.body.data.map((resource) => resource.id).sort());
  await run(base + '/queries', {
    method: 'POST',
    token: secret,
    body: { resourceId: 'db_memory', sql: 'SELECT 1 AS connected' },
  });
  for (const id of ['db_live', 'db_pg']) {
    const q = await run(base + '/queries', {
      method: 'POST',
      token: secret,
      body: { resourceId: id, sql: 'SELECT 1 AS checked' },
    });
    assert.deepEqual(q.body.rows, [{ checked: 1 }]);
    assert.equal(q.body.mode, 'live');
    await run(base + `/resources/${id}/tables`);
    const beforeMetadata = provider.statements.length;
    const table = await run(base + `/resources/${id}/tables/demo_table`);
    if (id === 'db_live') assert.equal(provider.statements.length - beforeMetadata, 1);
    assert.equal(table.body.columns[0].key, 'PRI');
    assert.equal(table.body.indexes[0].columns[0].name, 'id');
    assert.equal(table.body.recordKind, undefined);
    await run(base + `/resources/${id}/tables/demo_table/rows`);
  }
  const file = {
    resourceId: 'fs_shared',
    path: '/orders.csv',
    type: 'file',
    content: 'name,n\nalice,1\nbob,2\n',
  };
  await run(base + '/files', { method: 'PUT', body: file });
  await run(base + '/files?resourceId=fs_shared');
  const preview = await run(base + '/files/tabular-preview?resourceId=fs_shared&path=/orders.csv');
  assert.equal(preview.body.rowCount, 2);
  assert.equal(preview.body.totalRows, null);
  assert.deepEqual(preview.body.columns, ['name', 'n']);
  const cap = await run(base + '/file-analyses/capabilities?resourceId=fs_shared&path=/orders.csv');
  assert.equal(cap.body.available, true);
  assert.deepEqual(
    cap.body.engines.map((e) => e.engine),
    ['duckdb', 'bash'],
  );
  const analyzed = await run(base + '/file-analyses', {
    method: 'POST',
    body: {
      resourceId: 'fs_shared',
      path: '/orders.csv',
      engine: 'duckdb',
      sql: 'SELECT count(*) AS n FROM file',
    },
  });
  assert.deepEqual(analyzed.body.rows, [{ n: '2' }]);
  for (const command of [
    'cat "$FILE"',
    'grep alice "$FILE" | wc -l',
    'printf changed > "$FILE"',
    'cat /etc/passwd',
  ]) {
    const result = await run(
      base + '/file-analyses',
      {
        method: 'POST',
        body: { resourceId: 'fs_shared', path: '/orders.csv', engine: 'bash', command },
      },
      command.includes('>') ? 422 : 200,
    );
    if (command === 'cat "$FILE"') assert.equal(result.body.stdout, file.content);
    else if (command.includes('wc -l')) assert.equal(result.body.stdout.trim(), '1');
    else if (!command.includes('>')) assert.notEqual(result.body.exitCode, 0);
  }
  await run(base + '/files?resourceId=fs_live');
  await run(base + '/files/content?resourceId=fs_live&path=/upload.txt', {
    method: 'PUT',
    body: Buffer.from('uploaded text\n'),
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const nativePreview = await run(
    base + '/files/content?resourceId=fs_live&path=/upload.txt&preview=1',
  );
  assert.equal(nativePreview.body.content, 'uploaded text\n');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+ioAAAAASUVORK5CYII=',
    'base64',
  );
  await run(base + '/files/content?resourceId=fs_live&path=/preview.png', {
    method: 'PUT',
    body: png,
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const image = await run(base + '/files/content?resourceId=fs_live&path=/preview.png&preview=1');
  assert.equal(image.body.size, png.length);
  assert.equal(image.body.image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.body.image.base64, 'base64'), png);
  await run(base + '/files/content?resourceId=fs_live&path=/invalid.jpg', {
    method: 'PUT',
    body: Buffer.from('not a jpeg'),
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const invalid = await run(base + '/files/content?resourceId=fs_live&path=/invalid.jpg&preview=1');
  assert.match(invalid.body.unavailableReason, /invalid/);

  const download = await request(base + '/files/content?resourceId=fs_live&path=/binary.bin', {
    binary: true,
  });
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, Buffer.from([0, 255, 13, 10]));
  await run(base + '/file-exports', {
    method: 'POST',
    body: {
      source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
      target: { kind: 'filesystem', resourceId: 'fs_shared', path: '/copied.csv' },
    },
  });
  await run(
    base + '/file-exports',
    {
      method: 'POST',
      body: {
        source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
        target: { kind: 'filesystem', resourceId: 'fs_shared', path: '/copied.csv' },
      },
    },
    409,
  );
  for (const format of ['csv', 'json', 'jsonl']) {
    const r = await run(base + '/result-exports', {
      method: 'POST',
      body: {
        sourceResourceId: 'db_live',
        result: {
          columns: ['value', 'n'],
          rows: [
            { value: '=SUM(A1)', n: 1 },
            { value: 'quote"\nline', n: null },
            { value: '\ufeff=1', n: 3 },
          ],
        },
        target: { kind: 'download', format },
      },
    });
    assert.equal(r.body.format, format);
    assert.equal(r.body.rowCount, 3);
    assert.equal(r.body.bytes, Buffer.byteLength(r.body.content));
    assert.ok(r.body.filename.endsWith('.' + (format === 'jsonl' ? 'jsonl' : format)));
    if (format === 'json') {
      assert.deepEqual(JSON.parse(r.body.content), [
        { value: '=SUM(A1)', n: 1 },
        { value: 'quote"\nline', n: null },
        { value: '\ufeff=1', n: 3 },
      ]);
    }
    if (format === 'jsonl') {
      assert.deepEqual(
        r.body.content
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          { value: '=SUM(A1)', n: 1 },
          { value: 'quote"\nline', n: null },
          { value: '\ufeff=1', n: 3 },
        ],
      );
    }
    if (format === 'csv') assert.match(r.body.content, /'=SUM/);
  }
  await run(base + '/result-exports', {
    method: 'POST',
    body: {
      sourceResourceId: 'db_live',
      result: { columns: ['name', 'n'], rows: [{ name: "O'Reilly", n: 42 }] },
      target: { kind: 'filesystem', resourceId: 'fs_live', path: '/result.csv', format: 'csv' },
    },
  });
  await run(base + '/result-exports', {
    method: 'POST',
    body: {
      sourceResourceId: 'db_live',
      result: { columns: ['name', 'n'], rows: [{ name: "O'Reilly", n: 42 }] },
      target: { kind: 'database', resourceId: 'db_live', table: 'export_probe' },
    },
  });
  const preparation = await run(base + '/file-export-preparations', {
    method: 'POST',
    body: {
      source: { kind: 'original', resourceId: 'fs_shared', path: '/orders.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    },
  });
  assert.equal(preparation.body.rowCount, 2);
  assert.deepEqual(
    preparation.body.fields.map((f) => f.type),
    ['TEXT', 'BIGINT'],
  );
  const commit = {
    preparationId: preparation.body.id,
    confirmed: true,
    fields: preparation.body.fields,
    target: { kind: 'database', resourceId: 'db_pg', table: 'import_probe' },
  };
  await run(
    base + '/file-exports',
    { method: 'POST', body: { ...commit, target: { ...commit.target, table: '' } } },
    400,
  );
  await run(base + '/file-exports', { method: 'POST', body: commit });
  await run(base + '/file-exports', { method: 'POST', body: commit }, 409);
  const importKey = await global.issueKey({
    name: 'local-import-only',
    scopes: ['queries:execute'],
    resourceIds: ['db_live'],
    expiresInDays: 7,
  });
  const rawPath =
    base +
    '/database-import-preparations?' +
    new URLSearchParams({
      resourceId: 'db_live',
      filename: 'local.csv',
      format: 'csv',
      header: 'true',
      delimiter: ',',
    });
  const importedPreparation = await run(rawPath, {
    method: 'POST',
    token: importKey.body.secret,
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('id,value\n001,9007199254740993\n'),
  });
  validateResponse(rawPath, 'POST', 200, importedPreparation.body);
  assert.equal(importedPreparation.body.rows[0].id, '001');
  assert.equal(importedPreparation.body.rows[0].value, '9007199254740993');
  const importCommit = {
    resourceId: 'db_live',
    preparationId: importedPreparation.body.id,
    confirmed: true,
    table: 'direct_import',
    fields: importedPreparation.body.fields,
  };
  await run(base + '/database-imports', { method: 'POST', body: importCommit }, 409);
  await run(
    base + '/database-imports',
    {
      method: 'POST',
      token: importKey.body.secret,
      body: { ...importCommit, resourceId: 'db_pg' },
    },
    409,
  );
  await run(
    base + '/file-exports',
    {
      method: 'POST',
      token: importKey.body.secret,
      body: {
        preparationId: importCommit.preparationId,
        confirmed: true,
        fields: importCommit.fields,
        target: { kind: 'database', resourceId: 'db_pg', table: 'bypass_import' },
      },
    },
    409,
  );
  const beforeSourceDenied = provider.calls;
  await run(
    base + '/database-import-preparations',
    {
      method: 'POST',
      token: importKey.body.secret,
      body: {
        resourceId: 'db_live',
        source: { resourceId: 'fs_live', path: '/live.csv' },
        parsing: { format: 'csv', header: true, delimiter: ',' },
      },
    },
    403,
  );
  assert.equal(provider.calls, beforeSourceDenied);
  await run(base + '/database-imports', {
    method: 'POST',
    token: importKey.body.secret,
    body: importCommit,
  });
  await run(
    base + '/database-imports',
    { method: 'POST', token: importKey.body.secret, body: importCommit },
    409,
  );
  await run(
    rawPath,
    {
      method: 'POST',
      token: importKey.body.secret,
      binary: true,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024 + 1),
    },
    413,
  );
  const parquetPath =
    base +
    '/database-import-preparations?' +
    new URLSearchParams({ resourceId: 'db_live', filename: 'sample.parquet', format: 'parquet' });
  const parquetReview = await run(parquetPath, {
    method: 'POST',
    token: importKey.body.secret,
    binary: true,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await parquetImportInput(),
  });
  validateResponse(parquetPath, 'POST', 200, parquetReview.body);
  assert.equal(parquetReview.body.rowCount, 25);
  assert.equal(parquetReview.body.rows.length, 20);
  assert.equal(parquetReview.body.fields[0].type, 'BIGINT');
  await run(base + '/database-imports', {
    method: 'POST',
    token: importKey.body.secret,
    body: {
      resourceId: 'db_live',
      preparationId: parquetReview.body.id,
      confirmed: true,
      table: 'parquet_import',
      fields: parquetReview.body.fields,
    },
  });
  const fileImport = await run(base + '/database-import-preparations', {
    method: 'POST',
    body: {
      resourceId: 'db_pg',
      source: { resourceId: 'fs_shared', path: '/orders.csv' },
      parsing: { format: 'csv', header: true, delimiter: ',' },
    },
  });
  await run(
    base + '/file-exports',
    {
      method: 'POST',
      body: {
        preparationId: fileImport.body.id,
        confirmed: true,
        fields: fileImport.body.fields,
        target: { kind: 'database', resourceId: 'db_live', table: 'file_bypass' },
      },
    },
    409,
  );
  await run(base + '/database-imports', {
    method: 'POST',
    body: {
      resourceId: 'db_pg',
      preparationId: fileImport.body.id,
      confirmed: true,
      table: 'file_import',
      fields: fileImport.body.fields,
    },
  });
  await run(
    base + '/database-imports',
    {
      method: 'POST',
      body: {
        resourceId: 'db_pg',
        preparationId: preparation.body.id,
        confirmed: true,
        table: 'legacy_ticket',
        fields: preparation.body.fields,
      },
    },
    409,
  );
  await run(base + '/file-exports', {
    method: 'POST',
    body: {
      source: { kind: 'original', resourceId: 'fs_live', path: '/binary.bin' },
      target: { kind: 'filesystem', resourceId: 'fs_live', path: '/binary-copy.bin' },
    },
  });
  const binaryCopy = await request(
    base + '/files/content?resourceId=fs_live&path=/binary-copy.bin',
    { binary: true },
  );
  assert.equal(binaryCopy.status, 200);
  assert.deepEqual(binaryCopy.body, Buffer.from([0, 255, 13, 10]));
  const before = provider.calls;
  await run(base + '/files?resourceId=fs_live', { token: 'invalid' }, 401);
  await run('/api/v1/workspaces/other/resources', { token: secret }, 404);
  assert.equal(provider.calls, before);
  const key = await global.issueKey({
    name: 'read-only',
    scopes: ['files:read'],
    resourceIds: ['fs_shared'],
    expiresInDays: 7,
  });
  await run(
    base + '/file-analyses',
    {
      method: 'POST',
      token: key.body.secret,
      body: {
        resourceId: 'fs_shared',
        path: '/orders.csv',
        engine: 'bash',
        command: 'cat "$FILE"',
      },
    },
    403,
  );
  await run(
    base + '/files/entry?' + new URLSearchParams({ resourceId: 'fs_shared', path: '/copied.csv' }),
    { method: 'DELETE' },
  );
  await run(base + '/usage');
}
for (const transport of ['remote', 'inProcess']) {
  test(
    `Rust API satisfies data, analysis, export and credential contracts through ${transport} metadata`,
    { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
    async (t) => {
      const f = await metaFixture();
      const provider = await providerFixture();
      let child,
        reserved = [];
      t.after(async () => {
        await Promise.all(reserved.map((entry) => entry.release()));
        if (child && child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise((r) => child.once('exit', r));
        }
        await provider.close();
        await f.close();
      });
      const state = workspaceFixture();
      state.opaque = { preserve: 'original data' };
      state.resources.push(
        {
          id: 'fs_live',
          kind: 'filesystem',
          name: 'live-files',
          status: 'active',
          region: 'aws-ap-southeast-1',
          provider: 'drive9-anonymous',
          createdAt: state.workspace.createdAt,
        },
        {
          id: 'db_live',
          kind: 'mysql',
          name: 'live-mysql',
          status: 'active',
          region: 'automatic',
          provider: 'tidb-cloud-zero',
          createdAt: state.workspace.createdAt,
        },
        {
          id: 'db_pg',
          kind: 'postgresql',
          name: 'live-postgres',
          status: 'active',
          region: 'automatic',
          provider: 'db9-anonymous',
          createdAt: state.workspace.createdAt,
        },
        {
          id: 'db_duck',
          kind: 'duckdb',
          name: 'live-duckdb',
          status: 'active',
          region: 'aws-ap-southeast-1',
          provider: 'duckdb-drive9',
          createdAt: state.workspace.createdAt,
        },
      );
      state.keys = [
        {
          id: 'original-key',
          name: 'original',
          prefix: 'original',
          createdAt: state.workspace.createdAt,
          lastUsedAt: null,
          digest: createHash('sha256').update(secret).digest('hex'),
          scopes: [
            'resources:read',
            'resources:write',
            'files:read',
            'files:write',
            'files:analyze',
            'queries:execute',
            'usage:read',
          ],
          resourceIds: ['*'],
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          revokedAt: null,
        },
      ];
      const raw = [
        state,
        {
          bindings: {
            fs_live: { state: 'bound', apiKey: nativeSecret, tenantId: 'original' },
            private_duck: { state: 'bound', apiKey: nativeSecret, tenantId: 'original-private' },
          },
        },
        {
          bindings: {
            db_live: {
              state: 'ready',
              instanceId: 'original-mysql',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              connection: {
                kind: 'mysql',
                region: 'automatic',
                host: 'unit.fixture.tidbcloud.com',
                port: 4000,
                user: 'w_original',
                password: nativeSecret,
                database: 'workspace',
              },
            },
          },
        },
        { bindings: { db_duck: { state: 'ready', storageId: 'private_duck' } } },
        {
          bindings: {
            db_pg: {
              state: 'ready',
              instanceId: 'original-postgres',
              connection: {
                kind: 'postgresql',
                region: 'automatic',
                host: 'pg.db9.io',
                port: 5432,
                user: 'tenant.wabcdef123456',
                password: nativeSecret,
                database: 'postgres',
              },
            },
          },
        },
      ];
      const global = await f.service('global');
      const region = await f.service('complete');
      await seedRecords(
        region.client,
        region.server.authorityId,
        state,
        Object.fromEntries(
          ['drive9', 'zero', 'duckdb', 'db9'].map((name, i) => [name, raw[i + 1]]),
        ),
      );
      reserved = await reservePorts(2);
      if (transport === 'inProcess') await region.stop();
      const regionConfig = resolve(f.directory, 'embedded-region.json');
      await privateWrite(regionConfig, region.server);
      const bind = reserved[0].port;
      const globalPublic = await globalOwnerFixture(
        f,
        global,
        region,
        'ws_agentlab',
        `http://127.0.0.1:${bind}`,
        0,
        reserved[1].port,
      );
      const config = resolve(f.directory, 'workspace-rust.json');
      await privateWrite(config, {
        bind: `127.0.0.1:${bind}`,
        workspaceId: 'ws_agentlab',
        authorityId: region.server.authorityId,
        publicOrigins: [`http://127.0.0.1:${bind}`],
        security: globalPublic.security,
        insecureLoopback: true,
        consoleOrigins: ['http://127.0.0.1:5173'],
        metadata:
          transport === 'remote'
            ? { transport, client: region.clientConfig }
            : { transport, authorityId: region.server.authorityId },
        product: {
          providers: {
            filesProvider: 'drive9-anonymous',
            mysqlProvider: 'tidb-cloud-zero',
            postgresProvider: 'db9-anonymous',
            testMode: true,
            drive9Endpoint: provider.origin,
            sqlFixture: provider.origin + '/sql',
          },
        },
      });
      const deployment = resolve(f.directory, 'deployment.json');
      await privateWrite(deployment, {
        format: 1,
        services: [
          ...(transport === 'inProcess' ? [{ kind: 'metadata', configFile: regionConfig }] : []),
          { kind: 'workspace', configFile: config },
          globalPublic.service,
        ],
      });
      const log = createWriteStream(resolve(f.directory, 'backend.log'), { mode: 0o600 });
      await Promise.all(reserved.map((entry) => entry.release()));
      child = spawn(
        resolve('meta-service/target/debug/workspace-backend'),
        ['serve', '--config', deployment],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      const request = await until(() => connect(`http://127.0.0.1:${bind}`));
      try {
        await scenarios(request, provider, globalPublic);
      } catch (error) {
        const output = await readFile(resolve(f.directory, 'backend.log'), 'utf8');
        for (const line of output
          .split('\n')
          .filter((line) =>
            /^Compute worker (exited before a confirmed reply|returned invalid JSON)/.test(line),
          ))
          t.diagnostic(line);
        throw error;
      }
      assert.equal(provider.creates, 0);
      // Bootstrap and list use stored records; an explicit detail read refreshes provider data.
      const fileSystemDetail = await request(base + '/resources/fs_live');
      assert.equal(fileSystemDetail.status, 200);
      assert.equal(fileSystemDetail.body.data.uploadLimitBytes, 1048576);
      const databaseDetail = await request(base + '/resources/db_live');
      assert.equal(databaseDetail.status, 200);
      assert.equal(databaseDetail.body.data.expiresAt, raw[2].bindings.db_live.expiresAt);
      const schema = await fetch(`http://127.0.0.1:${bind}/openapi.json`);
      assert.equal(schema.status, 200);
      assert.deepEqual(await schema.json(), JSON.parse(await readFile('public/openapi.json')));
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      const verifier =
        transport === 'inProcess' ? await f.service('verify', { previous: region }) : region;
      for (let i = 1; i < raw.length; i++)
        for (const [id, binding] of Object.entries(raw[i].bindings)) {
          assert.deepEqual(
            await readBinding(
              verifier.client,
              region.server.authorityId,
              ['workspace', 'drive9', 'zero', 'duckdb', 'db9'][i],
              id,
            ),
            binding,
          );
        }
      const final = await readState(verifier.client, verifier.server.authorityId);
      assert.deepEqual(final.opaque, state.opaque);
      assert.deepEqual(
        final.resources,
        state.resources.map((resource) => ({
          ...resource,
          ...(resource.id !== 'db_duck' ? { regionId: 'region:complete' } : {}),
          ...(resource.id === 'fs_live' ? { uploadLimitBytes: 1048576 } : {}),
          ...(resource.id === 'db_live' ? { expiresAt: raw[2].bindings.db_live.expiresAt } : {}),
        })),
      );
      assert.deepEqual(final.keys, []);
    },
  );
}

test(
  'Rust provider lifecycle retains one creation intent across retries, unknown responses and restart',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await metaFixture();
    const provider = await providerFixture();
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
      await provider.close();
      await f.close();
    });
    const state = workspaceFixture();
    state.resources = [];
    state.files = [];
    const global = await f.service('global');
    const region = await f.service('lifecycle');
    await seedRecords(region.client, region.server.authorityId, state);
    await global.stop();
    const bind = await port();
    const config = resolve(f.directory, 'rust.json');
    await privateWrite(config, {
      bind: `127.0.0.1:${bind}`,
      workspaceId: 'ws_agentlab',
      authorityId: region.server.authorityId,
      insecureLoopback: true,
      consoleOrigins: ['http://127.0.0.1:5173'],
      metadata: { transport: 'remote', client: region.clientConfig },
      product: {
        providers: {
          filesProvider: 'drive9-anonymous',
          mysqlProvider: 'tidb-cloud-zero',
          postgresProvider: 'db9-anonymous',
          testMode: true,
          drive9Endpoint: provider.origin,
          zeroEndpoint: provider.origin + '/zero',
          db9Endpoint: provider.origin + '/customer',
          sqlFixture: provider.origin + '/sql',
        },
      },
    });
    const plan = resolve(f.directory, 'plan.json');
    await privateWrite(plan, { format: 1, services: [{ kind: 'workspace', configFile: config }] });
    async function start() {
      child = spawn(
        resolve('meta-service/target/debug/workspace-backend'),
        ['serve', '--config', plan],
        { stdio: 'ignore' },
      );
      return until(() => connect(`http://127.0.0.1:${bind}`));
    }
    let request = await start();
    const create = async (kind, name, key) => {
      const deadline = Date.now() + 10_000;
      let result;
      do {
        result = await request(base + '/resources', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: { kind, name, region: kind === 'filesystem' ? 'aws-ap-southeast-1' : 'automatic' },
        });
        if (result.status !== 503 || result.body.error?.code !== 'RESOURCE_INDEX_MIGRATING') {
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      return result;
    };
    const pg = await create('postgresql', 'tidb_pg-example', 'pg');
    assert.equal(pg.status, 201);
    assert.equal(pg.body.data.name, 'tidb_pg-example');
    assert.equal(pg.body.data.status, 'active');
    const invalidPg = await create('postgresql', '_tidb-pg', 'invalid-pg');
    assert.equal(invalidPg.status, 400);
    assert.equal(invalidPg.body.error.code, 'INVALID_NAME');
    const invalidMysql = await create('mysql', 'tidb_pg-example', 'invalid-mysql');
    assert.equal(invalidMysql.status, 400);
    assert.equal(invalidMysql.body.error.code, 'INVALID_NAME');
    const mysql = await create('mysql', 'known-mysql', 'mysql');
    assert.equal(mysql.status, 201);
    assert.equal(mysql.body.data.status, 'active');
    assert.equal((await create('mysql', 'known-mysql', 'mysql')).body.data.id, mysql.body.data.id);
    assert.equal((await create('mysql', 'changed-name', 'mysql')).status, 409);
    provider.lost = true;
    const unknownPg = await create('postgresql', 'unknown-postgres', 'lost-pg');
    assert.equal(unknownPg.status, 201);
    assert.notEqual(unknownPg.body.data.status, 'active');
    const unknownZero = await create('mysql', 'unknown-mysql', 'lost-zero');
    assert.equal(unknownZero.status, 201);
    assert.notEqual(unknownZero.body.data.status, 'active');
    const unknownFile = await create('filesystem', 'unknown-files', 'lost-file');
    assert.equal(unknownFile.status, 201);
    assert.notEqual(unknownFile.body.data.status, 'active');
    provider.lost = false;
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    request = await start();
    const recovered = await request(base + `/resources/${unknownPg.body.data.id}/setup-attempts`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'restore-pg' },
    });
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.data.status, 'succeeded');
    assert.equal(recovered.body.data.resource.status, 'active');
    assert.notEqual(
      (
        await request(base + `/resources/${unknownZero.body.data.id}/setup-attempts`, {
          method: 'POST',
          headers: { 'Idempotency-Key': 'restore-zero' },
        })
      ).body.data.status,
      'succeeded',
    );
    await create('filesystem', 'unknown-files', 'lost-file');
    assert.deepEqual(provider.nativeCreates, { zero: 2, db9: 2, account: 1 });
    assert.equal(provider.creates, 1);
    const unavailable = await request(base + '/resources', {
      method: 'POST',
      body: { kind: 'duckdb', name: 'unavailable-duckdb', region: 'aws-ap-southeast-1' },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(provider.creates, 1);
    const list = await request(base + '/resources');
    assert.equal(list.body.data.length, 5);
    assert.equal(JSON.stringify(list.body).includes(nativeSecret), false);
  },
);

test(
  'Console downloadable client connects through one API endpoint and reads from Region',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 120000 },
  async (t) => {
    const { apiExampleCases } = await import('./test-support/api-example-cases.mjs');
    await apiExampleCases(t);
  },
);
