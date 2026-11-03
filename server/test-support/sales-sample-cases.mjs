import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { productApiFixture } from './product-api-fixture.mjs';

const csv = await readFile(
  new URL('../../specs/gh-150/fixtures/us-sales.csv', import.meta.url),
  'utf8',
);
const expected = JSON.parse(
  await readFile(new URL('../../specs/gh-150/fixtures/expected.json', import.meta.url), 'utf8'),
);

test('US sales fixture independently matches the promised totals', () => {
  const [header, ...lines] = csv.trim().split('\n');
  assert.equal(header, 'order_id,order_date,state,product,quantity,sales_usd');
  assert.equal(lines.length, expected.orderCount);
  const totals = {};
  const california = {};
  for (const line of lines) {
    const [, , state, product, , amount] = line.split(',');
    totals[state] = (totals[state] || 0) + Number(amount);
    if (state === 'California') california[product] = (california[product] || 0) + Number(amount);
  }
  assert.deepEqual(totals, expected.salesByState);
  assert.equal(
    Object.values(totals).reduce((a, b) => a + b, 0),
    expected.totalSales,
  );
  assert.deepEqual(Object.entries(california).sort((a, b) => b[1] - a[1])[0], [
    expected.californiaTopProduct.product,
    expected.californiaTopProduct.sales,
  ]);
});

test(
  'default File System is created once, reused by scoped sample access, and not recreated after deletion',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await productApiFixture(t, 'inProcess', undefined, {
      fresh: true,
      filesProvider: 'local',
    });
    const create = () =>
      f.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'workspace-default-files-v1' },
        body: {
          name: 'my-files',
          kind: 'filesystem',
          region: 'aws-ap-southeast-1',
          onlyIfNew: true,
        },
      });
    const [first, concurrent] = await Promise.all([create(), create()]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(concurrent.status, 201, JSON.stringify(concurrent.body));
    const resourceId = first.body.data.id;
    assert.equal(concurrent.body.data.id, resourceId);
    assert.equal(first.body.data.isDefault, true);
    assert.equal((await f.request('/resources')).body.data.length, 1);
    const otherKey = await f.issueKey({
      name: 'no-default',
      scopes: ['resources:write'],
      resourceIds: ['*'],
      expiresInDays: 1,
    });
    assert.equal(
      (
        await f.request('/resources', {
          token: otherKey.body.secret,
          method: 'POST',
          headers: { 'Idempotency-Key': randomUUID() },
          body: {
            name: 'another-default',
            kind: 'filesystem',
            region: 'aws-ap-southeast-1',
            onlyIfNew: true,
          },
        })
      ).status,
      403,
    );
    const writer = await f.issueKey({
      name: 'sample-files',
      scopes: ['files:read', 'files:write'],
      resourceIds: [resourceId],
      expiresInDays: 1,
    });
    const denied = await f.request('/sales-sample-attempts', {
      token: writer.body.secret,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { fixture: 'us-sales-v1', resourceId: 'fs_ungranted' },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual((await f.request('/sales-sample-attempts?fixture=us-sales-v1')).body.data, []);
    const sampleKey = randomUUID();
    const start = () =>
      f.request('/sales-sample-attempts', {
        token: writer.body.secret,
        method: 'POST',
        headers: { 'Idempotency-Key': sampleKey },
        body: { fixture: 'us-sales-v1', resourceId },
      });
    const sample = await start();
    assert.equal(sample.status, 201, JSON.stringify(sample.body));
    assert.equal(sample.body.data.status, 'ready', JSON.stringify(sample.body));
    assert.equal(sample.body.data.resourceId, resourceId);
    assert.equal((await start()).body.data.id, sample.body.data.id);
    assert.equal((await f.request('/resources')).body.data.length, 1);
    assert.equal((await f.request(`/resources/${resourceId}`, { method: 'DELETE' })).status, 200);
    const afterDeletion = await create();
    assert.equal(afterDeletion.status, 201, JSON.stringify(afterDeletion.body));
    assert.equal(afterDeletion.body.data.id, resourceId);
    assert.equal(afterDeletion.body.data.status, 'deleted');
    assert.equal((await f.request('/resources')).body.data.length, 0);
    const freshKey = await f.request('/resources', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { name: 'my-files', kind: 'filesystem', region: 'aws-ap-southeast-1', onlyIfNew: true },
    });
    assert.equal(freshKey.status, 409);
    assert.equal(freshKey.body.error.code, 'WORKSPACE_NOT_NEW');
  },
);

test(
  'reusing a File System never overwrites an existing sales file',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await productApiFixture(t, 'inProcess', undefined, {
      fresh: true,
      filesProvider: 'local',
    });
    const created = await f.request('/resources', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'workspace-default-files-v1' },
      body: { name: 'my-files', kind: 'filesystem', region: 'aws-ap-southeast-1', onlyIfNew: true },
    });
    const resourceId = created.body.data.id;
    const write = await f.request('/files', {
      method: 'PUT',
      headers: { 'If-None-Match': '*' },
      body: { resourceId, path: '/us-sales.csv', type: 'file', content: 'customer data' },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    const sample = await f.request('/sales-sample-attempts', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { fixture: 'us-sales-v1', resourceId },
    });
    assert.equal(sample.body.data.status, 'outcome_unknown');
    const files = await f.request(`/files?resourceId=${resourceId}&path=%2F`);
    assert.equal(
      files.body.data.find((file) => file.path === '/us-sales.csv').content,
      'customer data',
    );
    assert.equal((await f.request('/resources')).body.data.length, 1);
  },
);

test(
  'sales sample is isolated, idempotent, durable and never overwrites edits',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await productApiFixture(t, 'inProcess', undefined, {
      fresh: true,
      filesProvider: 'local',
    });
    const start = (key, workspace = 0) =>
      f.request(
        '/sales-sample-attempts',
        { method: 'POST', headers: { 'Idempotency-Key': key }, body: { fixture: 'us-sales-v1' } },
        workspace,
      );
    assert.deepEqual((await f.request('/sales-sample-attempts?fixture=us-sales-v1')).body.data, []);
    const insufficient = await f.issueKey({
      name: 'no-sample-write',
      scopes: ['resources:write', 'files:read'],
      resourceIds: ['*'],
      expiresInDays: 1,
    });
    assert.equal(insufficient.status, 201, JSON.stringify(insufficient.body));
    const rejected = await f.request('/sales-sample-attempts', {
      token: insufficient.body.secret,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { fixture: 'us-sales-v1' },
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual((await f.request('/sales-sample-attempts?fixture=us-sales-v1')).body.data, []);
    const key = randomUUID();
    const first = await start(key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.status, 'ready', JSON.stringify(first.body));
    const { id, resourceId, fileVersion } = first.body.data;
    assert.equal(first.headers.get('location'), `sales-sample-attempts/${id}`);
    assert.match(fileVersion, /^"[a-zA-Z0-9-]+"$/);
    const replay = await start(key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.id, id);
    assert.equal(replay.headers.get('location'), `sales-sample-attempts/${id}`);
    const conflict = await f.request('/sales-sample-attempts', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: { fixture: 'different' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await start(randomUUID())).status, 409);
    assert.equal((await f.request(`/sales-sample-attempts/${id}`, {}, 1)).status, 404);
    assert.deepEqual(
      (await f.request('/sales-sample-attempts?fixture=us-sales-v1', {}, 1)).body.data,
      [],
    );
    const resources = await f.request('/resources');
    assert.equal(resources.body.data.length, 1);
    assert.equal(resources.body.data[0].kind, 'filesystem');
    const path = `/files?resourceId=${resourceId}&path=%2F`;
    const files = await f.request(path);
    assert.equal(files.body.data.find((file) => file.path === '/us-sales.csv').content, csv);
    const readKey = await f.issueKey({
      name: 'sample-reader',
      scopes: ['files:read'],
      resourceIds: [resourceId],
      expiresInDays: 1,
    });
    assert.equal(
      (await f.request(`/sales-sample-attempts/${id}`, { token: readKey.body.secret })).status,
      200,
    );
    const otherResource = await f.request('/resources', {
      method: 'POST',
      body: { name: 'other-files', kind: 'filesystem', region: 'aws-us-west-2' },
    });
    assert.equal(otherResource.status, 201, JSON.stringify(otherResource.body));
    const denied = await f.issueKey({
      name: 'other-reader',
      scopes: ['files:read'],
      resourceIds: [otherResource.body.data.id],
      expiresInDays: 1,
    });
    assert.equal(
      (await f.request(`/sales-sample-attempts/${id}`, { token: denied.body.secret })).status,
      404,
    );
    const write = await f.request('/files', {
      method: 'PUT',
      headers: { 'If-Match': fileVersion },
      body: { resourceId, path: '/us-sales.csv', type: 'file', content: 'user changes' },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body));
    await f.restart({ crash: true });
    assert.equal((await start(key)).body.data.id, id);
    assert.equal(
      (await f.request(path)).body.data.find((file) => file.path === '/us-sales.csv').content,
      'user changes',
    );
  },
);

test(
  'concurrent sample starts claim one durable slot',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await productApiFixture(t, 'inProcess', undefined, {
      fresh: true,
      filesProvider: 'local',
    });
    assert.equal((await f.request('/resources')).status, 200);
    const start = (key) =>
      f.request('/sales-sample-attempts', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { fixture: 'us-sales-v1' },
      });
    const [a, b] = await Promise.all([start(randomUUID()), start(randomUUID())]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const created = a.status === 201 ? a : b;
    assert.equal(created.body.data.status, 'ready', JSON.stringify(created.body));
    assert.equal((await f.request('/resources')).body.data.length, 1);
  },
);

test(
  'concurrent same-key requests observe one sample attempt',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    const f = await productApiFixture(t, 'inProcess', undefined, {
      fresh: true,
      filesProvider: 'local',
    });
    assert.equal((await f.request('/resources')).status, 200);
    const key = randomUUID();
    const start = () =>
      f.request('/sales-sample-attempts', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { fixture: 'us-sales-v1' },
      });
    const [first, replay] = await Promise.all([start(), start()]);
    assert.deepEqual([first.status, replay.status].sort(), [200, 201]);
    assert.equal(first.body.data.id, replay.body.data.id);
    assert.equal((await f.request('/resources')).body.data.length, 1);
  },
);

test(
  'sales sample uses the configured live provider and does not repeat an uncertain provision',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 180000 },
  async (t) => {
    await t.test('confirmed file and replay', async (child) => {
      const f = await productApiFixture(child, 'inProcess', undefined, { fresh: true });
      const key = randomUUID();
      const start = () =>
        f.request('/sales-sample-attempts', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: { fixture: 'us-sales-v1' },
        });
      const result = await start();
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.status, 'ready', JSON.stringify(result.body));
      assert.equal(f.provider.creates, 1);
      const file = await f.request(
        `/files/content?resourceId=${result.body.data.resourceId}&path=%2Fus-sales.csv&preview=1`,
      );
      assert.equal(file.body.content, csv);
      assert.equal((await start()).status, 200);
      assert.equal(f.provider.creates, 1);
    });
    await t.test('lost provider response', async (child) => {
      const f = await productApiFixture(child, 'inProcess', undefined, { fresh: true });
      f.provider.lost = true;
      const key = randomUUID();
      const start = () =>
        f.request('/sales-sample-attempts', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: { fixture: 'us-sales-v1' },
        });
      const result = await start();
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.status, 'outcome_unknown', JSON.stringify(result.body));
      assert.equal(f.provider.creates, 1);
      assert.equal((await start()).body.data.id, result.body.data.id);
      assert.equal(f.provider.creates, 1);
    });
    await t.test('unacknowledged file write is observed without repeating it', async (child) => {
      const f = await productApiFixture(child, 'inProcess', undefined, { fresh: true });
      let writes = 0;
      f.provider.writeRace = (path, files) => {
        writes++;
        files.set(path, Buffer.from(csv));
        return { status: 503 };
      };
      const key = randomUUID();
      const start = () =>
        f.request('/sales-sample-attempts', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: { fixture: 'us-sales-v1' },
        });
      const result = await start();
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.status, 'outcome_unknown');
      const path = `/files/content?resourceId=${result.body.data.resourceId}&path=%2Fus-sales.csv&preview=1`;
      assert.equal((await f.request(path)).body.content, csv);
      assert.equal((await start()).body.data.id, result.body.data.id);
      assert.equal(writes, 1);
    });
    await t.test('an existing destination is never overwritten', async (child) => {
      const f = await productApiFixture(child, 'inProcess', undefined, { fresh: true });
      f.provider.setFile('/us-sales.csv', Buffer.from('existing customer data'));
      const key = randomUUID();
      const start = () =>
        f.request('/sales-sample-attempts', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: { fixture: 'us-sales-v1' },
        });
      const result = await start();
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.status, 'outcome_unknown');
      const path = `/files/content?resourceId=${result.body.data.resourceId}&path=%2Fus-sales.csv&preview=1`;
      assert.equal((await f.request(path)).body.content, 'existing customer data');
      assert.equal((await start()).body.data.id, result.body.data.id);
      assert.equal((await f.request(path)).body.content, 'existing customer data');
    });
  },
);
