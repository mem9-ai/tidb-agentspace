import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { productApiFixture } from './product-api-fixture.mjs';

test(
  'anonymous public report survives a restart and enforces expiry, proofs and isolation',
  { skip: process.env.WORKSPACE_BACKEND_TEST !== '1', timeout: 150000 },
  async (t) => {
    const f = await productApiFixture(t, 'remote');
    const contract = JSON.parse(
      await readFile(new URL('../../public/openapi.json', import.meta.url), 'utf8'),
    );
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validators = new Map();
    async function call(route, method = 'GET', body, headers = {}) {
      const response = await f.request('/api/v1/agent-trial/' + route, {
        method,
        body,
        headers,
        token: null,
      });
      const op = contract.paths['/agent-trial/' + route][method.toLowerCase()];
      const schema = (op.responses[response.status] ?? op.responses.default).content[
        'application/json'
      ]?.schema;
      if (schema) {
        if (!validators.has(schema))
          validators.set(schema, ajv.compile({ ...schema, components: contract.components }));
        const validate = validators.get(schema);
        assert.ok(validate(response.body), ajv.errorsText(validate.errors));
      }
      return response;
    }
    const identity = () => generateKeyPairSync('ed25519');
    async function proof(keys, enroll) {
      const {
        body: { challenge },
      } = await call('challenges', 'POST', {});
      const message = ['drive9/trial/v1', challenge, enroll ? 'start' : 'resume'].join('\n');
      return {
        publicKey: keys.publicKey.export({ format: 'jwk' }).x,
        challenge,
        enroll,
        signature: sign(null, Buffer.from(message), keys.privateKey).toString('base64url'),
      };
    }
    function viewGrant(keys, id, expiry) {
      const signature = sign(
        null,
        Buffer.from(['drive9/trial/report-view/v1', id, expiry].join('\n')),
        keys.privateKey,
      );
      return [
        'v1',
        keys.publicKey.export({ format: 'jwk' }).x,
        id,
        expiry,
        signature.toString('base64url'),
      ].join('.');
    }
    const read = (grant) =>
      call('report-view', 'GET', undefined, { Authorization: 'TrialView ' + grant });
    const headers = (token) => ({ Authorization: 'Trial ' + token });
    const update = (token, version, section) =>
      call('report', 'PUT', { section }, { ...headers(token), 'If-Match': '"' + version + '"' });
    if (process.env.WORKSPACE_TRIAL_PYTHON) {
      await promisify(execFile)(process.env.WORKSPACE_TRIAL_PYTHON, [
        '-IB',
        'server/test-support/private_csv_helper.py',
      ]);
      const { stdout } = await promisify(execFile)(process.env.WORKSPACE_TRIAL_PYTHON, [
        '-IB',
        'server/test-support/agent_trial_client.py',
        f.endpoints.region,
      ]);
      t.diagnostic(stdout.trim());
    }
    const a = identity(),
      b = identity();
    const csv = await call('us-sales-v1.csv');
    assert.equal(csv.status, 200);
    assert.deepEqual(
      csv.body,
      await readFile(new URL('../../specs/gh-150/fixtures/us-sales.csv', import.meta.url)),
    );
    const enrollment = await proof(a, true);
    assert.equal(
      (
        await call('sessions', 'POST', {
          ...enrollment,
          publicKey: b.publicKey.export({ format: 'jwk' }).x,
        })
      ).status,
      401,
    );
    const first = await call('sessions', 'POST', enrollment);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { token, report } = first.body;
    const grant = viewGrant(a, report.id, report.expiresAt);
    assert.equal((await read(grant)).status, 404);
    assert.equal((await read(report.id)).status, 401);
    assert.equal((await read(grant.replace('v1.', 'v2.'))).status, 401);
    assert.equal(
      (await read(grant.replace(report.id, report.id.split('').reverse().join('')))).status,
      401,
    );
    assert.equal((await read(viewGrant(a, report.id, report.expiresAt + 1))).status, 403);
    const viewHeaders = { Authorization: 'TrialView ' + grant };
    assert.equal(
      (await call('report', 'PUT', { section: 'states' }, { ...viewHeaders, 'If-Match': '"0"' }))
        .status,
      401,
    );
    assert.equal((await call('report', 'GET', undefined, viewHeaders)).status, 401);
    assert.equal((await call('report-sharing', 'DELETE', undefined, viewHeaders)).status, 401);
    assert.equal((await call('report-view', 'GET', undefined, headers(token))).status, 401);
    assert.equal(
      (await call('report-view', 'GET', undefined, { ...viewHeaders, Cookie: 'browser=example' }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.request('/api/v1/agent-trial/report-view?test=1', {
          headers: viewHeaders,
          token: null,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request('/api/v1/agent-trial/report-view', {
          method: 'PUT',
          headers: viewHeaders,
          token: null,
        })
      ).status,
      404,
    );
    assert.ok(
      [401, 403].includes(
        (
          await f.request('/api/v1/workspaces/ws_agentlab/resources', {
            headers: viewHeaders,
            token: null,
          })
        ).status,
      ),
    );
    assert.ok(Math.abs(report.expiresAt - Date.now() / 1000 - 48 * 3600) < 10);
    assert.equal((await call('sessions', 'POST', enrollment)).status, 401);
    assert.equal((await call('report')).status, 401);
    assert.equal((await update(token, 0, 'products')).status, 409);
    const rev1 = await update(token, 0, 'states');
    assert.equal(rev1.status, 200);
    const initialView = await read(grant);
    assert.deepEqual(initialView.body, rev1.body);
    assert.equal(initialView.headers.get('cache-control'), 'no-store');
    assert.equal(rev1.headers.get('etag'), '"1"');
    assert.equal(rev1.body.stateSales.California, 48000);
    assert.equal((await update(token, 0, 'states')).status, 412);
    const denied = await f.request('/api/v1/workspaces/ws_agentlab/resources', {
      token: null,
      headers: headers(token),
    });
    assert.ok([401, 403].includes(denied.status));
    assert.equal((await call('sessions', 'POST', await proof(b, false))).status, 404);
    const other = await call('sessions', 'POST', await proof(b, true));
    assert.notEqual(other.body.report.id, report.id);
    assert.equal(other.body.report.revision, 0);
    assert.equal((await read(viewGrant(b, report.id, report.expiresAt))).status, 403);
    const fakeSession = await proof(a, false);
    assert.equal(
      (await call('sessions', 'POST', { ...fakeSession, signature: grant.split('.').at(-1) }))
        .status,
      401,
    );
    await f.restart();
    assert.equal((await call('report', 'GET', undefined, headers(token))).status, 401);
    const resumed = await call('sessions', 'POST', await proof(a, false));
    assert.equal(resumed.body.report.id, report.id);
    assert.equal(resumed.body.report.expiresAt, report.expiresAt);
    const rev2 = await update(resumed.body.token, 1, 'products');
    assert.equal(rev2.body.revision, 2);
    assert.equal(rev2.body.leadingStateProducts.Monitors, 18000);
    const saved = await call('report', 'GET', undefined, headers(resumed.body.token));
    assert.deepEqual(saved.body, rev2.body);
    assert.deepEqual((await read(grant)).body, rev2.body);
    assert.equal((await update(resumed.body.token, 2, 'states')).body.revision, 2);
    assert.match(rev2.body.markdown, /# US sales report/);
    assert.match(rev2.body.markdown, /Source: us-sales.csv/);
    assert.match(rev2.body.markdown, /\$68,000.00 \/ \$100,000.00 = 68.0%/);
    const otherResumed = await call('sessions', 'POST', await proof(b, false));
    assert.equal(
      (await call('report-sharing', 'DELETE', undefined, headers(otherResumed.body.token))).status,
      200,
    );
    assert.equal((await read(grant)).status, 200);
    const revoked = await call('report-sharing', 'DELETE', undefined, headers(resumed.body.token));
    assert.equal(revoked.body.sharingRevoked, true);
    assert.equal(revoked.body.markdown, rev2.body.markdown);
    assert.equal(revoked.body.expiresAt, report.expiresAt);
    assert.deepEqual(
      (await call('report-sharing', 'DELETE', undefined, headers(resumed.body.token))).body,
      revoked.body,
    );
    await f.restart();
    assert.equal((await read(grant)).status, 410);
    assert.equal((await read(grant)).body.error.code, 'REPORT_SHARING_REVOKED');
    const afterRevoke = await call('sessions', 'POST', await proof(a, false));
    assert.equal(afterRevoke.body.report.sharingRevoked, true);
    assert.equal((await update(afterRevoke.body.token, 2, 'states')).body.sharingRevoked, true);
    await f.expireTrial(enrollment.publicKey);
    assert.equal((await read(grant)).status, 410);
    assert.equal((await read(viewGrant(a, report.id, 1))).status, 410);
    assert.equal(
      (await call('report', 'GET', undefined, headers(afterRevoke.body.token))).status,
      410,
    );
    assert.equal((await call('sessions', 'POST', await proof(a, false))).status, 410);
  },
);
