import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { productApiFixture } from './product-api-fixture.mjs';

test(
  'regional request history under concurrent authenticated traffic',
  { timeout: 120000 },
  async (t) => {
    const fixture = await productApiFixture(t, 'remote');
    const baseline = await fixture.request('/resources');
    assert.equal(baseline.status, 200);
    const requestIds = new Set([baseline.headers.get('x-request-id')]);
    const latencies = [];
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 25; i++) {
          const began = performance.now();
          const response = await fixture.request('/resources');
          assert.equal(response.status, 200);
          requestIds.add(response.headers.get('x-request-id'));
          latencies.push(performance.now() - began);
        }
      }),
    );
    const elapsed = performance.now() - start;
    let records;
    let history;
    const drainDeadline = performance.now() + 3000;
    while (true) {
      let cursor = '';
      records = [];
      do {
        const page = await fixture.request(
          `/request-history?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        );
        assert.equal(page.status, 200, JSON.stringify(page.body));
        history = page.body;
        records.push(...history.data);
        cursor = history.nextCursor || '';
      } while (cursor && records.length < 1000);
      const recordedIds = new Set(records.map((record) => record.requestId));
      if ([...requestIds].every((id) => recordedIds.has(id)) || performance.now() >= drainDeadline)
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        requests: 100,
        concurrency: 4,
        elapsedMs: Math.round(elapsed),
        requestsPerSecond: 100000 / elapsed,
        p50Ms: latencies[49],
        p95Ms: latencies[94],
        recorded: records.length,
        matched: records.filter((record) => requestIds.has(record.requestId)).length,
        health: history.health,
      }),
    );
  },
);
