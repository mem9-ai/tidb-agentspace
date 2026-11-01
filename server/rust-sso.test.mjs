import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';
import { providerFixture } from './test-support/provider-fixture.mjs';
import { createMetaClient } from './meta/client.mjs';
import { assertSessionContract } from './test-support/assert-session-contract.mjs';

const enabled = process.env.WORKSPACE_BACKEND_TEST === '1';
const base = '/api/v1/workspaces/ws_agentlab';
async function fixture(t, overrides = {}, managed = false) {
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
      const req = http.request(
        origin + path,
        {
          method,
          headers: {
            Host: 'studio.example.test',
            Origin: 'https://studio.example.test',
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
  async function flow() {
    const r = await request('/studio/api/auth/tidbcloud/login');
    assert.equal(r.status, 302);
    const url = new URL(r.headers.location);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    control.challenge = url.searchParams.get('code_challenge');
    control.nonce = url.searchParams.get('nonce');
    return {
      cookie: r.headers['set-cookie'][0].split(';')[0],
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
    request,
    flow,
    callback,
    control,
    issuer,
    config,
    child,
    close,
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
    assert.equal(
      (
        await request(base + '/settings', {
          method: 'PATCH',
          cookie,
          body: { workspaceName: 'SSO workspace', name: 'Alice', description: 'SSO audited' },
        })
      ).status,
      200,
    );
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
        c.security.clockDirectory = resolve(directory, 'region-clock');
        c.security.initializeClock = name.endsWith('bootstrap');
        c.security.control.bind = `127.0.0.1:${await port()}`;
      } else {
        c.clockDirectory = resolve(directory, 'global-clock');
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
      const statements = [];
      let onCreate;
      const sql = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const input = JSON.parse(Buffer.concat(chunks));
        const reply = (value) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (req.url === '/zero')
          return reply({
            instance: {
              id: 'native-sso-fixture',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              connection: {
                host: 'fixture.tidbcloud.com',
                port: 4000,
                username: 'prefix.root',
                password: 'private-synthetic-fixture',
              },
            },
          });
        statements.push(input.sql);
        if (input.sql.startsWith('CREATE TABLE') && onCreate) await onCreate();
        reply({ columns: ['connected'], rows: [{ connected: 1 }], rowCount: 1, affectedRows: 0 });
      });
      await new Promise((r) => sql.listen(0, '127.0.0.1', r));
      t.after(
        () =>
          new Promise((done) => {
            sql.close(done);
            sql.closeAllConnections();
          }),
      );
      const origin = `http://127.0.0.1:${sql.address().port}`;
      const f = await fixture(
        t,
        {
          product: {
            providers: {
              mysqlProvider: 'tidb-cloud-zero',
              testMode: true,
              zeroEndpoint: origin + '/zero',
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
        body: { name: 'sso-import-target', kind: 'mysql', region: 'automatic' },
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
