import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
      const result = await exec(probe, [config, '--guest-create', 'region:a', '-']);
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
    const policyPath = resolve(fixture.directory, 'regional-policy.json');
    const claimsPath = resolve(fixture.directory, 'regional-claims.json');
    const acknowledgementPath = resolve(fixture.directory, 'regional-ack.json');
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
    const regionOwner = (await region.client.health()).ownerId;
    await region.stop('SIGKILL');
    region.client.close();
    region = await fixture.service('other', { previous: region, recoverOwner: regionOwner });
    await use(region);
    await authorizeRegion();
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
