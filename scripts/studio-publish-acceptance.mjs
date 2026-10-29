import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTargetGate } from './console-publish.mjs';

const repository = 'mem9-ai/drive9-fe';
const endpoint = `repos/${repository}`;
const check = (body) =>
  body.check_runs.find((item) => item.name === 'Studio artifact' && item.app?.id === 15368);

export async function acceptPublication(request, pause, run) {
  assert.match(run, /^\d+-\d+$/);
  const branch = `automation/studio-acceptance-${run}`;
  const scope = await request('GET', 'installation/repositories');
  assert.equal(scope.total_count, 1, 'Installation must contain only the website.');
  assert.equal(scope.repositories[0].full_name, repository);
  const main = await request('GET', `${endpoint}/branches/main`);
  validateTargetGate(main);
  const before = main.commit.sha;
  const existing = await request('GET', `${endpoint}/git/ref/heads/${branch}`, undefined, [404]);
  assert.equal(existing.status, 404, 'Acceptance branch already exists.');
  let number;
  let attempted = false;
  try {
    attempted = true;
    await request('POST', `${endpoint}/git/refs`, { ref: `refs/heads/${branch}`, sha: before });
    const old = await request('GET', `${endpoint}/contents/vendor/studio-build.json?ref=${before}`);
    const manifest = JSON.parse(Buffer.from(old.content, 'base64').toString());
    manifest.files['index.html'] = '0'.repeat(64);
    const updated = await request('PUT', `${endpoint}/contents/vendor/studio-build.json`, {
      message: 'test: reject invalid artifact checksum (temporary acceptance)',
      branch,
      sha: old.sha,
      content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64'),
    });
    const head = updated.commit.sha;
    const pr = await request('POST', `${endpoint}/pulls`, {
      title: 'Temporary Studio publication gate acceptance — must not merge',
      head: branch,
      base: 'main',
      body: 'App-authored invalid-checksum fixture. Verifies required-check rejection; automatically closed and branch deleted. No private source or credentials.',
    });
    number = pr.number;
    assert.equal(pr.user.type, 'Bot');
    const checksURL = `${endpoint}/commits/${head}/check-runs?check_name=Studio%20artifact&filter=latest&per_page=100`;
    const pending = check(await request('GET', checksURL));
    assert.notEqual(pending?.status, 'completed', 'Check completed before pending-state test.');
    const merge = async () => {
      const result = await request(
        'PUT',
        `${endpoint}/pulls/${number}/merge`,
        { sha: head, merge_method: 'squash' },
        [405],
      );
      assert.equal(result.status, 405, 'Protected merge unexpectedly succeeded.');
    };
    await merge();
    let failed;
    const deadline = Date.now() + 6 * 60_000;
    for (let attempt = 0; attempt < 120 && Date.now() < deadline; attempt++) {
      failed = check(await request('GET', checksURL));
      if (failed?.status === 'completed') break;
      await pause(5000);
    }
    assert.equal(failed?.conclusion, 'failure', 'Invalid candidate must fail the trusted check.');
    await merge();
    assert.equal((await request('GET', `${endpoint}/branches/main`)).commit.sha, before);
    return {
      installationWebsiteOnly: true,
      appAuthored: true,
      number,
      head,
      pendingBlocked: true,
      failedBlocked: true,
      mainUnchanged: true,
    };
  } finally {
    if (attempted) {
      // Resolve by our known branch even if PR creation committed but its response was lost.
      const prs = await request('GET', `${endpoint}/pulls?state=open&head=mem9-ai:${branch}`);
      for (const pr of prs)
        await request('PATCH', `${endpoint}/pulls/${pr.number}`, { state: 'closed' });
      await request('DELETE', `${endpoint}/git/refs/heads/${branch}`, undefined, [404]);
      assert.equal(
        (await request('GET', `${endpoint}/pulls?state=open&head=mem9-ai:${branch}`)).length,
        0,
      );
      const removed = await request('GET', `${endpoint}/git/ref/heads/${branch}`, undefined, [404]);
      assert.equal(removed.status, 404, 'Acceptance branch cleanup failed.');
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const request = async (method, path, body, allowed = []) => {
      const response = await fetch(`https://api.github.com/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (allowed.includes(response.status)) return { status: response.status };
      assert.ok(response.ok, `GitHub request failed (${response.status}).`);
      return response.status === 204 ? {} : response.json();
    };
    const result = await acceptPublication(
      request,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    );
    await writeFile(
      'studio-acceptance.json',
      JSON.stringify({ ...result, cleanup: true }, null, 2) + '\n',
    );
    console.log('App scope and pending/failed merge rejection passed; fixture cleaned.');
  } catch {
    console.error(
      'Studio publication acceptance failed. Inspect fixture cleanup before retrying. No credential details logged.',
    );
    process.exitCode = 1;
  }
}
