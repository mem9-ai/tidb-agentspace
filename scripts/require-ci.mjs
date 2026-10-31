import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const repository = 'mem9-ai/tidb.ai';
const checks = {
  console: ['Quality', 'Browser smoke'],
  full: ['Quality', 'Browser smoke', 'Rust backend and S3 integration'],
};

export function trustedRun(run, sha) {
  return (
    /^[a-f0-9]{40}$/.test(sha || '') &&
    run.head_sha === sha &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.path === '.github/workflows/ci.yml' &&
    run.head_branch === 'main' &&
    ['push', 'workflow_dispatch'].includes(run.event)
  );
}

export function evaluateEvidence(run, jobs, sha, mode) {
  if (!checks[mode] || !trustedRun(run, sha)) throw new Error('Untrusted CI evidence.');
  if (run.status === 'completed' && run.conclusion !== 'success')
    throw new Error('The exact-commit CI run did not succeed.');
  const browser = jobs.filter((job) => job.name === 'Browser smoke');
  if (browser.length > 1) throw new Error('Ambiguous CI evidence.');
  const backendOnly = browser[0]?.status === 'completed' && browser[0].conclusion === 'skipped';
  const required = backendOnly
    ? ['Quality', 'Backend-only scope', 'Rust backend and S3 integration']
    : checks[mode];
  for (const name of required) {
    const found = jobs.filter((job) => job.name === name);
    if (found.length > 1) throw new Error('Ambiguous CI evidence.');
    const job = found[0];
    if (job?.status === 'completed' && job.conclusion !== 'success')
      throw new Error(`Required CI check failed: ${name}.`);
    if (job?.status !== 'completed') {
      if (run.status === 'completed') throw new Error(`Missing CI check: ${name}.`);
      return false;
    }
  }
  return mode === 'console' || run.status === 'completed';
}

export async function requireCi({ sha, mode, api, pause = delay, attempts = 180 }) {
  if (!checks[mode] || !/^[a-f0-9]{40}$/.test(sha || ''))
    throw new Error('Use a full commit SHA and console/full CI gate.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const list = await api(
      `/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&per_page=100`,
    );
    const run = list.workflow_runs
      .filter((entry) => trustedRun(entry, sha))
      .sort((a, b) => b.id - a.id)[0];
    if (run) {
      const current = await api(`/actions/runs/${run.id}`);
      const result = await api(
        `/actions/runs/${run.id}/attempts/${current.run_attempt}/jobs?per_page=100`,
      );
      if (result.total_count > 100) throw new Error('Truncated CI evidence.');
      if (evaluateEvidence(current, result.jobs, sha, mode)) {
        const latest = await api(`/actions/runs/${run.id}`);
        if (
          latest.run_attempt === current.run_attempt &&
          evaluateEvidence(latest, result.jobs, sha, mode)
        )
          return latest.id;
      }
    }
    if (attempt + 1 < attempts) await pause(10000);
  }
  throw new Error('Exact-commit CI evidence is unavailable. Run CI on this main commit.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, sha] = process.argv.slice(2);
    if (!process.env.GH_TOKEN) throw new Error('Read-only Actions access is required.');
    const id = await requireCi({
      sha,
      mode,
      api: async (path) => {
        const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
          headers: {
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error('Unable to read trusted CI evidence.');
        return response.json();
      },
    });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run-id=${id}\n`);
    console.log(`Verified ${mode} checks for ${sha}: CI run ${id}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
