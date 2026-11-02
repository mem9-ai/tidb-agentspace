import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { reservePorts } from './meta-fixture.mjs';

test('fixture ports remain distinct and unavailable until released', async (t) => {
  const ports = await reservePorts(4);
  t.after(async () => Promise.all(ports.map((entry) => entry.release())));
  assert.equal(new Set(ports.map((entry) => entry.port)).size, 4);
  const occupied = createServer();
  await assert.rejects(
    new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(ports[0].port, '127.0.0.1', resolve);
    }),
    { code: 'EADDRINUSE' },
  );
  await ports[0].release();
  const available = createServer();
  await new Promise((resolve, reject) => {
    available.once('error', reject);
    available.listen(ports[0].port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => available.close(resolve));
  await ports[0].release();
});
