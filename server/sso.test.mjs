import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { createApp } from './index.mjs';
import { loadSsoConfig, createPkcePair, publicSsoInfo, resolveIdentity } from './sso.mjs';
import { trustedProxies, clientSource } from './http-policy.mjs';

// ---------------------------------------------------------------------------
// A local, in-process fake OIDC provider. It never talks to a real network and
// holds NO real credentials. Tests drive it to exercise every security branch.
// ---------------------------------------------------------------------------
let fakeKey, fakeJwk, fakeProvider, issuer;
// Controls injected by individual tests.
let control;

function resetControl() {
  control = {
    issuer: () => issuer,
    audience: 'test-client-id',
    nonce: undefined, // set per login
    signWithGoodKey: true,
    userId: 'user-abc-123',
    orgId: 'org_allowed',
    includeIdToken: true,
    tokenHttpError: false,
    extraClaims: {},
    lastCode: null,
    lastCodeVerifierExpected: null,
  };
}

async function signIdToken() {
  const key = control.signWithGoodKey
    ? fakeKey.privateKey
    : (await generateKeyPair('RS256')).privateKey;
  const claims = {
    nonce: control.nonce,
    org_id: control.orgId,
    ...control.extraClaims,
  };
  if (control.userId !== undefined) claims.sub = control.userId;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(control.issuer())
    .setAudience(control.audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

before(async () => {
  fakeKey = await generateKeyPair('RS256');
  fakeJwk = { ...(await exportJWK(fakeKey.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  resetControl();
  fakeProvider = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        userinfo_endpoint: issuer + '/userinfo',
      });
    if (url.pathname === '/jwks') return json(200, { keys: [fakeJwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      if (control.tokenHttpError) return json(400, { error: 'invalid_grant' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      control.lastCode = form.get('code');
      control.lastCodeVerifierReceived = form.get('code_verifier');
      const body = { token_type: 'Bearer', access_token: 'fake-access', expires_in: 300 };
      if (control.includeIdToken) body.id_token = await signIdToken();
      return json(200, body);
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise((r) => fakeProvider.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${fakeProvider.address().port}`;
});
after(async () => {
  await new Promise((r) => fakeProvider.close(r));
});
beforeEach(() => resetControl());

// A config object matching what loadSsoConfig would produce, but built directly so tests
// never depend on process.env. http loopback issuer is allowed for discovery here.
function testSsoConfig(overrides = {}) {
  return {
    issuer,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://127.0.0.1:4318/api/auth/tidbcloud/callback',
    redirectOrigin: 'http://127.0.0.1:4318',
    scopes: 'openid profile email',
    subjectClaim: 'sub',
    displayClaim: undefined,
    orgClaim: 'org_id',
    allowedOrgs: [],
    // DEFAULT-DENY authorization: an owner-subject allowlist must be configured for a login to
    // become owner. Default to the happy-path subject so the positive-path tests mint a session.
    ownerSubjects: ['user-abc-123'],
    cookieSecure: false,
    postLoginUrl: 'http://127.0.0.1:4318/',
    ...overrides,
  };
}

let directory;
async function appWith(ssoConfig) {
  const dataFile = join(directory, `state-${Math.random().toString(16).slice(2)}.json`);
  const server = await createApp({
    dataFile,
    mysqlProvider: 'local',
    filesProvider: 'local',
    ssoConfig,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}`;
  return { server, address };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tidb-sso-test-'));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

// Drive a login: hit /login (no redirect-follow), capture the flow cookie + authorize params,
// then hit /callback with a chosen state/code. Returns the callback response.
async function startLogin(address) {
  const res = await fetch(address + '/api/auth/tidbcloud/login', { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  const setCookie = res.headers.get('set-cookie') || '';
  const flowCookie = /aw_sso_flow=[^;]+/.exec(setCookie)?.[0];
  return {
    flowCookie,
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
    challenge: location.searchParams.get('code_challenge'),
    challengeMethod: location.searchParams.get('code_challenge_method'),
    authorize: location,
  };
}

async function callback(address, { flowCookie, params }) {
  const query = new URLSearchParams(params).toString();
  return fetch(address + '/api/auth/tidbcloud/callback?' + query, {
    redirect: 'manual',
    headers: flowCookie ? { Cookie: flowCookie } : {},
  });
}

test('loadSsoConfig returns null when nothing is configured (feature disabled)', () => {
  assert.equal(loadSsoConfig({}), null);
  assert.deepEqual(publicSsoInfo(null), { enabled: false });
});

test('loadSsoConfig throws on a partial config instead of silently disabling', () => {
  assert.throws(() => loadSsoConfig({ TIDB_SSO_CLIENT_ID: 'x' }), /CLIENT_SECRET/);
});

test('SSO-disabled: /api/auth/config reports disabled and login/callback 404', async () => {
  const { server, address } = await appWith(null);
  try {
    const cfg = await (await fetch(address + '/api/auth/config')).json();
    assert.deepEqual(cfg, { enabled: false });
    const login = await fetch(address + '/api/auth/tidbcloud/login', { redirect: 'manual' });
    assert.equal(login.status, 404);
    const cb = await fetch(address + '/api/auth/tidbcloud/callback?code=x&state=y', {
      redirect: 'manual',
    });
    assert.equal(cb.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('SSO-disabled does not affect the local demo session', async () => {
  const { server, address } = await appWith(null);
  try {
    const session = await fetch(address + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(session.status, 200);
    assert.ok(session.headers.get('set-cookie').startsWith('aw_session='));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('config endpoint exposes only non-secret booleans/strings when enabled', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const cfg = await (await fetch(address + '/api/auth/config')).json();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.loginPath, '/api/auth/tidbcloud/login');
    const serialized = JSON.stringify(cfg);
    assert.ok(!serialized.includes('test-client-secret'));
    assert.ok(!serialized.includes('client_secret'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('happy path: login redirect carries PKCE S256, then callback mints an aw_session', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    assert.equal(flow.challengeMethod, 'S256');
    assert.ok(flow.challenge && flow.challenge.length >= 43);
    assert.ok(flow.state && flow.nonce);
    control.nonce = flow.nonce;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'auth-code-1', state: flow.state },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://127.0.0.1:4318/');
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /aw_session=[a-f0-9]{64}/);
    assert.match(setCookie, /HttpOnly/);
    // The code verifier the server sent to the token endpoint hashes to the login challenge.
    assert.ok(control.lastCodeVerifierReceived, 'token request carried a code_verifier (PKCE)');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('minted SSO session is accepted by owner-gated endpoints', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    const session = /aw_session=[a-f0-9]+/.exec(res.headers.get('set-cookie'))[0];
    const bootstrap = await fetch(address + '/api/v1/workspaces/ws_agentlab/bootstrap', {
      headers: { Cookie: session },
    });
    assert.equal(bootstrap.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('state mismatch is rejected (no session minted)', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: 'not-the-state' },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'SSO_STATE_MISMATCH');
    assert.ok(!/aw_session=/.test(res.headers.get('set-cookie') || ''));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('missing/altered flow cookie means no stored state (PKCE/state cannot be forged)', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const res = await callback(address, {
      flowCookie: undefined, // attacker has the state from the URL but not the server-side flow
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'SSO_STATE_INVALID');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('nonce mismatch is rejected', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = 'a-different-nonce-than-requested';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'SSO_VERIFICATION_FAILED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ID token with the wrong issuer is rejected', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.issuer = () => 'http://127.0.0.1:1/evil';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ID token with the wrong audience is rejected', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.audience = 'some-other-client';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ID token with a bad signature (unknown key) is rejected', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.signWithGoodKey = false;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('provider error on the callback is handled gracefully', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { error: 'access_denied', state: flow.state },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'SSO_PROVIDER_ERROR');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('token endpoint HTTP error is handled gracefully (no crash, no session)', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.tokenHttpError = true;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
    assert.ok(!/aw_session=/.test(res.headers.get('set-cookie') || ''));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('missing immutable subject claim is rejected (fail closed, no session)', async () => {
  // Configure the subject claim to one the token does not carry -> no subject -> fail closed.
  const { server, address } = await appWith(testSsoConfig({ subjectClaim: 'uid' }));
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce; // token has sub but no `uid` claim
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
    assert.ok(!/aw_session=[a-f0-9]/.test(res.headers.get('set-cookie') || ''));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('org allowlist blocks a disallowed organization', async () => {
  const { server, address } = await appWith(testSsoConfig({ allowedOrgs: ['org_allowed'] }));
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.orgId = 'org_denied';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'SSO_NOT_AUTHORIZED');
    assert.ok(!/aw_session=[a-f0-9]/.test(res.headers.get('set-cookie') || ''));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('org allowlist admits an allowed organization', async () => {
  const { server, address } = await appWith(testSsoConfig({ allowedOrgs: ['org_allowed'] }));
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.orgId = 'org_allowed';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 302);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('callback redirect only targets the configured same-origin post-login URL (no open redirect)', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    // Attacker supplies their own redirect-looking params; they must be ignored.
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: {
        code: 'c',
        state: flow.state,
        redirect_uri: 'https://evil.example.com/steal',
        next: 'https://evil.example.com/steal',
      },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://127.0.0.1:4318/');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('loadSsoConfig rejects a post-login URL on a different origin (open-redirect guard)', () => {
  assert.throws(
    () =>
      loadSsoConfig({
        TIDB_SSO_ISSUER: 'https://sso.example.com',
        TIDB_SSO_CLIENT_ID: 'id',
        TIDB_SSO_CLIENT_SECRET: 'secret',
        TIDB_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/tidbcloud/callback',
        TIDB_SSO_POST_LOGIN_URL: 'https://evil.example.com/',
      }),
    /same origin|share the origin/i,
  );
});

test('logout clears the session so owner-gated endpoints reject it afterward', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    const session = /aw_session=[a-f0-9]+/.exec(res.headers.get('set-cookie'))[0];
    const before = await fetch(address + '/api/v1/workspaces/ws_agentlab/bootstrap', {
      headers: { Cookie: session },
    });
    assert.equal(before.status, 200);
    const logout = await fetch(address + '/api/auth/tidbcloud/logout', {
      method: 'POST',
      headers: { Cookie: session },
    });
    assert.equal(logout.status, 200);
    const after = await fetch(address + '/api/v1/workspaces/ws_agentlab/bootstrap', {
      headers: { Cookie: session },
    });
    assert.equal(after.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the login flow is single-use: replaying the same flow cookie fails', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const first = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(first.status, 302);
    const replay = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, 'SSO_STATE_INVALID');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('createPkcePair produces a URL-safe verifier and matching S256 challenge', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);
});

// --- Blocker 1: with SSO enabled, the anonymous demo session cannot bypass auth ---
test('SSO enabled: /api/session is disabled and cannot mint an owner cookie', async () => {
  const { server, address } = await appWith(testSsoConfig());
  try {
    const res = await fetch(address + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'SSO_REQUIRED');
    assert.ok(!/aw_session=/.test(res.headers.get('set-cookie') || ''));
    // And a request with no credential is still rejected by the owner gate.
    const gated = await fetch(address + '/api/v1/workspaces/ws_agentlab/bootstrap');
    assert.equal(gated.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- Blocker 2: issuer enforced even in explicit-endpoint mode ---
test('explicit-endpoint mode: a token with a wrong issuer is rejected (issuer enforced)', async () => {
  const explicit = testSsoConfig({
    authorizeUrl: issuer + '/authorize',
    tokenUrl: issuer + '/token',
    jwksUrl: issuer + '/jwks',
    // issuer stays the real fake-provider issuer; the token below claims a different one.
  });
  const { server, address } = await appWith(explicit);
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.issuer = () => 'https://attacker.example.com/'; // wrong issuer in the signed token
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 401);
    assert.ok(!/aw_session=[a-f0-9]/.test(res.headers.get('set-cookie') || ''));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('loadSsoConfig requires an issuer even when explicit endpoints are given', () => {
  assert.throws(
    () =>
      loadSsoConfig({
        TIDB_SSO_CLIENT_ID: 'id',
        TIDB_SSO_CLIENT_SECRET: 'secret',
        TIDB_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/tidbcloud/callback',
        TIDB_SSO_AUTHORIZE_URL: 'https://sso.example.com/authorize',
        TIDB_SSO_TOKEN_URL: 'https://sso.example.com/token',
        TIDB_SSO_JWKS_URL: 'https://sso.example.com/jwks',
      }),
    /TIDB_SSO_ISSUER is required/,
  );
});

// --- Blocker 3: owner authorization is default-deny, keyed to the owner-subject allowlist ---
// The authorization DECISION is pure, so it is unit-tested directly against resolveIdentity.
// Two end-to-end tests below confirm the HTTP callback honours the decision (mint vs 403).
const claimsFor = (sub, org = 'org_allowed') => ({ sub, org_id: org, nonce: 'n' });
// Run `fn`, returning the thrown error (assert.throws does not return it).
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected the function to throw.' });
}

test('resolveIdentity: an allowed owner subject is authorized with a distinct principal id', () => {
  const identity = resolveIdentity(
    testSsoConfig({ ownerSubjects: ['person-1'] }),
    claimsFor('person-1'),
  );
  assert.equal(identity.subject, 'person-1');
  assert.match(identity.principalId, /^sso:/);
  assert.match(identity.principalId, /person-1$/);
  assert.ok(!/local-owner/.test(identity.principalId));
});

test('resolveIdentity: a valid, org-allowed account NOT in the owner allowlist is denied owner', () => {
  const error = caught(() =>
    resolveIdentity(
      testSsoConfig({ allowedOrgs: ['org_allowed'], ownerSubjects: ['only-this-person'] }),
      claimsFor('someone-else'),
    ),
  );
  assert.equal(error.ssoError, 'not_authorized');
  // Identity is still captured for auditing even though authorization was denied.
  assert.match(error.identity.principalId, /someone-else$/);
});

test('resolveIdentity: an empty owner allowlist denies owner even for a fully valid login', () => {
  const error = caught(() =>
    resolveIdentity(testSsoConfig({ ownerSubjects: [] }), claimsFor('user-abc-123')),
  );
  assert.equal(error.ssoError, 'not_authorized');
});

test('resolveIdentity: an org match alone never grants owner (org filter is not authorization)', () => {
  // Subject is org-allowed but absent from the (empty) owner allowlist -> denied.
  const error = caught(() =>
    resolveIdentity(
      testSsoConfig({ allowedOrgs: ['org_allowed'], ownerSubjects: [] }),
      claimsFor('member-of-allowed-org'),
    ),
  );
  assert.equal(error.ssoError, 'not_authorized');
});

test('resolveIdentity: two different provider users map to two distinct, auditable principal ids', () => {
  const config = testSsoConfig({ ownerSubjects: ['person-a', 'person-b'] });
  const a = resolveIdentity(config, claimsFor('person-a'));
  const b = resolveIdentity(config, claimsFor('person-b'));
  assert.notEqual(a.principalId, b.principalId);
  assert.notEqual(a.principal, b.principal);
  assert.ok(!/local-owner/.test(a.principalId) && !/local-owner/.test(b.principalId));
});

test('resolveIdentity: a missing immutable subject claim fails closed before authorization', () => {
  const error = caught(() =>
    resolveIdentity(testSsoConfig({ ownerSubjects: ['x'] }), { org_id: 'org_allowed' }),
  );
  assert.equal(error.ssoError, 'invalid_subject');
});

test('resolveIdentity: a non-scalar (array/object) subject claim is rejected (no coercion/collision)', () => {
  const config = testSsoConfig({ ownerSubjects: ['a', 'b'] });
  for (const bad of [['a', 'b'], { id: 'a' }, 12345, null, '', '   ', true]) {
    const error = caught(() => resolveIdentity(config, { sub: bad, nonce: 'n' }));
    assert.equal(error.ssoError, 'invalid_subject', `subject=${JSON.stringify(bad)} must fail`);
  }
  // Two distinct accounts whose subjects would String()-coerce identically must NOT both be let in;
  // both are rejected outright, so they cannot collide into one authorized identity.
});

test('resolveIdentity: owner decision binds to immutable sub, not a reassignable email claim', () => {
  // Owner allowlist lists the user's EMAIL, but the immutable subject is the `sub` value.
  // Listing the email must NOT grant owner; only the immutable sub in the allowlist does.
  const claims = { sub: 'immutable-sub-123', email: 'person@example.com', nonce: 'n' };
  const byEmail = caught(() =>
    resolveIdentity(
      testSsoConfig({ subjectClaim: 'sub', ownerSubjects: ['person@example.com'] }),
      claims,
    ),
  );
  assert.equal(byEmail.ssoError, 'not_authorized');
  // The immutable sub in the allowlist authorizes; the email never participates in the decision.
  const bySub = resolveIdentity(
    testSsoConfig({ subjectClaim: 'sub', ownerSubjects: ['immutable-sub-123'] }),
    claims,
  );
  assert.equal(bySub.subject, 'immutable-sub-123');
});

test('resolveIdentity: display/audit claim is captured but never used for authorization', () => {
  const claims = { sub: 'sub-1', email: 'audit@example.com', nonce: 'n' };
  // Email is only an allowlisted OWNER value here; since the decision uses sub, this must deny.
  const denied = caught(() =>
    resolveIdentity(
      testSsoConfig({
        subjectClaim: 'sub',
        displayClaim: 'email',
        ownerSubjects: ['audit@example.com'],
      }),
      claims,
    ),
  );
  assert.equal(denied.ssoError, 'not_authorized');
  // When the sub IS allowlisted, the display claim is surfaced for auditing only.
  const ok = resolveIdentity(
    testSsoConfig({ subjectClaim: 'sub', displayClaim: 'email', ownerSubjects: ['sub-1'] }),
    claims,
  );
  assert.equal(ok.display, 'audit@example.com');
  assert.equal(ok.subject, 'sub-1');
});

test('E2E: an allowed owner subject gets an owner session; the session principal is distinct', async () => {
  const { server, address } = await appWith(testSsoConfig({ ownerSubjects: ['person-1'] }));
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.userId = 'person-1';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 302);
    const session = /aw_session=[a-f0-9]+/.exec(res.headers.get('set-cookie'))[0];
    const bootstrap = await fetch(address + '/api/v1/workspaces/ws_agentlab/bootstrap', {
      headers: { Cookie: session },
    });
    assert.equal(bootstrap.status, 200);
    // The session's principal is recorded on an action event (auditable, not local-owner).
    const created = await fetch(address + '/api/v1/workspaces/ws_agentlab/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: session },
      body: JSON.stringify({
        name: 'audit-key',
        scopes: ['resources:read'],
        expiresInDays: 7,
        resourceIds: ['*'],
      }),
    });
    assert.equal(created.status, 201);
    const events = await (
      await fetch(address + '/api/v1/workspaces/ws_agentlab/events', {
        headers: { Cookie: session },
      })
    ).json();
    const entry = events.data.find((e) => e.action === 'key.created' && e.resource === 'audit-key');
    assert.match(entry.actor, /person-1/);
    assert.ok(!/local-owner/.test(entry.actor));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('E2E: a valid login whose subject is not an allowed owner is denied (403, no session)', async () => {
  const { server, address } = await appWith(testSsoConfig({ ownerSubjects: ['only-this-person'] }));
  try {
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    control.userId = 'someone-else';
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'SSO_NOT_AUTHORIZED');
    assert.ok(!/aw_session=[a-f0-9]/.test(res.headers.get('set-cookie') || ''));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- Blocker 4: cookies carry Secure on https, not on http loopback ---
test('loadSsoConfig sets cookieSecure true for https and false for loopback http', () => {
  const https = loadSsoConfig({
    TIDB_SSO_ISSUER: 'https://sso.example.com',
    TIDB_SSO_CLIENT_ID: 'id',
    TIDB_SSO_CLIENT_SECRET: 'secret',
    TIDB_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/tidbcloud/callback',
    TIDB_SSO_OWNER_SUBJECTS: 'a',
  });
  assert.equal(https.cookieSecure, true);
  const loopback = loadSsoConfig({
    TIDB_SSO_ISSUER: 'https://sso.example.com',
    TIDB_SSO_CLIENT_ID: 'id',
    TIDB_SSO_CLIENT_SECRET: 'secret',
    TIDB_SSO_REDIRECT_URI: 'http://127.0.0.1:4318/api/auth/tidbcloud/callback',
    TIDB_SSO_OWNER_SUBJECTS: 'a',
  });
  assert.equal(loopback.cookieSecure, false);
});

test('flow + session cookies carry Secure when the deployment is https', async () => {
  const { server, address } = await appWith(testSsoConfig({ cookieSecure: true }));
  try {
    const login = await fetch(address + '/api/auth/tidbcloud/login', { redirect: 'manual' });
    assert.match(login.headers.get('set-cookie') || '', /aw_sso_flow=[^;]+;[^]*Secure/i);
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const cb = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'c', state: flow.state },
    });
    const setCookie = cb.headers.get('set-cookie') || '';
    assert.match(setCookie, /aw_session=[a-f0-9]+;[^]*Secure/i);
    assert.match(setCookie, /HttpOnly/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('http loopback deployment does not set Secure (cookie would be dropped by the browser)', async () => {
  const { server, address } = await appWith(testSsoConfig({ cookieSecure: false }));
  try {
    const login = await fetch(address + '/api/auth/tidbcloud/login', { redirect: 'manual' });
    assert.doesNotMatch(login.headers.get('set-cookie') || '', /Secure/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// Raw HTTP request so we can set headers undici's fetch forbids overriding (Host, X-Forwarded-For).
function rawGet(address, path, headers = {}) {
  const target = new URL(address + path);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// --- Blocker 5 + Blocker 1: login rate limit is PER-SOURCE, not a global lockout ---
test('login rate limit is per-source: one abusive source does not 429 a different source', async () => {
  // The loopback socket peer is an explicitly configured trusted proxy, so the forwarded client
  // (resolved right-to-left, stripping trusted proxies) identifies the source. Drive two distinct
  // real clients through the same server and confirm they have independent budgets.
  const dataFile = join(directory, `state-rl-${Math.random().toString(16).slice(2)}.json`);
  const server = await createApp({
    dataFile,
    mysqlProvider: 'local',
    filesProvider: 'local',
    ssoConfig: testSsoConfig(),
    publicOrigins: ['https://tidb.ai'],
    trustedProxyList: trustedProxies('127.0.0.1,::1'),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}`;
  const login = (xff) =>
    rawGet(address, '/api/auth/tidbcloud/login', { host: 'tidb.ai', 'x-forwarded-for': xff });
  try {
    // Attacker source A exhausts its own budget (limit is 60/window/source).
    let aLimited = 0;
    let aAccepted = 0;
    for (let i = 0; i < 75; i++) {
      const res = await login('203.0.113.7');
      if (res.status === 429) aLimited += 1;
      else if (res.status === 302) aAccepted += 1;
    }
    assert.ok(aLimited > 0, 'the abusive source is rate limited');
    assert.ok(aAccepted <= 60, 'the abusive source cannot exceed its per-source cap');
    // A DIFFERENT source B is unaffected: its first request still succeeds (no global lockout).
    const b = await login('198.51.100.22');
    assert.equal(b.status, 302, 'a different source is not locked out by source A');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('X-Forwarded-For is ignored from an untrusted host (cannot spoof a fresh source)', async () => {
  // No trusted proxy configured: XFF is attacker-controlled and must be ignored, so the socket
  // peer is the source. Rotating XFF values cannot mint fresh per-source budgets.
  const { server, address } = await appWith(testSsoConfig());
  try {
    let limited = 0;
    for (let i = 0; i < 75; i++) {
      // Every request claims a unique XFF; since the host is loopback (untrusted proxy), all
      // share the real socket source and therefore the same budget.
      const res = await rawGet(address, '/api/auth/tidbcloud/login', {
        'x-forwarded-for': `10.0.0.${i}`,
      });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'spoofed XFF does not evade the per-source limit');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- Blocker 6: configurable trusted public origin; loopback-only default preserved ---
test('trusted public origin: a forwarded public Host is accepted when configured', async () => {
  const dataFile = join(directory, `state-pub-${Math.random().toString(16).slice(2)}.json`);
  const server = await createApp({
    dataFile,
    mysqlProvider: 'local',
    filesProvider: 'local',
    publicOrigins: ['https://tidb.ai'],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await rawGet(address, '/api/health', { host: 'tidb.ai' });
    assert.equal(ok.status, 200);
    const denied = await rawGet(address, '/api/health', { host: 'evil.example.com' });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).error.code, 'LOCAL_ONLY');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('loopback-only default: a non-loopback Host is rejected when no trusted origin is set', async () => {
  const { server, address } = await appWith(null);
  try {
    const denied = await rawGet(address, '/api/health', { host: 'tidb.ai' });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).error.code, 'LOCAL_ONLY');
    const loopback = await rawGet(address, '/api/health', { host: '127.0.0.1' });
    assert.equal(loopback.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- Blocker 2: the http(scheme) same-origin exception is loopback-only ---
test('trusted https origin rejects a spoofable http origin of the same host (scheme enforced)', async () => {
  const dataFile = join(directory, `state-org-${Math.random().toString(16).slice(2)}.json`);
  const server = await createApp({
    dataFile,
    mysqlProvider: 'local',
    filesProvider: 'local',
    publicOrigins: ['https://tidb.ai'],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    // The configured trusted origin is https; an http origin of the same host must be rejected
    // (no `http://<host>` exception for public hosts).
    const spoof = await rawGet(address, '/api/health', {
      host: 'tidb.ai',
      origin: 'http://tidb.ai',
    });
    assert.equal(spoof.status, 403);
    assert.equal(JSON.parse(spoof.body).error.code, 'ORIGIN_DENIED');
    // The exact configured https origin is accepted.
    const ok = await rawGet(address, '/api/health', {
      host: 'tidb.ai',
      origin: 'https://tidb.ai',
    });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('loopback keeps its http same-origin exception (local dev unaffected)', async () => {
  const { server, address } = await appWith(null);
  try {
    const host = new URL(address).host; // 127.0.0.1:<port>
    const ok = await rawGet(address, '/api/health', { host, origin: `http://${host}` });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- Re-review round 3: owner subject hard-pinned to `sub`; trusted-proxy by socket peer ---

test('owner authorization is pinned to OIDC sub: a reassignable email can never authorize', () => {
  // Even if an operator lists an email in the owner allowlist, authorization binds ONLY to the
  // immutable `sub` claim — email is not the authorization subject (prevents takeover on a
  // reclaimed address). This is the reachable-config case the earlier tests did not cover.
  const config = {
    issuer: 'https://sso.example.com/oidc',
    subjectClaim: 'sub',
    displayClaim: 'email',
    orgClaim: 'org_id',
    allowedOrgs: [],
    ownerSubjects: ['owner@example.com'], // an email mistakenly placed in the allowlist
  };
  // A login whose email equals the allowlisted email but whose sub is different must be DENIED.
  assert.throws(
    () => resolveIdentity(config, { sub: 'auth0|evil-123', email: 'owner@example.com' }),
    (err) => err.ssoError === 'not_authorized',
    'email in the owner allowlist must NOT grant owner — only the immutable sub does',
  );
  // Owner is granted only when the immutable sub is allowlisted.
  const okConfig = { ...config, ownerSubjects: ['auth0|real-owner'] };
  const id = resolveIdentity(okConfig, { sub: 'auth0|real-owner', email: 'x@example.com' });
  assert.equal(id.subject, 'auth0|real-owner');
});

test('trustedProxies: a malformed CIDR fails fast', () => {
  assert.throws(() => trustedProxies('10.0.0.0/33'), /not a valid IPv4 CIDR/);
  assert.throws(() => trustedProxies('not-an-ip'), /not a valid IP or CIDR/);
});

test('clientSource: a direct client forging Host+XFF is not trusted (limited by socket peer)', () => {
  // No configured trusted proxies: the socket peer is the source, XFF ignored entirely.
  const noTrust = [];
  const a = clientSource(
    {
      socket: { remoteAddress: '198.51.100.9' },
      headers: { host: 'tidb.ai', 'x-forwarded-for': '1.2.3.4' },
    },
    noTrust,
  );
  assert.equal(a, '198.51.100.9', 'untrusted peer: XFF ignored, source is the socket peer');
  // Even if a trusted-proxy CIDR is configured, a peer NOT in it stays untrusted.
  const proxies = trustedProxies('10.0.0.0/8');
  const b = clientSource(
    {
      socket: { remoteAddress: '203.0.113.5' },
      headers: { host: 'tidb.ai', 'x-forwarded-for': '9.9.9.9' },
    },
    proxies,
  );
  assert.equal(b, '203.0.113.5', 'peer outside the trusted CIDR: XFF ignored');
});

test('clientSource: trusted proxy chain resolves the first non-trusted client from the right; IPv4-mapped peer matches', () => {
  const proxies = trustedProxies('10.0.0.0/8');
  // Peer is a trusted proxy; XFF = [client, innerProxy]. Walk right-to-left over
  // [client, innerProxy, peer], strip trusted (peer 10.x, innerProxy 10.x) → client is real.
  const client = clientSource(
    {
      socket: { remoteAddress: '::ffff:10.1.1.1' }, // IPv4-mapped IPv6 peer, matches 10.0.0.0/8
      headers: { 'x-forwarded-for': '203.0.113.77, 10.2.2.2' },
    },
    proxies,
  );
  assert.equal(client, '203.0.113.77', 'resolves the first non-trusted hop from the right');
});

test('trustedProxies: colon-containing junk is rejected (strict IP validation, not fake IPv6)', () => {
  for (const junk of ['not:an:ip', '127.0.0.1:123', '::::', 'tidb.ai:443']) {
    assert.throws(
      () => trustedProxies(junk),
      /not a valid IP or CIDR/,
      `"${junk}" must be rejected as not a valid IP`,
    );
  }
  // A real IPv6 is accepted.
  assert.doesNotThrow(() => trustedProxies('2001:db8::1'));
});

test('trustedProxies: non-canonical IPv4 (leading zeros) is rejected, not silently accepted', () => {
  // These pass a naive octet parser but never equal a real socket peer — reject via net.isIP.
  for (const bad of ['01.2.3.4', '001.002.003.004', '1.2.3.04']) {
    assert.throws(
      () => trustedProxies(bad),
      /not a valid IP or CIDR/,
      `non-canonical IPv4 "${bad}" must be rejected`,
    );
  }
  // Canonical IPv4 and IPv6 are accepted.
  assert.doesNotThrow(() => trustedProxies('10.0.0.1'));
  assert.doesNotThrow(() => trustedProxies('2001:db8::1'));
});

test('subpath SSO scopes flow/session/logout cookies and preserves post-login destination', async () => {
  const config = testSsoConfig({
    publicPath: '/studio',
    redirectUri: 'http://127.0.0.1:4318/studio/api/auth/tidbcloud/callback',
    postLoginUrl: 'http://127.0.0.1:4318/studio/',
  });
  const { server, address } = await appWith(config);
  try {
    const login = await fetch(address + '/api/auth/tidbcloud/login', { redirect: 'manual' });
    assert.match(login.headers.get('set-cookie'), /Path=\/studio\/api\/auth\/tidbcloud;/);
    assert.equal(
      new URL(login.headers.get('location')).searchParams.get('redirect_uri'),
      config.redirectUri,
    );
    const flow = await startLogin(address);
    control.nonce = flow.nonce;
    const res = await callback(address, {
      flowCookie: flow.flowCookie,
      params: { code: 'test-code', state: flow.state },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), config.postLoginUrl);
    const cookies = res.headers.getSetCookie();
    assert.ok(
      cookies.some((cookie) => /^aw_session=/.test(cookie) && /Path=\/studio\/;/.test(cookie)),
    );
    assert.ok(
      cookies.some(
        (cookie) =>
          /^aw_sso_flow=/.test(cookie) &&
          /Path=\/studio\/api\/auth\/tidbcloud; Max-Age=0/.test(cookie),
      ),
    );
    const session = cookies.find((cookie) => cookie.startsWith('aw_session=')).split(';')[0];
    const logout = await fetch(address + '/api/auth/tidbcloud/logout', {
      method: 'POST',
      headers: { Cookie: session },
    });
    assert.match(logout.headers.get('set-cookie'), /Path=\/studio\/; Max-Age=0/);
    assert.equal(
      (
        await fetch(address + '/api/v1/workspaces/ws_agentlab/bootstrap', {
          headers: { Cookie: session },
        })
      ).status,
      401,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('subpath configuration rejects ambiguous prefixes and mismatched callback/return paths', () => {
  const env = {
    TIDB_SSO_ISSUER: 'https://sso.example.com',
    TIDB_SSO_CLIENT_ID: 'fixture-id',
    TIDB_SSO_CLIENT_SECRET: 'fixture-secret',
    WORKSPACE_PUBLIC_PATH: '/studio',
    TIDB_SSO_REDIRECT_URI: 'https://app.example.com/studio/api/auth/tidbcloud/callback',
  };
  assert.equal(loadSsoConfig(env).postLoginUrl, 'https://app.example.com/studio/');
  for (const publicPath of ['/studio/', '//host', '/..', '/a/../b', '/a%2fb', '/a;b', '/a?b'])
    assert.throws(() => loadSsoConfig({ ...env, WORKSPACE_PUBLIC_PATH: publicPath }));
  assert.throws(() =>
    loadSsoConfig({
      ...env,
      TIDB_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/tidbcloud/callback',
    }),
  );
  for (const path of ['/', '/studio-else', '/studio/../outside'])
    assert.throws(() =>
      loadSsoConfig({ ...env, TIDB_SSO_POST_LOGIN_URL: 'https://app.example.com' + path }),
    );
});
