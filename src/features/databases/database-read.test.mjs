import assert from 'node:assert/strict';
import test from 'node:test';
import { readDatabase } from './database-read.ts';

test('a hung database read settles with a retryable error and aborts the transport', async () => {
  let transport;
  const request = readDatabase(
    (signal) => {
      transport = signal;
      return new Promise(() => {});
    },
    new AbortController().signal,
    5,
  );
  await assert.rejects(request, /timed out.*Try again/);
  assert.equal(transport.aborted, true);
});

test('successful reads and original API failures settle without waiting for the deadline', async () => {
  const controller = new AbortController();
  assert.deepEqual(await readDatabase(async () => ({ columns: ['id'] }), controller.signal), {
    columns: ['id'],
  });
  const error = new Error('Permission denied.');
  await assert.rejects(
    readDatabase(async () => {
      throw error;
    }, controller.signal),
    (cause) => cause === error,
  );
});

test('navigation cancellation aborts a pending read and never starts an already canceled read', async () => {
  const controller = new AbortController();
  let transport;
  const pending = readDatabase((signal) => {
    transport = signal;
    return new Promise(() => {});
  }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(transport.aborted, true);
  let calls = 0;
  await assert.rejects(
    readDatabase(async () => {
      calls++;
    }, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('retry uses a fresh signal and a late old response cannot replace its result', async () => {
  let late;
  const request = readDatabase(
    () =>
      new Promise((resolve) => {
        late = resolve;
      }),
    new AbortController().signal,
    5,
  );
  await assert.rejects(request, /timed out/);
  const data = await readDatabase(async () => 'fresh columns', new AbortController().signal);
  late('old columns');
  assert.equal(data, 'fresh columns');
});
