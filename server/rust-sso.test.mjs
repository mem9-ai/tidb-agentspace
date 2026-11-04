import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';
import { providerFixture } from './test-support/provider-fixture.mjs';
import { createMetaClient } from './meta/client.mjs';
import { assertSessionContract } from './test-support/assert-session-contract.mjs';

const enabled = process.env.WORKSPACE_BACKEND_TEST === '1';
const base = '/api/v1/workspaces/ws_agentlab';
async function fixture(
  t,
  overrides = {},
  managed = false,
  stripPublicPrefix = false,
  analytics = false,
) {
  const metadata = await metaFixture();
  let provider;
  let child;
  let closing;
  // after hooks run in registration order. Stop the client before its dependencies;
  // otherwise their keep-alive connections can delay teardown by minutes.
  const close = () =>
    (closing ||= (async () => {
      try {
        if (child) await metadata.stop(child);
      } finally {
        try {
          if (provider?.listening)
            await new Promise((done, reject) => {
              provider.close((error) => (error ? reject(error) : done()));
              provider.closeAllConnections();
            });
        } finally {
          await metadata.close();
        }
      }
    })());
  t.after(close);
  const region = await metadata.service('native-sso');
  const global = managed ? await metadata.service('global') : undefined;
  if (managed === 'purge' || managed === 'purge-auto') {
    const scope = {
      authorityId: region.server.authorityId,
      ownerKind: 'workspace',
      ownerId: 'ws_agentlab',
      family: 'workspace',
      partitionId: 'primary',
    };
    const changes = [
      {
        key: 'state/workspace',
        expectedVersion: null,
        value: { id: 'ws_agentlab', name: 'Legacy' },
      },
      {
        key: 'credentials/accounts/example',
        expectedVersion: null,
        value: { token: 'synthetic-secret' },
      },
      ...Array.from({ length: 150 }, (_, i) => ({
        key: `state/files/${String(i).padStart(3, '0')}`,
        expectedVersion: null,
        value: { name: 'synthetic' },
      })),
    ];
    await region.client.call({ op: 'commit', scope, mutationId: randomUUID(), changes });
    await region.client.call({
      op: 'commit',
      scope: { ...scope, ownerId: 'unrelated-workspace' },
      mutationId: randomUUID(),
      changes: [
        { key: 'state/workspace', expectedVersion: null, value: { id: 'unrelated-workspace' } },
      ],
    });
  }
  const pair = await generateKeyPair('RS256');
  const wrong = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'native-test',
    alg: 'RS256',
    use: 'sig',
  };
  const control = {
    claims: {},
    challenge: '',
    nonce: '',
    discoveryIssuer: undefined,
    goodKey: true,
  };
  let issuer;
  provider = http.createServer(async (req, res) => {
    if (req.url === '/fixture-held-connection') {
      res.writeHead(200);
      res.flushHeaders();
      return;
    }
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/.well-known/openid-configuration')
      return json(200, {
        issuer: control.discoveryIssuer || issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
      });
    if (req.url === '/jwks') return json(200, { keys: [jwk] });
    if (req.url === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(req.headers.authorization, undefined);
      assert.equal(form.has('client_secret'), false);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), 'native-client');
      assert.equal(
        form.get('redirect_uri'),
        'https://studio.example.test/studio/api/auth/tidbcloud/callback',
      );
      assert.equal(
        createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
        control.challenge,
      );
      control.tokenForm = form;
      const claims = {
        iss: issuer,
        aud: 'native-client',
        sub: 'alice',
        nonce: control.nonce,
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        org_id: 'org-a',
        ...control.claims,
      };
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'native-test' })
        .sign(control.goodKey ? pair.privateKey : wrong.privateKey);
      return json(200, { id_token: token });
    }
    json(404, {});
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${provider.address().port}`;
  const listen = await port();
  const config = {
    bind: `127.0.0.1:${listen}`,
    workspaceId: 'ws_agentlab',
    authorityId: region.server.authorityId,
    initializeWorkspace: true,
    insecureLoopback: true,
    consoleOrigins: [],
    publicOrigins: ['https://studio.example.test'],
    publicPath: '/studio',
    metadata: { transport: 'remote', client: region.clientConfig },
    product: {},
    sso: {
      issuer,
      clientId: 'native-client',
      redirectUri: 'https://studio.example.test/studio/api/auth/tidbcloud/callback',
      ownerSubjects: ['alice'],
      ownerEmailRules: ['*@example.org'],
      allowedOrgs: ['org-a'],
      allowLoopbackHttp: true,
    },
    ...overrides,
  };
  if (managed === 'localGuestGlobal') {
    const localOrigin = `http://127.0.0.1:${listen}`;
    config.publicOrigins = [localOrigin];
    config.consoleOrigins = [localOrigin];
    config.sso = {
      issuer,
      clientId: 'native-client',
      redirectUri: `${localOrigin}/studio/api/auth/tidbcloud/callback`,
      allowLoopbackHttp: true,
    };
  }
  let analyticsPolicy;
  let analyticsSettings;
  if (analytics) {
    const key = resolve(metadata.directory, 'analytics-key');
    analyticsPolicy = resolve(metadata.directory, 'analytics-operators.json');
    await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
    await writeFile(
      analyticsPolicy,
      JSON.stringify({ subjects: [], verifiedEmailDomains: ['pingcap.com'] }),
      { mode: 0o600 },
    );
    config.analytics = { enabled: true, pseudonymKeyFile: key };
    analyticsSettings = {
      pseudonymKeyFile: key,
      operatorsFile: analyticsPolicy,
      returnUrl: 'https://studio.example.test/studio/admin',
      browserEnabled: true,
      campaigns: ['launch'],
    };
  }
  const file = resolve(metadata.directory, 'api.json');
  const plan = resolve(metadata.directory, 'plan.json');
  const services = [];
  if (managed) {
    await global.stop();
    await region.stop();
    global.client.close();
    region.client.close();
    config.metadata = { transport: 'inProcess', authorityId: region.server.authorityId };
    for (const [name, server] of [
      ['global', global.server],
      ['region', region.server],
    ]) {
      const metaFile = resolve(metadata.directory, `${name}-managed.json`);
      await writeFile(metaFile, JSON.stringify(server), { mode: 0o600 });
      services.push({ kind: 'metadata', configFile: metaFile });
    }
  }
  if (managed === 'globalApi' || managed === 'localGuestGlobal') {
    const { globalApiProfile } = await import('../scripts/global-api-profile.mjs');
    const clockDirectory = resolve(metadata.directory, 'portal-clocks');
    await mkdir(clockDirectory, { mode: 0o700 });
    const profile = await globalApiProfile({
      directory: resolve(metadata.directory, 'portal-security'),
      mountDirectory: resolve(metadata.directory, 'portal-security'),
      api: config,
      clockDirectory,
      initializeClock: true,
    });
    const controlPort = await port();
    profile.api.security.control.bind = `127.0.0.1:${controlPort}`;
    profile.global.regionControls[0].origin = `https://127.0.0.1:${controlPort}`;
    profile.api.security.regionConnection.origin = `https://127.0.0.1:${controlPort}`;
    profile.global.regionConnection.bind = `127.0.0.1:${controlPort}`;
    Object.assign(config, profile.api);
    if (analyticsSettings) profile.global.analytics = analyticsSettings;
    const globalFile = resolve(metadata.directory, 'global-api.json');
    await writeFile(globalFile, JSON.stringify(profile.global), { mode: 0o600 });
    services.push({ kind: 'global', configFile: globalFile });
  }
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  services.push({ kind: 'workspace', configFile: file });
  await writeFile(plan, JSON.stringify({ format: 1, services }), { mode: 0o600 });
  let log = '';
  const start = () => {
    child = spawn(
      resolve('meta-service/target/debug/workspace-backend'),
      ['serve', '--config', plan],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(managed
            ? { WORKSPACE_GUEST_ENABLED: managed === 'accountOnly' ? 'false' : 'true' }
            : {}),
          ...(managed === 'purge-auto' ? { WORKSPACE_RETIRE_LEGACY: 'ws_agentlab' } : {}),
        },
      },
    );
    child.stdout.on('data', (b) => {
      log += b;
    });
    child.stderr.on('data', (b) => {
      log += b;
    });
  };
  start();
  const origin = `http://127.0.0.1:${listen}`;
  const request = (path, { method = 'GET', cookie, body, raw, headers = {} } = {}) =>
    new Promise((done, reject) => {
      if (
        (cookie || headers.Cookie || headers.cookie) &&
        !headers.Authorization &&
        !headers.authorization
      )
        path = path.replace('/api/v1/workspaces', '/api/portal/v1/workspaces');
      const req = http.request(
        origin + (stripPublicPrefix ? path.replace(/^\/studio(?=\/)/, '') : path),
        {
          method,
          headers: {
            Host: managed === 'localGuestGlobal' ? `127.0.0.1:${listen}` : 'studio.example.test',
            Origin:
              managed === 'localGuestGlobal'
                ? `http://127.0.0.1:${listen}`
                : 'https://studio.example.test',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (b) => chunks.push(b));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const raw = bytes.toString();
            done({
              status: res.statusCode,
              headers: res.headers,
              body: res.headers['content-type']?.includes('application/octet-stream')
                ? bytes
                : raw
                  ? JSON.parse(raw)
                  : null,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
    });
  await until(async () => {
    if (child.exitCode !== null) throw Error(log);
    assert.equal((await request('/api/health')).status, 200);
  });
  async function flow(operator = false) {
    const r = await request('/studio/api/auth/tidbcloud/login' + (operator ? '?operator=1' : ''));
    assert.equal(r.status, 302);
    const url = new URL(r.headers.location);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    control.challenge = url.searchParams.get('code_challenge');
    control.nonce = url.searchParams.get('nonce');
    return {
      cookie: r.headers['set-cookie'].map((v) => v.split(';')[0]).join('; '),
      state: url.searchParams.get('state'),
      response: r,
    };
  }
  async function callback(f, options = {}) {
    return request(
      '/studio/api/auth/tidbcloud/callback?code=fixture-code&state=' + encodeURIComponent(f.state),
      { cookie: f.cookie, ...options },
    );
  }
  async function restartWithoutGlobal() {
    assert.equal(managed, true);
    await metadata.stop(child);
    await writeFile(file, JSON.stringify({ ...config, initializeWorkspace: false }), {
      mode: 0o600,
    });
    await writeFile(
      resolve(metadata.directory, 'global-managed.json'),
      JSON.stringify({
        ...global.server,
        s3: { ...global.server.s3, prefix: 'intentionally-offline-account-global' },
      }),
      { mode: 0o600 },
    );
    start();
    await until(async () => {
      if (child.exitCode !== null) throw Error(log);
      assert.equal((await request('/api/health')).status, 200);
    });
  }
  async function purgeLegacy() {
    return promisify(execFile)(
      resolve('meta-service/target/debug/workspace-backend'),
      ['purge-legacy', '--config', plan, '--workspace', 'ws_agentlab'],
      { env: { ...process.env, WORKSPACE_GUEST_ENABLED: 'true' } },
    );
  }
  async function stopHost() {
    await metadata.stop(child);
  }
  async function reopenRegion() {
    return metadata.service('native-sso', { previous: region });
  }
  async function policy(workspace) {
    const client = await createMetaClient(region.clientConfig);
    try {
      const result = await client.call({
        op: 'get',
        scope: {
          authorityId: region.server.authorityId,
          ownerKind: 'workspace',
          ownerId: workspace,
          family: 'regional-policy',
          partitionId: 'primary',
        },
        keys: ['owner-policy'],
      });
      return result.records['owner-policy'].value;
    } finally {
      client.close();
    }
  }
  return {
    origin,
    analyticsPolicy,
    request,
    flow,
    callback,
    control,
    issuer,
    config,
    child,
    close,
    async restartHost() {
      await metadata.stop(child);
      const resumed = {
        ...config,
        initializeWorkspace: false,
        security: { ...config.security, initializeClock: false },
      };
      await writeFile(file, JSON.stringify(resumed), { mode: 0o600 });
      const globalFile = resolve(metadata.directory, 'global-api.json');
      const globalConfig = JSON.parse(
        await (await import('node:fs/promises')).readFile(globalFile, 'utf8'),
      );
      globalConfig.initializeClock = false;
      await writeFile(globalFile, JSON.stringify(globalConfig), { mode: 0o600 });
      start();
      try {
        await until(async () => {
          if (child.exitCode !== null || child.signalCode) throw Error(log);
          assert.equal((await request('/api/health')).status, 200);
        });
      } catch (error) {
        throw new Error('Restart failed: ' + String(error) + ' ' + log.slice(-4000), {
          cause: error,
        });
      }
    },
    restartWithoutGlobal,
    purgeLegacy,
    stopHost,
    reopenRegion,
    policy,
    log: () => log,
  };
}

test(
  'native SSO fixture closes active provider connections without waiting for client timeouts',
  { skip: !enabled, timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    let request;
    let connectionClosed;
    await new Promise((done, reject) => {
      request = http.get(f.issuer + '/fixture-held-connection', (response) => {
        response.on('error', () => {});
        connectionClosed = new Promise((closed) => response.once('close', closed));
        done();
      });
      request.on('error', reject);
    });
    let neededWatchdog = false;
    const watchdog = setTimeout(() => {
      neededWatchdog = true;
      request.destroy();
    }, 5000);
    try {
      await f.close();
      assert.equal(neededWatchdog, false, 'Fixture teardown waited for its client to time out');
      await connectionClosed;
      assert.ok(f.child.exitCode !== null || f.child.signalCode);
    } finally {
      clearTimeout(watchdog);
      request.destroy();
    }
  },
);

test(
  'native hosted /studio SSO, stable identity, owner grants, logout and replay protection',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const { request, flow, callback, control } = f;
    assert.equal((await request('/studio/api/auth/config')).body.enabled, true);
    assert.equal((await request('/api/session', { method: 'POST', body: {} })).status, 403);
    assert.equal((await request(base)).status, 401);
    assert.equal(
      (await request('/api/auth/config', { headers: { Host: 'hostile.example' } })).status,
      403,
    );
    assert.equal(
      (await request('/api/auth/config', { headers: { Origin: 'http://studio.example.test' } }))
        .status,
      403,
    );
    const login = await flow();
    assert.match(
      login.response.headers['set-cookie'][0],
      /HttpOnly; SameSite=Lax; Secure; Path=\/studio\/api\/auth\/tidbcloud/,
    );
    const accepted = await callback(login);
    assert.equal(accepted.status, 302);
    assert.equal(accepted.headers.location, 'https://studio.example.test/studio/');
    assert.match(
      accepted.headers['set-cookie'][0],
      /HttpOnly; SameSite=Strict; Secure; Path=\/studio\//,
    );
    const cookie = accepted.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request('/studio' + base, { cookie })).status, 200);
    assert.equal(
      (await request(base, { cookie, headers: { Authorization: 'Bearer invalid' } })).status,
      401,
    );
    assert.equal((await callback(login)).body.error.code, 'SSO_STATE_INVALID');
    const updated = await request(base + '/settings', {
      method: 'PATCH',
      cookie,
      body: { workspaceName: 'SSO workspace', name: 'Alice', description: 'SSO audited' },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const audit = await request(base + '/audit-history', { cookie });
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    const records = audit.body.data.filter(
      (entry) => entry.requestId === updated.headers['x-request-id'],
    );
    assert.equal(records.length, 2);
    assert.match(records[0].actor.id, /^owner-[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(records).includes('alice'), false);
    const events = await request(base + '/events', { cookie });
    assert.ok(JSON.stringify(events.body).includes('tidb:alice'));
    assert.ok(!JSON.stringify(events.body).includes(cookie));
    assert.equal(
      (await request('/api/auth/tidbcloud/logout', { method: 'POST', cookie })).status,
      200,
    );
    assert.equal((await request(base, { cookie })).status, 401);
    for (const [claims, goodKey, status] of [
      [{ iss: 'https://other.example/' }, true, 401],
      [{ aud: 'wrong' }, true, 401],
      [{ nonce: 'wrong' }, true, 401],
      [{ exp: 1 }, true, 401],
      [{ sub: ['alice'] }, true, 401],
      [{}, false, 401],
      [{ sub: 'bob' }, true, 403],
      [{ sub: 'bob', email: 'bob@example.org', email_verified: 'true' }, true, 403],
      [{ sub: 'bob', email: 'bob@example.org.evil', email_verified: true }, true, 403],
      [{ org_id: 'other' }, true, 403],
      [{ sub: 'bob', email: 'BOB@EXAMPLE.ORG', email_verified: true }, true, 302],
    ]) {
      control.claims = claims;
      control.goodKey = goodKey;
      const login = await flow();
      const r = await callback(login);
      assert.equal(r.status, status, JSON.stringify(claims));
      assert.ok(r.headers['set-cookie'].some((v) => v.includes('Max-Age=0')));
      if (status !== 302)
        assert.ok(!r.headers['set-cookie'].some((v) => v.startsWith('aw_session=')));
    }
    control.claims = {};
    control.goodKey = true;
    const mismatched = await flow();
    assert.equal((await callback({ ...mismatched, state: 'wrong' })).status, 400);
    assert.equal((await callback(mismatched)).body.error.code, 'SSO_STATE_INVALID');
    const browserBound = await flow();
    assert.equal((await callback({ ...browserBound, cookie: '' })).status, 400);
    for (let i = 0; i < 25; i++) {
      const r = await request('/api/auth/tidbcloud/login', {
        headers: { 'X-Forwarded-For': `192.0.2.${i}` },
      });
      if (i === 24) assert.equal(r.status, 429);
    }
  },
);

test(
  'local Guest manages a scoped Global Key without another login and logout denies it',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const f = await fixture(t, {}, 'localGuestGlobal');
    async function guest() {
      const response = await f.request('/studio/api/auth/guest', { method: 'POST' });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return {
        workspace: response.body.workspaceId,
        cookie: response.headers['set-cookie'].find((v) => v.startsWith('aw_guest=')).split(';')[0],
      };
    }
    const first = await guest();
    const second = await guest();
    const publicSpec = await f.request('/studio/api/openapi.json');
    assert.equal(publicSpec.status, 200);
    assert.equal(publicSpec.body.servers[0].url, f.origin + '/studio/api');
    assert.ok(publicSpec.body.paths['/v1/token-issuances'].post);
    const global = '/studio/api/global';
    const session = (workspace) => `${global}/api/auth/session?workspaceId=${workspace}`;
    assert.equal((await f.request(session(first.workspace), { cookie: first.cookie })).status, 200);
    assert.equal(
      (await f.request(session(second.workspace), { cookie: first.cookie })).status,
      404,
    );
    assert.equal((await f.request(session(first.workspace))).status, 401);

    const path = `${global}/api/v1/workspaces/${first.workspace}`;
    const created = await f.request(`${path}/keys`, {
      method: 'POST',
      cookie: first.cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        name: 'guest-agent',
        scopes: ['resources:read'],
        resourceIds: ['*'],
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.regionalStatus, 'applied');
    assert.ok(created.body.data.expiresAt <= Math.floor(Date.now() / 1000) + 86400);
    assert.equal((await f.request(`${path}/keys`, { cookie: second.cookie })).status, 404);
    const discovered = await f.request('/studio/api/v1/token-issuances', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.body.secret}` },
      body: { audience: 'global' },
    });
    assert.equal(discovered.status, 201, JSON.stringify(discovered.body));
    assert.equal(discovered.body.workspaceId, first.workspace);
    const stripped = await f.request('/api/v1/token-issuances', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.body.secret}` },
      body: { audience: 'global' },
    });
    assert.equal(stripped.status, 201, JSON.stringify(stripped.body));
    assert.equal(stripped.body.workspaceId, first.workspace);
    assert.equal(
      (
        await f.request(`/api/v1/workspaces/${first.workspace}/region-route`, {
          headers: { Authorization: `Bearer ${stripped.body.accessToken}` },
        })
      ).status,
      307,
    );
    assert.match(discovered.headers.location, /^\/studio\/api\/v1\/workspaces\/[^/]+\/issuances\//);
    assert.equal(
      (
        await f.request(discovered.headers.location, {
          headers: { Authorization: `Bearer ${discovered.body.accessToken}` },
        })
      ).status,
      200,
    );
    const route = await f.request(`/studio/api/v1/workspaces/${first.workspace}/region-route`, {
      headers: { Authorization: `Bearer ${discovered.body.accessToken}` },
    });
    assert.equal(route.status, 307);
    assert.equal(route.headers['x-region-id'], 'region:native-sso');
    assert.match(route.headers.location, /^http:\/\/127\.0\.0\.1:\d+\/studio$/);
    assert.notEqual(
      (
        await f.request(`/studio/api/v1/workspaces/${second.workspace}/region-route`, {
          headers: { Authorization: `Bearer ${discovered.body.accessToken}` },
        })
      ).status,
      307,
    );
    const directIssuance = await f.request('/studio/api/v1/token-issuances', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.body.secret}` },
      body: { audience: 'region' },
    });
    assert.equal(directIssuance.status, 201, JSON.stringify(directIssuance.body));
    assert.equal(directIssuance.body.workspaceId, first.workspace);
    assert.equal(directIssuance.body.region.regionId, 'region:native-sso');
    assert.equal(
      route.headers.location,
      directIssuance.body.region.apiOrigin + directIssuance.body.region.apiPathPrefix,
    );
    const { connectWorkspace } = await import('../src/generated/workspace-agent.mjs');
    const client = await connectWorkspace({
      endpoint: f.origin + '/studio/api',
      apiKey: created.body.secret,
    });
    assert.ok(Array.isArray((await client.listResources()).data));
    assert.notEqual(
      (
        await f.request(`${path}/region-route`, {
          headers: { Authorization: `Bearer ${created.body.secret}` },
        })
      ).status,
      307,
    );
    const exchange = () =>
      f.request(`${path}/token-issuances`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.body.secret}` },
        body: { audience: 'region:native-sso' },
      });
    const issued = await exchange();
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const resources = `/studio/api/v1/workspaces/${first.workspace}/resources`;
    assert.equal(
      (
        await f.request(resources, {
          headers: { Authorization: `Bearer ${issued.body.accessToken}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request('/studio/api/auth/guest/logout', { method: 'POST', cookie: first.cookie }))
        .status,
      200,
    );
    assert.notEqual((await exchange()).status, 201);
    await assert.rejects(client.renew());
    assert.notEqual(
      (
        await f.request(resources, {
          headers: { Authorization: `Bearer ${issued.body.accessToken}` },
        })
      ).status,
      200,
    );
  },
);

test(
  'Guest can authorize a scoped client to analyze the sample and save a report',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const f = await fixture(t, {}, 'globalApi', true);
    const entered = await f.request('/studio/api/auth/guest', { method: 'POST' });
    assert.equal(entered.status, 200, JSON.stringify(entered.body));
    const workspace = entered.body.workspaceId;
    const cookie = entered.headers['set-cookie']
      .find((v) => v.startsWith('aw_guest='))
      .split(';')[0];
    const sample = await f.request(
      `/studio/api/portal/v1/workspaces/${workspace}/sales-sample-attempts`,
      {
        method: 'POST',
        cookie,
        headers: { 'Idempotency-Key': randomUUID() },
        body: { fixture: 'us-sales-v1' },
      },
    );
    assert.equal(sample.status, 201, JSON.stringify(sample.body));
    assert.equal(sample.body.data.status, 'ready', JSON.stringify(sample.body));
    const resourceId = sample.body.data.resourceId;
    const key = await f.request(`/studio/api/global/api/portal/v1/workspaces/${workspace}/keys`, {
      method: 'POST',
      cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        name: 'sales-agent',
        scopes: ['resources:read', 'files:read', 'files:analyze', 'files:write'],
        resourceIds: [resourceId],
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
    });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const issue = () =>
      f.request('/studio/api/v1/token-issuances', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.body.secret}` },
        body: { audience: 'region' },
      });
    const token = await issue();
    assert.equal(token.status, 201, JSON.stringify(token.body));
    const authorization = { Authorization: `Bearer ${token.body.accessToken}` };
    const root = `/studio/api/v1/workspaces/${workspace}`;
    const analysis = await f.request(`${root}/file-analyses`, {
      method: 'POST',
      headers: authorization,
      body: {
        resourceId,
        path: '/us-sales.csv',
        engine: 'duckdb',
        sql: 'SELECT state, SUM(sales_usd) AS sales FROM file GROUP BY state ORDER BY sales DESC',
      },
    });
    assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
    assert.equal(analysis.body.readOnly, true);
    assert.deepEqual(
      analysis.body.rows.map((row) => [row.state, Number(row.sales)]),
      [
        ['California', 48000],
        ['Texas', 20000],
        ['New York', 12000],
        ['Washington', 8000],
        ['Florida', 7000],
        ['Massachusetts', 5000],
      ],
    );
    const report = await f.request(`${root}/files`, {
      method: 'PUT',
      headers: { ...authorization, 'If-None-Match': '*' },
      body: {
        resourceId,
        path: '/us-sales-report.md',
        type: 'file',
        content: '# Sales report\nCalifornia: $48,000\n',
      },
    });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    const freshToken = await issue();
    assert.equal(freshToken.status, 201, JSON.stringify(freshToken.body));
    const read = await f.request(
      `${root}/files/content?resourceId=${resourceId}&path=%2Fus-sales-report.md&preview=1`,
      {
        headers: { Authorization: `Bearer ${freshToken.body.accessToken}` },
      },
    );
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.match(read.body.content, /California: \$48,000/);
    assert.equal(
      (
        await f.request(`${root}/files`, {
          method: 'PUT',
          headers: { ...authorization, 'If-None-Match': '*' },
          body: { resourceId, path: '/us-sales-report.md', type: 'file', content: 'overwrite' },
        })
      ).status,
      412,
    );
  },
);

test(
  'hosted Guest Key expires with its Workspace and logout denies Global and Region access',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const f = await fixture(t, {}, 'globalApi', true);
    const enter = async () => {
      const response = await f.request('/studio/api/auth/guest', { method: 'POST' });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return {
        workspace: response.body.workspaceId,
        cookie: response.headers['set-cookie'].find((v) => v.startsWith('aw_guest=')).split(';')[0],
      };
    };
    const guest = await enter();
    const other = await enter();
    const global = `/studio/api/global/api/v1/workspaces/${guest.workspace}`;
    const listing = await f.request(`${global}/keys`, { cookie: guest.cookie });
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    assert.deepEqual(listing.body.data, []);
    assert.equal((await f.request(`${global}/keys`, { cookie: other.cookie })).status, 404);
    const resources = `/studio/api/v1/workspaces/${guest.workspace}/resources`;
    const filesystem = await f.request(resources, {
      method: 'POST',
      cookie: guest.cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { kind: 'filesystem', name: 'guest-api-test', region: 'aws-ap-southeast-1' },
    });
    assert.equal(filesystem.status, 201, JSON.stringify(filesystem.body));
    const filesystemId = filesystem.body.data.id;
    const before = Math.floor(Date.now() / 1000);
    const created = await f.request(`${global}/keys`, {
      method: 'POST',
      cookie: guest.cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        name: 'guest-agent',
        scopes: ['resources:read', 'files:read', 'files:write'],
        resourceIds: [filesystemId],
        expiresAt: before + 30 * 86400,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.data.expiresAt <= before + 86400);
    assert.ok(created.body.data.expiresAt > before);
    const issue = () =>
      f.request('/studio/api/v1/token-issuances', {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.body.secret}` },
        body: { audience: 'region' },
      });
    const globalToken = await f.request('/studio/api/v1/token-issuances', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.body.secret}` },
      body: { audience: 'global' },
    });
    assert.equal(globalToken.status, 201, JSON.stringify(globalToken.body));
    const issued = await issue();
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const token = issued.body.accessToken;
    const files = `/studio/api/v1/workspaces/${guest.workspace}/files`;
    const content = {
      resourceId: filesystemId,
      path: '/agent.txt',
      type: 'file',
      content: 'guest test',
    };
    const put = () =>
      f.request(files, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: content,
      });
    assert.equal((await put()).status, 200);
    const read = () =>
      f.request(`${files}?resourceId=${filesystemId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    const beforeLogout = await read();
    assert.equal(beforeLogout.status, 200, JSON.stringify(beforeLogout.body));
    assert.ok(
      beforeLogout.body.data.some(
        (file) => file.path === '/agent.txt' && file.content === 'guest test',
      ),
    );
    assert.equal(
      (await f.request('/studio/api/auth/guest/logout', { method: 'POST', cookie: guest.cookie }))
        .status,
      200,
    );
    assert.notEqual((await issue()).status, 201);
    assert.notEqual(
      (
        await f.request(`/studio/api/v1/workspaces/${guest.workspace}/regions`, {
          headers: { Authorization: `Bearer ${globalToken.body.accessToken}` },
        })
      ).status,
      200,
    );
    assert.notEqual((await read()).status, 200);
    assert.notEqual((await put()).status, 200);
    assert.equal(
      (
        await f.request(`/studio/api/global/api/v1/workspaces/${other.workspace}/keys`, {
          cookie: other.cookie,
        })
      ).status,
      200,
    );
  },
);

for (const gateway of ['preserved', 'stripped']) {
  test(
    `one Portal SSO callback establishes isolated Global and Region sessions through a ${gateway} gateway`,
    { skip: !enabled, timeout: 120000 },
    async (t) => {
      const f = await fixture(
        t,
        { publicOrigins: ['https://studio.example.test', 'https://gateway.example.test'] },
        'globalApi',
        gateway === 'stripped',
      );
      const global = '/studio/api/global';
      const regional = '/studio';
      assert.equal((await f.request(global + '/api/health')).status, 200);
      assert.equal(
        (await f.request(global + '/api/health', { headers: { Host: 'gateway.example.test' } }))
          .status,
        200,
      );
      assert.equal(
        (
          await f.request('/studio/api/v1/token-issuances', {
            method: 'POST',
            headers: { Host: 'gateway.example.test' },
            body: { audience: 'region' },
          })
        ).status,
        401,
      );
      assert.equal(
        (await f.request(global + '/api/health', { headers: { Host: 'unexpected.example' } }))
          .status,
        403,
      );
      assert.equal(
        (
          await f.request(global + '/api/health', {
            headers: { Origin: 'https://unexpected.example' },
          })
        ).status,
        403,
      );
      const schema = await f.request(global + '/openapi.json');
      assert.equal(schema.status, 200);
      assert.equal(schema.body.servers[0].url, 'https://studio.example.test/studio/api/global');
      const login = await f.request(global + '/api/auth/tidbcloud/login?workspaceId=ignored');
      assert.equal(login.status, 303);
      assert.equal(login.headers.location, '/studio/api/auth/tidbcloud/login');
      assert.equal(login.headers['set-cookie'], undefined, 'no second OIDC flow');
      const pending = await f.flow();
      assert.equal(
        new URL(pending.response.headers.location).searchParams.get('redirect_uri'),
        'https://studio.example.test/studio/api/auth/tidbcloud/callback',
      );
      const signedIn = await f.callback(pending);
      assert.equal(signedIn.status, 302, JSON.stringify(signedIn.body));
      const cookies = signedIn.headers['set-cookie'];
      const account = cookies.find((c) => c.startsWith('aw_account=')).split(';')[0];
      const ownerHeader = cookies.find((c) => c.startsWith('aw_global_owner='));
      assert.ok(
        ownerHeader.includes('HttpOnly') &&
          ownerHeader.includes('Secure') &&
          ownerHeader.includes('SameSite=Strict'),
      );
      assert.ok(ownerHeader.includes('Path=/studio/;'));
      const owner = ownerHeader.split(';')[0];
      const workspace = (await f.request(`${regional}/api/v1/workspaces`, { cookie: account })).body
        .data[0].id;
      const session = `${global}/api/auth/session?workspaceId=${workspace}`;
      assert.equal((await f.request(session, { cookie: owner })).status, 200);
      assert.equal((await f.request(session, { cookie: account })).status, 401);
      assert.equal(
        (await f.request(`${regional}/api/v1/workspaces/${workspace}`, { cookie: owner })).status,
        401,
      );
      assert.equal(
        (
          await f.request(`${global}/api/auth/session?workspaceId=another-workspace`, {
            cookie: owner,
          })
        ).status,
        401,
      );
      assert.equal((await f.callback(pending)).status, 400, 'single-use callback');
      const created = await f.request(`${global}/api/v1/workspaces/${workspace}/keys`, {
        method: 'POST',
        cookie: owner,
        headers: { 'Idempotency-Key': randomUUID() },
        body: {
          name: 'Research agent',
          scopes: ['resources:read', 'resources:write'],
          resourceIds: ['*'],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.regionalStatus, 'applied');
      const token = await f.request(`${global}/api/v1/workspaces/${workspace}/token-issuances`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${created.body.secret}`,
          'Idempotency-Key': randomUUID(),
        },
        body: { audience: f.config.authorityId },
      });
      assert.equal(token.status, 201, JSON.stringify(token.body));
      const claims = JSON.parse(Buffer.from(token.body.accessToken.split('.')[1], 'base64url'));
      assert.equal(claims.iss, 'https://studio.example.test/studio/api/global');
      assert.equal(token.body.region.apiPathPrefix, '/studio');
      const firstResource = await f.request(
        `${regional}/api/v1/workspaces/${workspace}/resources`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token.body.accessToken}` },
          body: { kind: 'filesystem', name: 'research-files', region: 'aws-ap-southeast-1' },
        },
      );
      assert.equal(firstResource.status, 201, JSON.stringify(firstResource.body));
      const loggedOut = await f.request('/studio/api/auth/tidbcloud/logout', {
        method: 'POST',
        cookie: `${account}; ${owner}`,
      });
      assert.equal(loggedOut.status, 200, JSON.stringify(loggedOut.body));
      assert.ok(
        loggedOut.headers['set-cookie'].some(
          (c) => c.startsWith('aw_global_owner=;') && c.includes('Path=/studio/;'),
        ),
      );
      assert.equal((await f.request(session, { cookie: owner })).status, 401);
      assert.equal(
        (await f.request(`${regional}/api/v1/workspaces`, { cookie: account })).status,
        401,
      );
    },
  );
}

test(
  'native SSO rejects a discovery issuer mismatch and exposes no provider details',
  { skip: !enabled, timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.control.discoveryIssuer = 'https://unexpected.example';
    const r = await f.request('/api/auth/tidbcloud/login');
    assert.equal(r.status, 503);
    assert.ok(!JSON.stringify(r.body).includes('unexpected.example'));
  },
);

test(
  'fresh hosted bootstrap initializes isolated S3 roots once and steady plans never seed missing metadata',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const { initializeHostedConfig } = await import('../scripts/init-hosted-config.mjs');
    const metadata = await metaFixture();
    const children = [];
    t.after(async () => {
      for (const child of children.toReversed()) {
        if (child.exitCode === null && !child.signalCode) {
          await new Promise((done) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
            child.once('exit', () => {
              clearTimeout(timer);
              done();
            });
            child.kill('SIGTERM');
          });
        }
      }
      await metadata.close();
    });
    const seed = await metadata.service('bootstrap-source');
    await seed.stop();
    const directory = resolve(metadata.directory, 'hosted');
    await initializeHostedConfig({
      directory,
      mountDirectory: directory,
      input: {
        s3: { ...seed.server.s3, endpoint: 'https://storage.example.test' },
        publicOrigin: 'https://studio.example.test',
        sso: {
          issuer: 'https://identity.example.test/',
          clientId: 'native-client',
          ownerSubjects: ['alice'],
        },
      },
    });
    const { readFile } = await import('node:fs/promises');
    for (const name of ['global', 'region']) {
      const path = resolve(directory, name + '.json');
      const c = JSON.parse(await readFile(path));
      c.s3.endpoint = seed.server.s3.endpoint;
      c.bind = `127.0.0.1:${await port()}`;
      await writeFile(path, JSON.stringify(c), { mode: 0o600 });
    }
    const listen = await port();
    for (const name of ['api', 'api-bootstrap', 'global-api', 'global-api-bootstrap']) {
      const path = resolve(directory, name + '.json');
      const c = JSON.parse(await readFile(path));
      c.bind = `127.0.0.1:${listen}`;
      if (c.security) {
        assert.equal(c.security.metadataSecurityState, true);
        assert.equal(c.security.clockDirectory, undefined);
        c.security.initializeClock = name.endsWith('bootstrap');
        c.security.control.bind = `127.0.0.1:${await port()}`;
      } else {
        assert.equal(c.metadataSecurityState, true);
        assert.equal(c.clockDirectory, undefined);
        c.initializeClock = name.endsWith('bootstrap');
      }
      await writeFile(path, JSON.stringify(c), { mode: 0o600 });
    }
    const binary = resolve('meta-service/target/debug/workspace-backend');
    async function run(command, file, waitForExit) {
      const child = spawn(binary, [command, '--config', resolve(directory, file)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '';
      child.stdout.on('data', (b) => (output += b));
      child.stderr.on('data', (b) => (output += b));
      const exited = new Promise((r) => child.once('exit', r));
      if (waitForExit) {
        const code = await exited;
        assert.equal(code, 0, output);
        return output;
      }
      return { child, exited, output: () => output };
    }
    const occupied = http.createServer();
    await new Promise((done) => occupied.listen(listen, '127.0.0.1', done));
    try {
      await run('initialize', 'bootstrap.json', true);
    } finally {
      await new Promise((done) => occupied.close(done));
    }
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(resolve(directory, 'global-clock')), { code: 'ENOENT' });
    await assert.rejects(access(resolve(directory, 'region-clock')), { code: 'ENOENT' });
    // Node fetch rewrites Host; use an actual HTTP request to exercise trusted ingress.
    const publicRequest = (path, options = {}) =>
      new Promise((done, reject) => {
        const req = http.request(
          `http://127.0.0.1:${listen}${path}`,
          { ...options, headers: { Host: 'studio.example.test', ...options.headers } },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              done(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode,
                  headers: res.headers,
                }),
              ),
            );
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end(options.body);
      });
    const active = await run('serve', 'deployment.json', false);
    await until(async () => {
      const r = await publicRequest('/studio/api/health');
      assert.equal(r.status, 200, active.output());
    });
    const localHealth = await fetch(`http://127.0.0.1:${listen}/api/health`);
    assert.equal(localHealth.status, 200, await localHealth.clone().text());
    await localHealth.body.cancel();
    const localData = await fetch(`http://127.0.0.1:${listen}/studio/api/v1/workspaces`);
    assert.equal(localData.status, 403);
    assert.equal((await localData.json()).error.code, 'HOST_DENIED');
    const localSession = await fetch(`http://127.0.0.1:${listen}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(localSession.status, 403);
    await localSession.body.cancel();
    const denied = await publicRequest('/studio/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'studio.example.test',
        Origin: 'https://studio.example.test',
      },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    active.child.kill('SIGTERM');
    await active.exited;
    for (const name of ['api', 'global-api']) {
      const path = resolve(directory, name + '.json');
      const c = JSON.parse(await readFile(path));
      if (c.security) c.security.initializeClock = false;
      else c.initializeClock = false;
      await writeFile(path, JSON.stringify(c), { mode: 0o600 });
    }
    const again = await run('serve', 'deployment.json', false);
    await until(async () => {
      const r = await publicRequest('/studio/api/health');
      assert.equal(r.status, 200, again.output());
    });
  },
);

for (const managed of [false, true])
  test(
    `SSO logout after CREATE revokes in-flight import (${managed ? 'personal' : 'local legacy'})`,
    { skip: !enabled, timeout: 90000 },
    async (t) => {
      let onCreate;
      const provider = await providerFixture({
        onSql: async ({ sql }) => {
          if (sql.startsWith('CREATE TABLE') && onCreate) await onCreate();
        },
      });
      t.after(() => provider.close());
      const statements = provider.statements;
      const origin = provider.origin;
      const f = await fixture(
        t,
        {
          product: {
            providers: {
              postgresProvider: 'db9-anonymous',
              testMode: true,
              db9Endpoint: origin + '/customer',
              sqlFixture: origin + '/sql',
            },
          },
        },
        managed,
      );
      const login = async () => {
        const flow = await f.flow();
        const r = await f.callback(flow);
        assert.equal(r.status, 302);
        return r.headers['set-cookie'][0].split(';')[0];
      };
      const cookie = await login();
      const workspaceBase = managed
        ? `/api/v1/workspaces/${(await f.request('/api/v1/workspaces', { cookie })).body.data[0].id}`
        : base;
      const created = await f.request(workspaceBase + '/resources', {
        method: 'POST',
        cookie,
        body: { name: 'sso-import-target', kind: 'postgresql', region: 'automatic' },
        headers: { 'Idempotency-Key': 'native-sso-import' },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.status, 'active');
      const resourceId = created.body.data.id;
      const prep = await f.request(
        workspaceBase +
          '/database-import-preparations?' +
          new URLSearchParams({
            resourceId,
            filename: 'input.csv',
            format: 'csv',
            header: 'true',
            delimiter: ',',
          }),
        {
          method: 'POST',
          cookie,
          raw: Buffer.from('id\n001\n'),
          headers: { 'Content-Type': 'application/octet-stream' },
        },
      );
      assert.equal(prep.status, 201, JSON.stringify(prep.body));
      const commit = {
        resourceId,
        preparationId: prep.body.id,
        confirmed: true,
        table: 'mid_logout_import',
        fields: prep.body.fields,
      };
      const other = await login();
      const cross = await f.request(workspaceBase + '/database-imports', {
        method: 'POST',
        cookie: other,
        body: commit,
      });
      assert.equal(cross.status, 409);
      assert.equal(cross.body.error.code, 'IMPORT_PREPARATION_UNAVAILABLE');
      onCreate = async () => {
        const r = await f.request('/api/auth/tidbcloud/logout', { method: 'POST', cookie });
        assert.equal(r.status, 200);
      };
      statements.length = 0;
      const result = await f.request(workspaceBase + '/database-imports', {
        method: 'POST',
        cookie,
        body: commit,
      });
      assert.equal(result.status, 502, JSON.stringify(result.body));
      assert.equal(result.body.error.code, 'EXPORT_INCOMPLETE');
      assert.equal(statements.filter((s) => s.startsWith('CREATE TABLE')).length, 1);
      assert.ok(!statements.some((s) => s.startsWith('INSERT')));
    },
  );

test(
  'verified TiDB accounts have independent regional Workspaces and survive Global outage',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    let outageValue;
    const providers = await providerFixture({
      isolatedTenants: true,
      onSql: ({ sql }) => {
        if (sql === 'INSERT INTO outage_test VALUES (42)') {
          outageValue = 42;
          return { body: { columns: [], rows: [], rowCount: 0, affectedRows: 1 } };
        }
        if (sql === 'SELECT id FROM outage_test') {
          const rows = outageValue === undefined ? [] : [{ id: outageValue }];
          return { body: { columns: ['id'], rows, rowCount: rows.length, affectedRows: 0 } };
        }
      },
    });
    t.after(() => providers.close());
    const f = await fixture(
      t,
      {
        product: {
          providers: {
            filesProvider: 'drive9-anonymous',
            mysqlProvider: 'tidb-cloud-zero',
            postgresProvider: 'db9-anonymous',
            testMode: true,
            drive9Endpoint: providers.origin,
            zeroEndpoint: providers.origin + '/zero',
            db9Endpoint: providers.origin + '/customer',
            sqlFixture: providers.origin + '/sql',
          },
        },
      },
      true,
    );
    const { request, flow, callback, control } = f;
    async function login(subject) {
      control.claims = { sub: subject };
      const response = await callback(await flow());
      assert.equal(response.status, 302, JSON.stringify(response.body));
      const header = response.headers['set-cookie'].find((value) =>
        value.startsWith('aw_account='),
      );
      assert.ok(header && header.includes('HttpOnly') && header.includes('Secure'));
      const cookie = header.split(';')[0];
      assertSessionContract(cookie);
      const listed = await request('/api/v1/workspaces', { cookie });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.data.length, 1);
      return { cookie, workspace: listed.body.data[0].id };
    }
    const alice = await login('alice');
    const bob = await login('bob');
    assert.notEqual(alice.workspace, bob.workspace);
    assert.notEqual(alice.workspace, 'ws_agentlab');
    const [alicePolicy, bobPolicy] = await Promise.all([
      f.policy(alice.workspace),
      f.policy(bob.workspace),
    ]);
    assert.notEqual(alicePolicy.userId, bobPolicy.userId);
    assert.notEqual(alicePolicy.organizationId, bobPolicy.organizationId);
    assert.equal(alicePolicy.identity.subject, 'alice');
    assert.equal(bobPolicy.identity.subject, 'bob');
    assert.equal(
      (
        await request(`/api/v1/workspaces/${bob.workspace}`, {
          cookie: alice.cookie.replace(alice.workspace, bob.workspace),
        })
      ).status,
      401,
    );
    assert.equal(
      (await request('/api/auth/config', { cookie: alice.cookie })).body.sessionKind,
      'account',
    );
    assert.equal(
      (await request(`/api/v1/workspaces/${bob.workspace}`, { cookie: alice.cookie })).status,
      404,
    );
    assert.equal(
      (await request(`/api/v1/workspaces/${alice.workspace}`, { cookie: bob.cookie })).status,
      404,
    );
    assert.equal((await request(base, { cookie: alice.cookie })).status, 404);
    assert.equal(
      (await request(base, { headers: { Authorization: 'Bearer old-shared-key' } })).status,
      401,
    );
    for (const [account, kind] of [
      [alice, 'postgresql'],
      [bob, 'filesystem'],
    ]) {
      const resource = await request(`/api/v1/workspaces/${account.workspace}/resources`, {
        method: 'POST',
        cookie: account.cookie,
        headers: { 'Idempotency-Key': `account-${kind}` },
        body: {
          kind,
          name: `private-${kind}`,
          region: kind === 'filesystem' ? 'aws-ap-southeast-1' : 'automatic',
        },
      });
      assert.equal(resource.status, 201);
    }
    const aliceResources = await request(`/api/v1/workspaces/${alice.workspace}/resources`, {
      cookie: alice.cookie,
    });
    const bobResources = await request(`/api/v1/workspaces/${bob.workspace}/resources`, {
      cookie: bob.cookie,
    });
    assert.ok(JSON.stringify(aliceResources.body).includes('private-postgresql'));
    assert.ok(!JSON.stringify(aliceResources.body).includes('private-filesystem'));
    assert.ok(JSON.stringify(bobResources.body).includes('private-filesystem'));
    assert.ok(!JSON.stringify(bobResources.body).includes('private-postgresql'));
    const databaseId = aliceResources.body.data.find((r) => r.name === 'private-postgresql').id;
    const fileSystemId = bobResources.body.data.find((r) => r.name === 'private-filesystem').id;
    const aliceSettings = `/api/v1/workspaces/${alice.workspace}/settings`;
    assert.equal(
      (
        await request(aliceSettings, {
          method: 'PATCH',
          cookie: alice.cookie,
          body: {
            workspaceName: 'Alice private workspace',
            name: 'Alice',
            description: 'Private data',
          },
        })
      ).status,
      200,
    );
    const bobWorkspace = await request(`/api/v1/workspaces/${bob.workspace}`, {
      cookie: bob.cookie,
    });
    assert.ok(!JSON.stringify(bobWorkspace.body).includes('Alice private workspace'));
    // Regional Owner cookies retain their own authority; Key management lives at Global.
    assert.equal(
      (
        await request(`/api/v1/workspaces/${alice.workspace}/keys`, {
          method: 'POST',
          cookie: alice.cookie,
          body: {},
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/v1/workspaces/${alice.workspace}/resources`, {
          headers: { Authorization: 'Bearer retired-key' },
        })
      ).status,
      401,
    );
    const again = await login('alice');
    assert.equal(again.workspace, alice.workspace);
    const guest = await request('/api/auth/guest', { method: 'POST' });
    assert.equal(guest.status, 200);
    assert.notEqual(guest.body.workspaceId, alice.workspace);
    assert.notEqual(guest.body.workspaceId, bob.workspace);
    const guestCookie = guest.headers['set-cookie'][0].split(';')[0];
    assert.equal(
      (await request(`/api/v1/workspaces/${alice.workspace}`, { cookie: guestCookie })).status,
      404,
    );
    await f.restartWithoutGlobal();
    const sqlPath = `/api/v1/workspaces/${alice.workspace}/queries`;
    for (const sql of ['INSERT INTO outage_test VALUES (42)', 'SELECT id FROM outage_test']) {
      const result = await request(sqlPath, {
        method: 'POST',
        cookie: alice.cookie,
        body: { resourceId: databaseId, sql },
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      if (sql.startsWith('SELECT')) assert.deepEqual(result.body.rows, [{ id: 42 }]);
    }
    assert.ok(providers.statements.includes('INSERT INTO outage_test VALUES (42)'));
    assert.ok(providers.statements.includes('SELECT id FROM outage_test'));
    const filePath =
      `/api/v1/workspaces/${bob.workspace}/files/content?` +
      new URLSearchParams({ resourceId: fileSystemId, path: '/global-outage.bin' });
    const bytes = Buffer.from([0, 255, 17, 42]);
    const fileAuth = { Cookie: bob.cookie };
    assert.equal(
      (
        await request(filePath, {
          method: 'PUT',
          headers: { ...fileAuth, 'Content-Type': 'application/octet-stream' },
          raw: bytes,
        })
      ).status,
      200,
    );
    const download = await request(filePath, { headers: fileAuth });
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, bytes);
    assert.equal((await request(filePath, { cookie: alice.cookie })).status, 404);
    assert.equal(
      (await request(`/api/v1/workspaces/${alice.workspace}`, { cookie: alice.cookie })).status,
      200,
    );
    assert.equal(
      (await request(`/api/v1/workspaces/${bob.workspace}`, { cookie: bob.cookie })).status,
      200,
    );
    assert.equal(
      (await request(`/api/v1/workspaces/${guest.body.workspaceId}`, { cookie: guestCookie }))
        .status,
      200,
    );
    control.claims = { sub: 'new-user' };
    assert.equal((await callback(await flow())).status, 503);
    assert.equal(
      (await request('/api/auth/tidbcloud/logout', { method: 'POST', cookie: alice.cookie }))
        .status,
      200,
    );
    assert.equal(
      (await request(`/api/v1/workspaces/${alice.workspace}`, { cookie: alice.cookie })).status,
      401,
    );
    assert.equal(
      (await request(`/api/v1/workspaces/${bob.workspace}`, { cookie: bob.cookie })).status,
      200,
    );
  },
);

test(
  'personal TiDB Account login remains available when Guest signup is disabled',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const f = await fixture(t, {}, 'accountOnly');
    const config = await f.request('/api/auth/config');
    assert.equal(config.body.guestEnabled, false);
    assert.equal((await f.request('/api/auth/guest', { method: 'POST' })).status, 404);
    const callback = await f.callback(await f.flow());
    assert.equal(callback.status, 302);
    const cookie = callback.headers['set-cookie']
      .find((value) => value.startsWith('aw_account='))
      .split(';')[0];
    const workspaces = await f.request('/api/v1/workspaces', { cookie });
    assert.equal(workspaces.status, 200);
    assert.notEqual(workspaces.body.data[0].id, 'ws_agentlab');
  },
);

test(
  'offline retirement deletes only legacy shared records and can be repeated',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const f = await fixture(t, {}, 'purge');
    await f.stopHost();
    const result = await f.purgeLegacy();
    assert.match(result.stdout, /Legacy Workspace live metadata and credentials removed/);
    const region = await f.reopenRegion();
    try {
      const scope = {
        authorityId: region.server.authorityId,
        ownerKind: 'workspace',
        ownerId: 'ws_agentlab',
        family: 'workspace',
        partitionId: 'primary',
      };
      const deleted = await region.client.call({ op: 'list', scope, prefix: '', limit: 100 });
      assert.deepEqual(deleted.records, []);
      const other = await region.client.call({
        op: 'get',
        scope: { ...scope, ownerId: 'unrelated-workspace' },
        keys: ['state/workspace'],
      });
      assert.equal(other.records['state/workspace'].value.id, 'unrelated-workspace');
    } finally {
      region.client.close();
      await region.stop();
    }
    await f.purgeLegacy();
  },
);

test(
  'explicit hosted retirement clears only the legacy Workspace before serving',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const f = await fixture(t, {}, 'purge-auto');
    const login = await f.callback(await f.flow());
    assert.equal(login.status, 302);
    const cookie = login.headers['set-cookie']
      .find((header) => header.startsWith('aw_account='))
      .split(';')[0];
    assert.equal((await f.request('/api/v1/workspaces', { cookie })).status, 200);
    await f.stopHost();
    const region = await f.reopenRegion();
    try {
      const scope = {
        authorityId: region.server.authorityId,
        ownerKind: 'workspace',
        ownerId: 'ws_agentlab',
        family: 'workspace',
        partitionId: 'primary',
      };
      assert.deepEqual(
        (await region.client.call({ op: 'list', scope, prefix: '', limit: 100 })).records,
        [],
      );
      const other = await region.client.call({
        op: 'get',
        scope: { ...scope, ownerId: 'unrelated-workspace' },
        keys: ['state/workspace'],
      });
      assert.equal(other.records['state/workspace'].value.id, 'unrelated-workspace');
    } finally {
      region.client.close();
      await region.stop();
    }
  },
);

test(
  'product analytics: durable browser capture, verified PingCAP Admin, revocation and real report outcomes',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const f = await fixture(t, {}, 'globalApi', false, true);
    const path = '/studio/api/global';
    assert.equal((await f.request(path + '/operator/analytics/summary')).status, 401);
    assert.equal(
      (
        await f.request(path + '/operator/analytics/summary', {
          headers: { Authorization: 'Bearer customer-key' },
        })
      ).status,
      403,
    );
    const sessionId = randomUUID();
    const event = {
      id: randomUUID(),
      event: {
        name: 'public_page_view',
        page: 'home',
        source: 'social',
        device: 'desktop',
        campaign: 'launch',
      },
    };
    const batch = { version: 1, sessionId, events: [event] };
    const ingest = await f.request(path + '/analytics/events', { method: 'POST', body: batch });
    assert.equal(ingest.status, 202);
    assert.equal(
      (await f.request(path + '/analytics/events', { method: 'POST', body: batch })).status,
      202,
    );
    assert.equal(
      (
        await f.request(path + '/analytics/events', {
          method: 'POST',
          body: { ...batch, workspaceId: 'forged' },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.request(path + '/analytics/events', {
          method: 'POST',
          body: batch,
          headers: { Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(path + '/analytics/events', {
          method: 'POST',
          body: batch,
          headers: { 'Sec-GPC': '1' },
        })
      ).status,
      204,
    );
    f.control.claims = { email: 'alice@pingcap.com', email_verified: false };
    let login = await f.flow(true);
    assert.equal((await f.callback(login)).status, 403);
    for (const email of [
      'alice@pingcap.com.evil.test',
      'alice@sub.pingcap.com',
      'alice@example.org',
    ]) {
      f.control.claims = { email, email_verified: true };
      login = await f.flow(true);
      assert.equal((await f.callback(login)).status, 403);
    }
    f.control.claims = { email: 'alice@pingcap.com', email_verified: true };
    login = await f.flow(true);
    const accepted = await f.callback(login);
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.location, 'https://studio.example.test/studio/admin');
    const admin = accepted.headers['set-cookie']
      .find((v) => v.startsWith('aw_operator='))
      .split(';')[0];
    assert.match(
      accepted.headers['set-cookie'].join(';'),
      /HttpOnly; SameSite=Strict; Secure; Path=\/studio\//,
    );
    assert.equal((await f.callback(login)).status, 400);
    const normal = await f.flow();
    const account = await f.callback(normal, {
      cookie: normal.cookie + '; ' + ingest.headers['set-cookie'][0].split(';')[0],
    });
    const owner = account.headers['set-cookie'].map((v) => v.split(';')[0]).join('; ');
    assert.equal((await f.request(path + '/operator/session', { cookie: owner })).status, 401);
    const listed = await f.request('/studio/api/v1/workspaces', { cookie: owner });
    assert.equal(listed.status, 200);
    const ownBase = '/api/v1/workspaces/' + listed.body.data[0].id;
    const resource = await f.request('/studio' + ownBase + '/resources', {
      method: 'POST',
      cookie: owner,
      body: { name: 'report-files', kind: 'filesystem', region: 'aws-ap-southeast-1' },
    });
    assert.equal(resource.status, 201, JSON.stringify(resource.body));
    const report = {
      resourceId: resource.body.data.id,
      path: '/findings.md',
      type: 'file',
      content: '# Findings\nVerified report save',
    };
    const saved = await f.request('/studio' + ownBase + '/reports', {
      method: 'POST',
      cookie: owner,
      body: report,
    });
    assert.equal(saved.status, 201);
    assert.equal(
      (
        await f.request('/studio' + ownBase + '/reports', {
          method: 'POST',
          cookie: owner,
          body: report,
        })
      ).status,
      412,
    );
    await until(async () => {
      const summary = await f.request(
        path +
          '/operator/analytics/summary?from=' +
          new Date().toISOString().slice(0, 10) +
          '&to=' +
          new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        { cookie: admin },
      );
      assert.equal(summary.status, 200);
      assert.equal(summary.body.missingRegions.length, 0);
      assert.equal(summary.body.authorities[0].sessions, 1);
      assert.equal(summary.body.authorities[0].trials, 1);
      assert.equal(summary.body.authorities[0].counts.pageViews, 1);
      assert.equal(summary.body.authorities[1].counts.events['report_saved:success'], 1);
      assert.equal(summary.body.authorities[1].firstUseCampaigns.launch, 1);
      assert.equal(summary.body.authorities[1].counts.events['report_saved:failure'], 1);
      assert.ok(!JSON.stringify(summary.body).includes('Verified report save'));
    });
    await writeFile(f.analyticsPolicy, JSON.stringify({ subjects: [], verifiedEmailDomains: [] }), {
      mode: 0o600,
    });
    assert.equal((await f.request(path + '/operator/session', { cookie: admin })).status, 403);
    await writeFile(
      f.analyticsPolicy,
      JSON.stringify({ subjects: [], verifiedEmailDomains: ['pingcap.com'] }),
      { mode: 0o600 },
    );
    assert.equal(
      (await f.request(path + '/operator/auth/logout', { method: 'POST', cookie: admin })).status,
      204,
    );
    assert.equal((await f.request(path + '/operator/session', { cookie: admin })).status, 401);
    await f.restartHost();
    const reopened = await f.callback(await f.flow(true));
    assert.equal(reopened.status, 303);
    const reopenedAdmin = reopened.headers['set-cookie']
      .find((v) => v.startsWith('aw_operator='))
      .split(';')[0];
    const persisted = await f.request(
      path +
        '/operator/analytics/summary?from=' +
        new Date().toISOString().slice(0, 10) +
        '&to=' +
        new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      { cookie: reopenedAdmin },
    );
    assert.equal(persisted.status, 200);
    assert.equal(persisted.body.authorities[0].counts.pageViews, 1);
    assert.equal(persisted.body.authorities[1].counts.events['report_saved:success'], 1);
  },
);
