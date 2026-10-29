import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { metaFixture, port, until } from './test-support/meta-fixture.mjs';

const enabled = process.env.WORKSPACE_BACKEND_TEST === '1';
const base = '/api/v1/workspaces/ws_agentlab';
async function fixture(t, overrides = {}) {
  const metadata = await metaFixture();
  t.after(() => metadata.close());
  const region = await metadata.service('native-sso');
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
  const provider = http.createServer(async (req, res) => {
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
  t.after(() => new Promise((r) => provider.close(r)));
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
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await writeFile(
    plan,
    JSON.stringify({ format: 1, services: [{ kind: 'workspace', configFile: file }] }),
    { mode: 0o600 },
  );
  const child = spawn(
    resolve('meta-service/target/debug/workspace-backend'),
    ['serve', '--config', plan],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (b) => {
    log += b;
  });
  child.stderr.on('data', (b) => {
    log += b;
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise((r) => {
      child.once('exit', r);
      child.kill('SIGTERM');
    });
  });
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
            const raw = Buffer.concat(chunks).toString();
            done({
              status: res.statusCode,
              headers: res.headers,
              body: raw ? JSON.parse(raw) : null,
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
  return { request, flow, callback, control, issuer, config, child, log: () => log };
}

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
        product: {},
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
    for (const name of ['api', 'api-bootstrap']) {
      const path = resolve(directory, name + '.json');
      const c = JSON.parse(await readFile(path));
      c.bind = `127.0.0.1:${listen}`;
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
    const active = await run('serve', 'deployment.json', false);
    await until(async () => {
      const r = await fetch(`http://127.0.0.1:${listen}/api/health`);
      assert.equal(r.status, 200, active.output());
    });
    const denied = await fetch(`http://127.0.0.1:${listen}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    active.child.kill('SIGTERM');
    await active.exited;
    const again = await run('serve', 'deployment.json', false);
    await until(async () => {
      const r = await fetch(`http://127.0.0.1:${listen}/api/health`);
      assert.equal(r.status, 200, again.output());
    });
  },
);

test(
  'SSO logout after CREATE revokes the in-flight import before INSERT; reviews stay session-bound',
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
    t.after(() => new Promise((r) => sql.close(r)));
    const origin = `http://127.0.0.1:${sql.address().port}`;
    const f = await fixture(t, {
      product: {
        providers: {
          mysqlProvider: 'tidb-cloud-zero',
          testMode: true,
          zeroEndpoint: origin + '/zero',
          sqlFixture: origin + '/sql',
        },
      },
    });
    const login = async () => {
      const flow = await f.flow();
      const r = await f.callback(flow);
      assert.equal(r.status, 302);
      return r.headers['set-cookie'][0].split(';')[0];
    };
    const cookie = await login();
    const created = await f.request(base + '/resources', {
      method: 'POST',
      cookie,
      body: { name: 'sso-import-target', kind: 'mysql', region: 'automatic' },
      headers: { 'Idempotency-Key': 'native-sso-import' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'active');
    const resourceId = created.body.data.id;
    const prep = await f.request(
      base +
        '/database-imports/prepare-upload?' +
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
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    const commit = {
      resourceId,
      preparationId: prep.body.preparationId,
      confirmed: true,
      table: 'mid_logout_import',
      fields: prep.body.fields,
    };
    const other = await login();
    const cross = await f.request(base + '/database-imports', {
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
    const result = await f.request(base + '/database-imports', {
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
