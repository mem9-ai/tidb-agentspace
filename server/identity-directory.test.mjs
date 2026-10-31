import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { before } from 'node:test';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { metaFixture } from './test-support/meta-fixture.mjs';

const exec = promisify(execFile);
const enabled = process.env.WORKSPACE_META_TEST === '1';
if (enabled) {
  // Compilation has its own finite budget; keep the 120-second behavior deadline
  // independent of whether probe binaries are already linked on this machine.
  before(
    async () => {
      await exec(
        'cargo',
        [
          'build',
          '--locked',
          '-p',
          'workspace-api',
          '--example',
          'personal_login_probe',
          '--example',
          'guest_signup_probe',
          '--example',
          'guest_cookie_probe',
          '--example',
          'guest_pool_probe',
          '--example',
          'guest_entry_probe',
          '--example',
          'guest_http_probe',
        ],
        { timeout: 180_000 },
      );
      await exec(
        'cargo',
        [
          'build',
          '--locked',
          '-p',
          'workspace-identity',
          '--example',
          'identity_probe',
          '--example',
          'regional_key_policy_probe',
          '--example',
          'global_key_probe',
        ],
        { timeout: 180_000 },
      );
      await exec(
        'cargo',
        ['build', '--locked', '-p', 'workspace-providers', '--example', 'guest_cleanup_probe'],
        { timeout: 180_000 },
      );
    },
    { timeout: 540_000 },
  );
}

test(
  'Global Key versions and secrets survive metadata recovery without plaintext storage',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    let global = await fixture.service('global');
    t.after(() => global.client.close());
    const config = resolve(fixture.directory, 'global-key-client.json');
    const keyFile = resolve(fixture.directory, 'global-key-credential.json');
    const oldKeyFile = resolve(fixture.directory, 'global-key-old.json');
    const probe = resolve('meta-service/target/debug/examples/global_key_probe');
    const run = (mode, file, mutation = randomUUID()) =>
      exec(probe, [config, mode, file, mutation]);
    await writeFile(config, JSON.stringify(global.clientConfig), { mode: 0o600 });
    const creation = randomUUID();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => run('create', keyFile, creation)),
    );
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const original = JSON.parse((await run('check', keyFile)).stdout);
    assert.equal(original.keyVersion, 1);
    assert.equal(original.workspaceId, 'ws_agentlab');
    const secret = JSON.parse(await readFile(keyFile, 'utf8')).secret;
    const verifier = createHash('sha256').update(secret).digest('hex');
    const stored = await global.client.call({
      op: 'list',
      scope: {
        authorityId: 'global',
        ownerKind: 'workspace',
        ownerId: 'ws_agentlab',
        family: 'global-keys',
        partitionId: 'primary',
      },
      prefix: '',
      after: null,
      limit: 100,
    });
    assert.ok(!JSON.stringify(stored).includes(secret));
    assert.ok(stored.records.every((record) => !record.key.includes(verifier)));
    assert.equal(stored.records.filter((record) => record.key.startsWith('keys/')).length, 1);
    const owner = (await global.client.health()).ownerId;
    await global.stop('SIGKILL');
    global.client.close();
    global = await fixture.service('global', { previous: global, recoverOwner: owner });
    await writeFile(config, JSON.stringify(global.clientConfig), { mode: 0o600 });
    assert.deepEqual(JSON.parse((await run('check', keyFile)).stdout), original);
    await run('renew', keyFile);
    const renewed = JSON.parse((await run('check', keyFile)).stdout);
    assert.equal(renewed.keyId, original.keyId);
    assert.equal(renewed.keyVersion, 2);
    assert.equal(renewed.expiresAt, original.expiresAt + 600);
    await copyFile(keyFile, oldKeyFile);
    await run('rotate', keyFile);
    const rotated = JSON.parse((await run('check', keyFile)).stdout);
    assert.equal(rotated.keyId, original.keyId);
    assert.equal(rotated.keyVersion, 3);
    await assert.rejects(run('check', oldKeyFile));
    await run('revoke', keyFile);
    await assert.rejects(run('check', keyFile));
  },
);

test(
  'regional Key version floor survives Global loss and regional metadata recovery',
  { skip: !enabled, timeout: 90000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const global = await fixture.service('global');
    let region = await fixture.service('other');
    t.after(() => {
      global.client.close();
      region.client.close();
    });
    const config = resolve(fixture.directory, 'key-policy-region.json');
    const input = resolve(fixture.directory, 'key-policy-input.json');
    const probe = resolve('meta-service/target/debug/examples/regional_key_policy_probe');
    await writeFile(config, JSON.stringify(region.clientConfig), { mode: 0o600 });
    const policy = {
      workspaceId: 'ws_agentlab',
      regionId: region.server.authorityId,
      keyId: randomUUID(),
      principalId: 'legacy-owner',
      keyVersion: 1,
      policyGeneration: 1,
      grantRef: 'grant:existing',
      expiresAt: 4000000000,
      revoked: false,
    };
    const command = randomUUID();
    const save = async (value) => writeFile(input, JSON.stringify(value), { mode: 0o600 });
    const install = async (commandId) => exec(probe, [config, 'install', input, commandId]);
    const check = async (now = '2000000000') =>
      JSON.parse((await exec(probe, [config, 'check', input, now])).stdout);
    await save(policy);
    await install(command);
    await install(command);
    assert.equal((await check()).grantRef, policy.grantRef);
    await save({ ...policy, keyVersion: 2, policyGeneration: 2 });
    await assert.rejects(install(command));
    await install(randomUUID());
    await save(policy);
    await assert.rejects(check());
    await global.stop('SIGKILL');
    global.client.close();
    const owner = (await region.client.health()).ownerId;
    await region.stop('SIGKILL');
    region.client.close();
    region = await fixture.service('other', { previous: region, recoverOwner: owner });
    await writeFile(config, JSON.stringify(region.clientConfig), { mode: 0o600 });
    await save({ ...policy, keyVersion: 2, policyGeneration: 2 });
    assert.equal((await check()).grantRef, policy.grantRef);
    await assert.rejects(check('4000000000'));
    await save({ ...policy, keyVersion: 3, policyGeneration: 3, revoked: true });
    await install(randomUUID());
    await assert.rejects(check());
  },
);

test(
  'verified OIDC login creates one isolated personal user and Workspace',
  { skip: !enabled, timeout: 120_000 },
  async (t) => {
    const fixture = await metaFixture();
    let provider;
    let global;
    let region;
    t.after(async () => {
      if (provider?.listening) {
        provider.closeAllConnections();
        await new Promise((done) => provider.close(done));
      }
      global?.client.close();
      region?.client.close();
      await fixture.close();
    });
    global = await fixture.service('global');
    region = await fixture.service('other');
    const key = await generateKeyPair('RS256');
    const wrongKey = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(key.publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
    const flows = new Map();
    let subject = 'alice';
    let badSignature = false;
    let issuer;
    provider = http.createServer(async (request, response) => {
      const json = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const url = new URL(request.url, issuer);
      if (url.pathname === '/.well-known/openid-configuration')
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const code = randomUUID();
        flows.set(code, {
          challenge: url.searchParams.get('code_challenge'),
          nonce: url.searchParams.get('nonce'),
          subject,
          badSignature,
        });
        return json(200, { code });
      }
      if (url.pathname === '/token') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const flow = flows.get(form.get('code'));
        flows.delete(form.get('code'));
        if (
          !flow ||
          createHash('sha256')
            .update(form.get('code_verifier') || '')
            .digest('base64url') !== flow.challenge
        )
          return json(400, { error: 'invalid_grant' });
        const token = await new SignJWT({
          iss: issuer,
          sub: flow.subject,
          aud: 'fixture-client',
          nonce: flow.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
          .sign(flow.badSignature ? wrongKey.privateKey : key.privateKey);
        return json(200, { id_token: token });
      }
      return json(404, {});
    });
    await new Promise((done) => provider.listen(0, '127.0.0.1', done));
    issuer = `http://127.0.0.1:${provider.address().port}`;
    const globalConfig = resolve(fixture.directory, 'global-login-global.json');
    const regionConfig = resolve(fixture.directory, 'global-login-region.json');
    const ssoConfig = resolve(fixture.directory, 'global-login-sso.json');
    await writeFile(globalConfig, JSON.stringify(global.clientConfig), { mode: 0o600 });
    await writeFile(regionConfig, JSON.stringify(region.clientConfig), { mode: 0o600 });
    const settings = {
      issuer,
      clientId: 'fixture-client',
      redirectUri: 'https://studio.example.test/studio/api/auth/tidbcloud/callback',
      allowLoopbackHttp: true,
    };
    await writeFile(ssoConfig, JSON.stringify(settings), { mode: 0o600 });
    const probe = resolve('meta-service/target/debug/examples/personal_login_probe');
    const login = async () =>
      JSON.parse(
        (await exec(probe, [ssoConfig, globalConfig, regionConfig], { timeout: 30000 })).stdout,
      );
    const alice = await login();
    const again = await login();
    assert.deepEqual(again, alice);
    await writeFile(ssoConfig, JSON.stringify({ ...settings, ownerSubjects: ['alice'] }), {
      mode: 0o600,
    });
    await assert.rejects(login(), 'shared Workspace allowlists must not be silently ignored');
    await writeFile(ssoConfig, JSON.stringify(settings), { mode: 0o600 });
    subject = 'bob';
    badSignature = true;
    await assert.rejects(login());
    const identityProbe = resolve('meta-service/target/debug/examples/identity_probe');
    await assert.rejects(exec(identityProbe, [globalConfig, '--status', issuer, 'bob']));
    badSignature = false;
    const bob = await login();
    assert.notEqual(alice.userId, bob.userId);
    assert.notEqual(alice.organizationId, bob.organizationId);
    assert.notEqual(alice.workspaceId, bob.workspaceId);
    assert.equal(
      JSON.parse((await exec(identityProbe, [globalConfig, '--status', issuer, 'bob'])).stdout)
        .state,
      'ready',
    );
    const guestProbe = resolve('meta-service/target/debug/examples/guest_signup_probe');
    const createGuest = async (path) => {
      await writeFile(path, '', { mode: 0o600 });
      return JSON.parse((await exec(guestProbe, [globalConfig, regionConfig, path])).stdout);
    };
    const firstCookie = resolve(fixture.directory, 'guest-one-cookie');
    const secondCookie = resolve(fixture.directory, 'guest-two-cookie');
    const firstGuest = await createGuest(firstCookie);
    const secondGuest = await createGuest(secondCookie);
    for (const field of ['userId', 'organizationId', 'workspaceId']) {
      assert.notEqual(firstGuest.registration[field], secondGuest.registration[field]);
      assert.notEqual(firstGuest.registration[field], alice[field]);
    }
    assert.ok(firstGuest.accessExpiresAt <= firstGuest.expiresAt);
    const poolProbe = resolve('meta-service/target/debug/examples/guest_pool_probe');
    assert.equal(
      JSON.parse((await exec(poolProbe, [globalConfig, regionConfig])).stdout).isolated,
      true,
    );
    const httpProbe = resolve('meta-service/target/debug/examples/guest_http_probe');
    assert.equal(
      JSON.parse((await exec(httpProbe, [globalConfig, regionConfig])).stdout).isolated,
      true,
    );
    const entryProbe = resolve('meta-service/target/debug/examples/guest_entry_probe');
    const entryCookie = resolve(fixture.directory, 'guest-entry-cookie');
    await writeFile(entryCookie, '', { mode: 0o600 });
    const entryGuest = JSON.parse(
      (await exec(entryProbe, [globalConfig, regionConfig, entryCookie, 'create'])).stdout,
    );
    assert.notEqual(entryGuest.workspaceId, firstGuest.registration.workspaceId);
    const owner = (await region.client.health()).ownerId;
    await global.stop('SIGKILL');
    global.client.close();
    await region.stop('SIGKILL');
    region.client.close();
    region = await fixture.service('other', { previous: region, recoverOwner: owner });
    await writeFile(regionConfig, JSON.stringify(region.clientConfig), { mode: 0o600 });
    const cookieProbe = resolve('meta-service/target/debug/examples/guest_cookie_probe');
    const access = async (path) =>
      JSON.parse((await exec(cookieProbe, [regionConfig, path, 'access'])).stdout);
    assert.equal((await access(firstCookie)).workspaceId, firstGuest.registration.workspaceId);
    assert.equal((await access(secondCookie)).workspaceId, secondGuest.registration.workspaceId);
    const resumedEntry = JSON.parse(
      (await exec(entryProbe, ['-', regionConfig, entryCookie, 'resume'])).stdout,
    );
    assert.equal(resumedEntry.workspaceId, entryGuest.workspaceId);
    const changedCookie = resolve(fixture.directory, 'guest-wrong-workspace-cookie');
    const firstValue = await readFile(firstCookie, 'utf8');
    await writeFile(
      changedCookie,
      firstValue.replace(firstGuest.registration.workspaceId, secondGuest.registration.workspaceId),
      { mode: 0o600 },
    );
    await assert.rejects(access(changedCookie));
    await exec(cookieProbe, [regionConfig, firstCookie, 'logout']);
    await assert.rejects(access(firstCookie));
    assert.equal((await access(secondCookie)).workspaceId, secondGuest.registration.workspaceId);
  },
);
test(
  'Global identity reservations survive S3 recovery and isolate concurrent accounts',
  { skip: !enabled, timeout: 120_000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    let global = await fixture.service('global');
    let region = await fixture.service('other');
    t.after(() => {
      global.client.close();
      region.client.close();
    });
    const config = resolve(fixture.directory, 'identity-client.json');
    const regionConfig = resolve(fixture.directory, 'regional-client.json');
    const probe = resolve('meta-service/target/debug/examples/identity_probe');
    const use = async (service) =>
      writeFile(config, JSON.stringify(service.clientConfig), { mode: 0o600 });
    const reserve = async (issuer, subject, regionId = 'region:other') => {
      const result = await exec(probe, [config, issuer, subject, regionId], { timeout: 30_000 });
      return JSON.parse(result.stdout);
    };
    await use(global);
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => reserve('https://issuer.example', 'alice')),
    );
    assert.ok(concurrent.every((value) => value.workspaceId === concurrent[0].workspaceId));
    assert.ok(concurrent.every((value) => value.userId === concurrent[0].userId));
    assert.ok(concurrent.every((value) => value.organizationId === concurrent[0].organizationId));
    assert.ok(concurrent.every((value) => value.operationId === concurrent[0].operationId));
    const bob = await reserve('https://issuer.example', 'bob');
    const otherIssuer = await reserve('https://other.example', 'alice');
    assert.notEqual(bob.workspaceId, concurrent[0].workspaceId);
    assert.notEqual(bob.userId, concurrent[0].userId);
    assert.notEqual(bob.organizationId, concurrent[0].organizationId);
    assert.notEqual(otherIssuer.workspaceId, concurrent[0].workspaceId);
    const createGuest = async () => {
      const result = await exec(probe, [config, '--guest-create', 'region:other', '-']);
      return JSON.parse(result.stdout);
    };
    const authGuest = async (guest, secret = guest.secret) => {
      const result = await exec(probe, [config, '--guest-auth', guest.guestId, secret]);
      return JSON.parse(result.stdout);
    };
    const guestA = await createGuest();
    const guestB = await createGuest();
    assert.notEqual(guestA.registration.workspaceId, guestB.registration.workspaceId);
    assert.notEqual(guestA.registration.userId, guestB.registration.userId);
    assert.notEqual(guestA.registration.organizationId, guestB.registration.organizationId);
    assert.notEqual(guestA.registration.userId, bob.userId);
    assert.notEqual(guestA.registration.organizationId, bob.organizationId);
    await assert.rejects(authGuest(guestA, guestB.secret));
    await writeFile(regionConfig, JSON.stringify(region.clientConfig), { mode: 0o600 });
    const onboarding = await Promise.all(
      Array.from({ length: 4 }, async () =>
        JSON.parse(
          (await exec(probe, [config, '--onboard-personal', regionConfig, 'charlie'])).stdout,
        ),
      ),
    );
    assert.ok(onboarding.every((value) => value.workspaceId === onboarding[0].workspaceId));
    const guestInput = resolve(fixture.directory, 'guest-onboarding.json');
    await writeFile(guestInput, JSON.stringify(guestA), { mode: 0o600 });
    const guestWorkspace = JSON.parse(
      (await exec(probe, [config, '--onboard-guest', regionConfig, guestInput])).stdout,
    );
    assert.equal(guestWorkspace.workspaceId, guestA.registration.workspaceId);
    assert.notEqual(guestWorkspace.workspaceId, onboarding[0].workspaceId);
    await exec(probe, [regionConfig, '--workspace-check', onboarding[0].workspaceId, '-']);
    await exec(probe, [regionConfig, '--workspace-check', guestWorkspace.workspaceId, '-']);
    await exec(probe, [
      regionConfig,
      '--workspace-isolation',
      onboarding[0].workspaceId,
      guestWorkspace.workspaceId,
    ]);
    await exec(probe, [regionConfig, '--expired-guest-check', '-', '-']);
    const policyPath = resolve(fixture.directory, 'regional-policy.json');
    const claimsPath = resolve(fixture.directory, 'regional-claims.json');
    const acknowledgementPath = resolve(fixture.directory, 'regional-ack.json');
    const sessionPath = resolve(fixture.directory, 'regional-session.json');
    const guestSessionPath = resolve(fixture.directory, 'guest-regional-session.json');
    const cleanupPolicyPath = resolve(fixture.directory, 'cleanup-policy.json');
    const cleanupInputPath = resolve(fixture.directory, 'cleanup-input.json');
    const dueInputPath = resolve(fixture.directory, 'cleanup-due.json');
    const policy = {
      workspaceId: concurrent[0].workspaceId,
      organizationId: concurrent[0].organizationId,
      userId: concurrent[0].userId,
      regionId: 'region:other',
      generation: 1,
      denied: false,
      identity: { kind: 'oidc', issuer: 'https://issuer.example', subject: 'alice' },
    };
    await writeFile(
      guestSessionPath,
      JSON.stringify({ regionId: 'region:other', guestId: guestA.guestId, secret: guestA.secret }),
      { mode: 0o600 },
    );
    const guestCredentials = JSON.parse(
      (
        await exec(probe, [
          regionConfig,
          '--guest-region-issue',
          guestSessionPath,
          guestWorkspace.workspaceId,
        ])
      ).stdout,
    );
    assert.ok(guestCredentials.accessExpiresAt <= guestA.expiresAt);
    await writeFile(
      guestSessionPath,
      JSON.stringify({ regionId: 'region:other', token: guestCredentials.access }),
      { mode: 0o600 },
    );
    await exec(probe, [
      regionConfig,
      '--region-access',
      guestSessionPath,
      guestWorkspace.workspaceId,
    ]);
    await assert.rejects(
      exec(probe, [regionConfig, '--region-access', guestSessionPath, onboarding[0].workspaceId]),
    );
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    await writeFile(
      claimsPath,
      JSON.stringify({
        regionId: 'region:other',
        issuer: 'https://issuer.example',
        subject: 'alice',
      }),
      { mode: 0o600 },
    );
    await use(region);
    await exec(probe, [config, '--region-install', policyPath, randomUUID()]);
    const authorizeRegion = () =>
      exec(probe, [config, '--region-auth', claimsPath, policy.workspaceId]);
    await authorizeRegion();
    const credentials = JSON.parse(
      (await exec(probe, [config, '--region-issue', claimsPath, policy.workspaceId])).stdout,
    );
    const useSession = async (token) =>
      writeFile(sessionPath, JSON.stringify({ regionId: 'region:other', token }), { mode: 0o600 });
    const accessRegion = (workspace = policy.workspaceId) =>
      exec(probe, [config, '--region-access', sessionPath, workspace]);
    await useSession(credentials.access);
    await accessRegion();
    await assert.rejects(accessRegion(bob.workspaceId));
    const expiresAt = Math.floor(Date.now() / 1000) - 1;
    const expiredGuestPolicy = {
      workspaceId: randomUUID(),
      organizationId: randomUUID(),
      userId: randomUUID(),
      regionId: 'region:other',
      generation: 1,
      denied: false,
      identity: {
        kind: 'guest',
        guestId: randomUUID(),
        verifier: '09'.repeat(32),
        createdAt: expiresAt - 86_400,
        expiresAt,
      },
    };
    await writeFile(cleanupPolicyPath, JSON.stringify(expiredGuestPolicy), { mode: 0o600 });
    await exec(probe, [config, '--region-install', cleanupPolicyPath, randomUUID()]);
    await exec(probe, [config, '--cleanup-enqueue', cleanupPolicyPath, randomUUID()]);
    const partition = createHash('sha256').update(expiredGuestPolicy.workspaceId).digest()[0] % 64;
    await writeFile(dueInputPath, JSON.stringify({ regionId: 'region:other', partition }), {
      mode: 0o600,
    });
    const due = async () =>
      JSON.parse((await exec(probe, [config, '--cleanup-due', dueInputPath, '-'])).stdout).jobs;
    await use(global);
    const status = async () =>
      JSON.parse(
        (await exec(probe, [config, '--status', 'https://issuer.example', 'alice'])).stdout,
      ).state;
    assert.equal(await status(), 'pending');
    await writeFile(
      acknowledgementPath,
      JSON.stringify({
        issuer: 'https://issuer.example',
        subject: 'alice',
        registration: concurrent[0],
      }),
      { mode: 0o600 },
    );
    await exec(probe, [config, '--region-ready', acknowledgementPath, randomUUID()]);
    assert.equal(await status(), 'ready');
    const owner = (await global.client.health()).ownerId;
    await global.stop('SIGKILL');
    global.client.close();
    await use(region);
    await authorizeRegion();
    const cleanupJob = (await due()).find(
      (job) => job.workspaceId === expiredGuestPolicy.workspaceId,
    );
    assert.equal(cleanupJob.status.state, 'scheduled');
    await writeFile(
      cleanupInputPath,
      JSON.stringify({ regionId: 'region:other', job: cleanupJob }),
      { mode: 0o600 },
    );
    const cleanupAttempt = randomUUID();
    const claimedJob = JSON.parse(
      (await exec(probe, [config, '--cleanup-claim', cleanupInputPath, cleanupAttempt])).stdout,
    );
    const regionOwner = (await region.client.health()).ownerId;
    await region.stop('SIGKILL');
    region.client.close();
    region = await fixture.service('other', { previous: region, recoverOwner: regionOwner });
    await use(region);
    await authorizeRegion();
    await exec(probe, [config, '--region-access', guestSessionPath, guestWorkspace.workspaceId]);
    await assert.rejects(
      exec(probe, [config, '--cleanup-claim', cleanupInputPath, cleanupAttempt]),
    );
    // This fixture created no provider resources. This verifies the durable job only.
    await writeFile(
      cleanupInputPath,
      JSON.stringify({ regionId: 'region:other', job: claimedJob, attemptId: cleanupAttempt }),
      { mode: 0o600 },
    );
    await exec(probe, [config, '--cleanup-complete', cleanupInputPath, randomUUID()]);
    assert.equal(
      (await due()).find((job) => job.workspaceId === expiredGuestPolicy.workspaceId).status.state,
      'complete',
    );
    // Unsupported provider cleanup stays visible across a Region restart, even while Global is down.
    const unsupported = {
      ...expiredGuestPolicy,
      workspaceId: randomUUID(),
      organizationId: randomUUID(),
      userId: randomUUID(),
      identity: { ...expiredGuestPolicy.identity, guestId: randomUUID() },
    };
    await writeFile(cleanupPolicyPath, JSON.stringify(unsupported), { mode: 0o600 });
    await exec(probe, [config, '--region-install', cleanupPolicyPath, randomUUID()]);
    await exec(probe, [config, '--cleanup-enqueue', cleanupPolicyPath, randomUUID()]);
    const unsupportedPartition =
      createHash('sha256').update(unsupported.workspaceId).digest()[0] % 64;
    await writeFile(
      dueInputPath,
      JSON.stringify({ regionId: 'region:other', partition: unsupportedPartition }),
      { mode: 0o600 },
    );
    await exec(probe, [config, '--cleanup-scan', '-', '-'], { timeout: 30000 });
    const unsupportedClaim = (await due()).find(
      (job) => job.workspaceId === unsupported.workspaceId,
    );
    assert.equal(unsupportedClaim.status.state, 'deferred');
    await writeFile(
      cleanupInputPath,
      JSON.stringify({
        regionId: 'region:other',
        job: unsupportedClaim,
        attemptId: unsupportedClaim.status.attemptId,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      exec(probe, [config, '--cleanup-complete', cleanupInputPath, randomUUID()]),
    );
    const nextRegionOwner = (await region.client.health()).ownerId;
    await region.stop('SIGKILL');
    region.client.close();
    region = await fixture.service('other', { previous: region, recoverOwner: nextRegionOwner });
    await use(region);
    const deferred = (await due()).find((job) => job.workspaceId === unsupported.workspaceId);
    assert.equal(deferred.status.state, 'deferred');
    assert.equal(deferred.status.reason, 'providerDeletionUnsupported');
    await accessRegion();
    await useSession(credentials.renewal);
    const renewed = JSON.parse(
      (await exec(probe, [config, '--region-renew', sessionPath, policy.workspaceId])).stdout,
    );
    await useSession(renewed.access);
    await accessRegion();
    await writeFile(
      claimsPath,
      JSON.stringify({
        regionId: 'region:other',
        issuer: 'https://issuer.example',
        subject: 'bob',
      }),
      { mode: 0o600 },
    );
    await assert.rejects(authorizeRegion());
    global = await fixture.service('global', { previous: global, recoverOwner: owner });
    await use(global);
    assert.deepEqual(await reserve('https://issuer.example', 'alice', 'region:b'), concurrent[0]);
    assert.equal(await status(), 'ready');
    assert.deepEqual(await authGuest(guestA), guestA.registration);
    assert.deepEqual(await authGuest(guestB), guestB.registration);
    await use(region);
    await assert.rejects(reserve('https://issuer.example', 'mallory'));
  },
);

test(
  'Guest DB9 and Drive9 deletion attempts are scope-bound, journaled, and not blindly retried',
  { skip: !enabled, timeout: 120_000 },
  async (t) => {
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const region = await fixture.service('cleanup');
    t.after(() => region.client.close());
    const calls = [];
    const provider = http.createServer((req, res) => {
      calls.push({
        method: req.method,
        path: req.url,
        authorized: ['Bearer test-only-token', 'Bearer test-file-token'].includes(
          req.headers.authorization,
        ),
      });
      if (
        req.method === 'DELETE' &&
        req.url === '/v1/tenant' &&
        req.headers.authorization === 'Bearer test-file-token'
      ) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'deleting' }));
        return;
      }
      if (req.method !== 'DELETE' || req.headers.authorization !== 'Bearer test-only-token') {
        res.writeHead(403).end();
        return;
      }
      if (req.url === '/customer/databases/db_lost') {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Database disabled' }));
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          provider.close(resolve);
          provider.closeAllConnections();
        }),
    );
    const config = resolve(fixture.directory, 'cleanup-client.json');
    await writeFile(config, JSON.stringify(region.clientConfig), { mode: 0o600 });
    const endpoint = `http://127.0.0.1:${provider.address().port}`;
    const probe = resolve('meta-service/target/debug/examples/guest_cleanup_probe');
    const result = await exec(probe, [config, endpoint], { timeout: 30_000 });
    assert.equal(JSON.parse(result.stdout).verified, true);
    assert.deepEqual(calls, [
      { method: 'DELETE', path: '/customer/databases/db_guest', authorized: true },
      { method: 'DELETE', path: '/customer/databases/db_lost', authorized: true },
      { method: 'DELETE', path: '/v1/tenant', authorized: true },
      { method: 'DELETE', path: '/v1/tenant', authorized: true },
    ]);
  },
);
