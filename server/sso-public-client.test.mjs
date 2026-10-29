import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeCode, loadSsoConfig } from './sso.mjs';

const publicClientEnv = {
  TIDB_SSO_ISSUER: 'https://id.example/',
  TIDB_SSO_CLIENT_ID: 'public-client',
  TIDB_SSO_REDIRECT_URI: 'https://workspace.example/api/auth/tidbcloud/callback',
};

test('public-client SSO loads without a secret and keeps owner authorization default-deny', () => {
  const config = loadSsoConfig(publicClientEnv);
  assert.equal(config.clientId, 'public-client');
  assert.equal(config.issuer, 'https://id.example/');
  assert.equal(config.redirectUri, publicClientEnv.TIDB_SSO_REDIRECT_URI);
  assert.equal(Object.hasOwn(config, 'clientSecret'), false);
  assert.deepEqual(config.ownerSubjects, []);
});

test('public-client configuration still rejects missing issuer, client ID or callback', () => {
  for (const field of Object.keys(publicClientEnv)) {
    const env = { ...publicClientEnv };
    delete env[field];
    assert.throws(() => loadSsoConfig(env), new RegExp(`${field} is required`));
  }
});

test('token exchange sends only authorization-code and PKCE fields, with no client authentication', async () => {
  const config = {
    clientId: 'public-client',
    redirectUri: publicClientEnv.TIDB_SSO_REDIRECT_URI,
  };
  const response = await exchangeCode(
    config,
    { tokenUrl: 'https://id.example/token' },
    { code: 'authorization-code', codeVerifier: 'pkce-verifier' },
    async (url, request) => {
      assert.equal(url, 'https://id.example/token');
      assert.equal(request.method, 'POST');
      const headers = new Headers(request.headers);
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(request.body);
      assert.equal(form.has('client_secret'), false);
      assert.deepEqual(
        [...form.entries()].sort(),
        Object.entries({
          grant_type: 'authorization_code',
          code: 'authorization-code',
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          code_verifier: 'pkce-verifier',
        }).sort(),
      );
      return Response.json({ id_token: 'test-id-token' });
    },
  );
  assert.equal(response.id_token, 'test-id-token');
});
