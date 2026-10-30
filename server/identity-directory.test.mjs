import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { metaFixture } from './test-support/meta-fixture.mjs';

const exec = promisify(execFile);
const enabled = process.env.WORKSPACE_META_TEST === '1';
test(
  'Global identity reservations survive S3 recovery and isolate concurrent accounts',
  { skip: !enabled, timeout: 120_000 },
  async (t) => {
    await exec('cargo', [
      'build',
      '--locked',
      '-p',
      'workspace-identity',
      '--example',
      'identity_probe',
    ]);
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
    assert.ok(concurrent.every((value) => value.operationId === concurrent[0].operationId));
    const bob = await reserve('https://issuer.example', 'bob');
    const otherIssuer = await reserve('https://other.example', 'alice');
    assert.notEqual(bob.workspaceId, concurrent[0].workspaceId);
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
    const policyPath = resolve(fixture.directory, 'regional-policy.json');
    const claimsPath = resolve(fixture.directory, 'regional-claims.json');
    const acknowledgementPath = resolve(fixture.directory, 'regional-ack.json');
    const sessionPath = resolve(fixture.directory, 'regional-session.json');
    const cleanupPolicyPath = resolve(fixture.directory, 'cleanup-policy.json');
    const cleanupInputPath = resolve(fixture.directory, 'cleanup-input.json');
    const dueInputPath = resolve(fixture.directory, 'cleanup-due.json');
    const policy = {
      workspaceId: concurrent[0].workspaceId,
      organizationId: concurrent[0].organizationId,
      principalId: concurrent[0].principalId,
      regionId: 'region:other',
      generation: 1,
      denied: false,
      identity: { kind: 'oidc', issuer: 'https://issuer.example', subject: 'alice' },
    };
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
      principalId: randomUUID(),
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
  'Guest DB9 deletion attempts are scope-bound, journaled, and not blindly retried',
  { skip: !enabled, timeout: 120_000 },
  async (t) => {
    await exec('cargo', [
      'build',
      '--locked',
      '-p',
      'workspace-providers',
      '--example',
      'guest_cleanup_probe',
    ]);
    const fixture = await metaFixture();
    t.after(() => fixture.close());
    const region = await fixture.service('cleanup');
    t.after(() => region.client.close());
    const calls = [];
    const provider = http.createServer((req, res) => {
      calls.push({
        method: req.method,
        path: req.url,
        authorized: req.headers.authorization === 'Bearer test-only-token',
      });
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
    ]);
  },
);
