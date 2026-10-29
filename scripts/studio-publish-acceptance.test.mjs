import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptPublication } from './studio-publish-acceptance.mjs';

function fixture({
  lost,
  scope = ['mem9-ai/drive9-fe'],
  conclusion = 'failure',
  pendingForever = false,
} = {}) {
  const state = { branch: false, open: false, merges: 0, checks: 0, writes: 0, cleaned: false };
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const request = async (method, path, body) => {
    if (method !== 'GET') state.writes++;
    if (path === 'installation/repositories')
      return { total_count: scope.length, repositories: scope.map((full_name) => ({ full_name })) };
    if (path.endsWith('/branches/main'))
      return {
        commit: { sha: base },
        protected: true,
        protection: {
          required_status_checks: {
            enforcement_level: 'everyone',
            checks: [{ context: 'Studio artifact', app_id: 15368 }],
          },
        },
      };
    if (path.includes('/git/ref/heads/')) return state.branch ? {} : { status: 404 };
    if (method === 'POST' && path.endsWith('/git/refs')) {
      assert.match(body.ref, /^refs\/heads\/automation\/studio-acceptance-123-1$/);
      assert.equal(body.sha, base);
      state.branch = true;
      if (lost === 'branch') throw new Error('response lost');
      return {};
    }
    if (method === 'GET' && path.includes('/contents/'))
      return {
        sha: 'c'.repeat(40),
        content: Buffer.from(JSON.stringify({ files: { 'index.html': 'd'.repeat(64) } })).toString(
          'base64',
        ),
      };
    if (method === 'PUT' && path.includes('/contents/')) {
      assert.equal(
        JSON.parse(Buffer.from(body.content, 'base64').toString()).files['index.html'],
        '0'.repeat(64),
      );
      if (lost === 'commit') throw new Error('response lost');
      return { commit: { sha: head } };
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      state.open = true;
      if (lost === 'pr') throw new Error('response lost');
      return { number: 44, user: { type: 'Bot' } };
    }
    if (method === 'GET' && path.includes('/check-runs')) {
      assert.ok(path.includes(head));
      state.checks++;
      return {
        check_runs:
          state.checks === 1 || pendingForever
            ? []
            : [{ name: 'Studio artifact', app: { id: 15368 }, status: 'completed', conclusion }],
      };
    }
    if (method === 'PUT' && path.endsWith('/merge')) {
      assert.equal(body.sha, head);
      state.merges++;
      return { status: 405 };
    }
    if (method === 'GET' && path.includes('/pulls?')) return state.open ? [{ number: 44 }] : [];
    if (method === 'PATCH' && path.endsWith('/pulls/44')) {
      state.open = false;
      return {};
    }
    if (method === 'DELETE' && path.includes('/git/refs/heads/')) {
      state.branch = false;
      state.cleaned = true;
      return {};
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
  return { request, state };
}

test('App-only target scope, pending and failed merges are rejected, then cleanup is verified', async () => {
  const { request, state } = fixture();
  const result = await acceptPublication(request, async () => {}, '123-1');
  assert.equal(result.pendingBlocked, true);
  assert.equal(result.failedBlocked, true);
  assert.equal(state.merges, 2);
  assert.equal(state.open, false);
  assert.equal(state.branch, false);
  assert.equal(state.cleaned, true);
});

test('unexpected installation scope rejects before any write', async () => {
  for (const scope of [[], ['mem9-ai/other'], ['mem9-ai/drive9-fe', 'mem9-ai/other']]) {
    const { request, state } = fixture({ scope });
    await assert.rejects(acceptPublication(request, async () => {}, '123-1'));
    assert.equal(state.writes, 0);
  }
});

test('lost mutation responses still close the known-branch PR and delete the branch', async () => {
  for (const lost of ['branch', 'commit', 'pr']) {
    const { request, state } = fixture({ lost });
    await assert.rejects(acceptPublication(request, async () => {}, '123-1'));
    assert.equal(state.cleaned, true);
    assert.equal(state.branch, false);
    assert.equal(state.open, false);
  }
});

test('unexpected check success and check timeout fail and clean the fixture', async () => {
  for (const options of [{ conclusion: 'success' }, { pendingForever: true }]) {
    const { request, state } = fixture(options);
    await assert.rejects(acceptPublication(request, async () => {}, '123-1'));
    assert.equal(state.cleaned, true);
    assert.equal(state.merges, 1);
  }
});
