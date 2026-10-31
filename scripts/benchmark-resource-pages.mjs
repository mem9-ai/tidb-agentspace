// Isolated local benchmark for the explicit paged read path, not a capacity certification.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { productApiFixture } from '../server/test-support/product-api-fixture.mjs';

const count = Number(process.env.SCALE_RESOURCES || 10000);
const requests = Number(process.env.SCALE_REQUESTS || 100);
const concurrency = 4;
if (
  !Number.isSafeInteger(count) ||
  count < 100 ||
  count > 1000000 ||
  !Number.isSafeInteger(requests) ||
  requests < 1 ||
  requests > 10000
)
  throw new Error('SCALE_RESOURCES must be 100..1000000 and SCALE_REQUESTS 1..10000');

const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };
try {
  const f = await productApiFixture(t, 'remote');
  assert.equal((await f.request('/resources?limit=1')).status, 200);
  const started = performance.now();
  await f.seedResources(count, (seeded) => {
    if (seeded % 100000 === 0) console.log(JSON.stringify({ seeded }));
  });
  const seedSeconds = (performance.now() - started) / 1000;
  assert.equal((await f.request('/api/health')).status, 200);
  const latencies = [];
  let next = 0;
  const workloadStart = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const n = next++;
        if (n >= requests) break;
        // Deterministic 80/20 hot/cold request mix; this measures pages within one
        // Workspace, not Tenant routing or a measured production traffic profile.
        const index = n % 5 ? (n * 7919) % 100 : (n * 104729) % count;
        const cursor = Buffer.from(`db_scale_${String(index).padStart(8, '0')}`).toString(
          'base64url',
        );
        const before = performance.now();
        const response = await f.request(`/resources?limit=100&cursor=${cursor}`);
        latencies.push(performance.now() - before);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.ok(response.body.data.length <= 100);
        assert.ok(
          response.body.data.every((r) => r.id > `db_scale_${String(index).padStart(8, '0')}`),
        );
      }
    }),
  );
  const workloadSeconds = (performance.now() - workloadStart) / 1000;
  let backfill;
  if (process.env.SCALE_INDEX_BACKFILL === '1') {
    const create = (name, key) =>
      f.request('/resources', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { kind: 'postgresql', name, region: 'automatic' },
      });
    const before = performance.now();
    let result = await create('scale-index-backfill', 'scale-backfill');
    const firstResponseSeconds = (performance.now() - before) / 1000;
    let retries = 0;
    const deadline = Date.now() + 180_000;
    while (result.body.error?.code === 'RESOURCE_INDEX_MIGRATING' && Date.now() < deadline) {
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await create('scale-index-backfill', 'scale-backfill');
    }
    const seconds = (performance.now() - before) / 1000;
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const replay = await create('scale-index-backfill', 'scale-backfill');
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, result.body.data.id);
    const duplicate = await create('scale-1', 'scale-duplicate');
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'NAME_EXISTS');
    backfill = {
      seconds: Number(seconds.toFixed(2)),
      firstResponseSeconds: Number(firstResponseSeconds.toFixed(2)),
      retries,
      replay: 'same resource',
      duplicate: 'NAME_EXISTS',
    };
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p) => Number(latencies[Math.ceil(p * latencies.length) - 1].toFixed(2));
  console.log(
    JSON.stringify(
      {
        resources: count,
        requests,
        concurrency,
        pageSize: 100,
        mix: '80% within first 100 IDs; 20% spread across all IDs',
        seedSeconds: Number(seedSeconds.toFixed(2)),
        workloadSeconds: Number(workloadSeconds.toFixed(2)),
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
        ...(backfill ? { indexBackfill: backfill } : {}),
        benchmarkProcessPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        node: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        cpus: os.cpus().length,
        note: 'Fixture uses a local RustFS object store and remote Meta; resource records are synthetic; optional creation uses a fake provider. Tenant-scale routing is not measured.',
      },
      null,
      2,
    ),
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
