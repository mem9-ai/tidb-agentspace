import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEvidence, requireCi, repository, trustedRun } from './require-ci.mjs';

const sha = 'a'.repeat(40);
const run = {
  id: 10,
  head_sha: sha,
  head_branch: 'main',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  path: '.github/workflows/ci.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 2,
};
const jobs = ['Quality', 'Browser smoke', 'Rust backend and S3 integration'].map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
}));

test('release evidence requires the same source and trusted main workflow', () => {
  assert.equal(evaluateEvidence(run, jobs, sha, 'full'), true);
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { event: 'workflow_run' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'untrusted/fork' } },
    { repository: { full_name: 'untrusted/fork' } },
  ]) {
    assert.equal(trustedRun({ ...run, ...change }, sha), false);
    assert.throws(() => evaluateEvidence({ ...run, ...change }, jobs, sha, 'full'));
  }
});

test('failed, skipped, ambiguous and incomplete checks cannot authorize a release', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
    assert.throws(() => evaluateEvidence({ ...run, conclusion }, jobs, sha, 'full'));
    assert.throws(() =>
      evaluateEvidence(run, [{ ...jobs[0], conclusion }, ...jobs.slice(1)], sha, 'full'),
    );
  }
  assert.throws(() => evaluateEvidence(run, jobs.slice(0, 2), sha, 'full'));
  assert.throws(() => evaluateEvidence(run, [...jobs, jobs[0]], sha, 'console'));
  const pending = { ...run, status: 'in_progress', conclusion: null };
  assert.equal(evaluateEvidence(pending, jobs, sha, 'full'), false);
  assert.equal(evaluateEvidence(pending, jobs.slice(0, 2), sha, 'console'), true);
  assert.equal(evaluateEvidence(pending, [jobs[0]], sha, 'console'), false);
});

test('browser inapplicability requires explicit scope and native success in both release modes', () => {
  const scope = { name: 'Backend-only scope', status: 'completed', conclusion: 'success' };
  const skipped = [jobs[0], { ...jobs[1], conclusion: 'skipped' }, jobs[2], scope];
  const pending = { ...run, status: 'in_progress', conclusion: null };
  for (const mode of ['console', 'full']) {
    assert.equal(evaluateEvidence(run, skipped, sha, mode), true);
    for (const name of ['Backend-only scope', 'Rust backend and S3 integration']) {
      const without = skipped.filter((job) => job.name !== name);
      assert.throws(() => evaluateEvidence(run, without, sha, mode), /Missing/);
      assert.equal(evaluateEvidence(pending, without, sha, mode), false);
      const target = skipped.find((job) => job.name === name);
      assert.throws(() => evaluateEvidence(run, [...skipped, target], sha, mode), /Ambiguous/);
      for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
        const failed = skipped.map((job) => (job.name === name ? { ...job, conclusion } : job));
        assert.throws(() => evaluateEvidence(run, failed, sha, mode), /Required/);
      }
    }
    for (const conclusion of ['failure', 'cancelled', 'neutral', 'timed_out']) {
      assert.throws(
        () =>
          evaluateEvidence(
            run,
            skipped.map((job) => (job.name === 'Browser smoke' ? { ...job, conclusion } : job)),
            sha,
            mode,
          ),
        /Required/,
      );
    }
    assert.throws(
      () =>
        evaluateEvidence(
          run,
          skipped.filter((job) => job.name !== 'Browser smoke'),
          sha,
          mode,
        ),
      /Missing/,
    );
    assert.throws(
      () => evaluateEvidence({ ...run, head_sha: 'b'.repeat(40) }, skipped, sha, mode),
      /Untrusted/,
    );
  }
  assert.equal(evaluateEvidence(pending, skipped, sha, 'console'), true);
  assert.equal(evaluateEvidence(pending, skipped, sha, 'full'), false);
});

test('waits for registration and the newest attempt, never reuses an older success', async () => {
  let polls = 0;
  const paths = [];
  const id = await requireCi({
    sha,
    mode: 'full',
    attempts: 3,
    pause: async () => {},
    api: async (path) => {
      paths.push(path);
      if (path.includes('/workflows/'))
        return { workflow_runs: polls++ === 0 ? [] : [{ ...run, id: 9 }, run] };
      if (path.includes('/attempts/2/jobs')) return { total_count: jobs.length, jobs };
      return run;
    },
  });
  assert.equal(id, 10);
  assert.ok(paths.includes('/actions/runs/10/attempts/2/jobs?per_page=100'));
  await assert.rejects(
    requireCi({
      sha,
      mode: 'full',
      attempts: 1,
      api: async (path) =>
        path.includes('/workflows/')
          ? { workflow_runs: [run, { ...run, id: 11, conclusion: 'failure' }] }
          : path.includes('/jobs?')
            ? { jobs, total_count: 3 }
            : { ...run, id: 11, conclusion: 'failure' },
    }),
    /did not succeed/,
  );
});

test('a concurrent rerun, truncated jobs or missing registration cannot reuse stale evidence', async () => {
  let reads = 0;
  await assert.rejects(
    requireCi({
      sha,
      mode: 'full',
      attempts: 1,
      api: async (path) => {
        if (path.includes('/workflows/')) return { workflow_runs: [run] };
        if (path.includes('/jobs?')) return { total_count: 3, jobs };
        return reads++ === 0 ? run : { ...run, run_attempt: 3, status: 'queued', conclusion: null };
      },
    }),
    /evidence is unavailable/,
  );
  await assert.rejects(
    requireCi({
      sha,
      mode: 'full',
      attempts: 1,
      api: async (path) =>
        path.includes('/workflows/')
          ? { workflow_runs: [run] }
          : path.includes('/jobs?')
            ? { total_count: 101, jobs }
            : run,
    }),
    /Truncated/,
  );
  await assert.rejects(
    requireCi({ sha, mode: 'full', attempts: 1, api: async () => ({ workflow_runs: [] }) }),
    /evidence is unavailable/,
  );
});
