import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
    const region = await fixture.service('other');
    t.after(() => {
      global.client.close();
      region.client.close();
    });
    const config = resolve(fixture.directory, 'identity-client.json');
    const probe = resolve('meta-service/target/debug/examples/identity_probe');
    const use = async (service) =>
      writeFile(config, JSON.stringify(service.clientConfig), { mode: 0o600 });
    const reserve = async (issuer, subject, regionId = 'region:a') => {
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
    const owner = (await global.client.health()).ownerId;
    await global.stop('SIGKILL');
    global.client.close();
    global = await fixture.service('global', { previous: global, recoverOwner: owner });
    await use(global);
    assert.deepEqual(await reserve('https://issuer.example', 'alice', 'region:b'), concurrent[0]);
    assert.deepEqual(await authGuest(guestA), guestA.registration);
    assert.deepEqual(await authGuest(guestB), guestB.registration);
    await use(region);
    await assert.rejects(reserve('https://issuer.example', 'mallory'));
  },
);
