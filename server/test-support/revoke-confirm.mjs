import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// A 202 confirms the durable Global intent, not that a Region applied it. Reconcile
// only the same immutable Key version and require an applied receipt before restart.
export async function revokeAndConfirmRegion(
  fixture,
  key,
  { timeoutMs = 30_000, delayMs = 250 } = {},
) {
  const revoked = await fixture.revokeKey(key.id);
  assert.equal(revoked.status, 202, JSON.stringify(revoked.body));
  let status = revoked.body.regionalStatus;
  const deadline = Date.now() + timeoutMs;
  while (status === 'pending' && Date.now() < deadline) {
    const attempt = await fixture.deliver(key.id, key.keyVersion + 1);
    assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
    status = attempt.body.data.regionalStatus;
    if (status === 'pending') await delay(delayMs);
  }
  assert.equal(status, 'applied', 'Regional revocation must be applied before restart');
}
