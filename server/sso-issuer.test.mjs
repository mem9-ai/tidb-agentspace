import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadSsoConfig, resolveEndpoints, verifyIdToken } from './sso.mjs';

function config(issuer) {
  return loadSsoConfig({
    TIDB_SSO_ISSUER: issuer,
    TIDB_SSO_CLIENT_ID: 'test-client',
    TIDB_SSO_CLIENT_SECRET: 'test-secret',
    TIDB_SSO_REDIRECT_URI: 'https://workspace.example/api/auth/tidbcloud/callback',
  });
}

for (const issuer of ['https://id.example/', 'https://id.example', 'https://id.example/tenant/']) {
  test(`OIDC discovery preserves exact issuer and forms its well-known URL: ${issuer}`, async () => {
    const settings = config(issuer);
    assert.equal(settings.issuer, issuer);
    const endpoints = await resolveEndpoints(settings, async (url) => {
      assert.equal(url, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      return Response.json({
        issuer,
        authorization_endpoint: 'https://id.example/authorize',
        token_endpoint: 'https://id.example/token',
        jwks_uri: 'https://id.example/jwks',
      });
    });
    assert.equal(endpoints.tokenUrl, 'https://id.example/token');
    assert.equal(settings.issuer, issuer);
  });
}

test('discovery rejects missing issuer and differences in trailing slash or tenant', async () => {
  for (const issuer of [undefined, '', 'https://id.example', 'https://id.example/other/']) {
    await assert.rejects(
      resolveEndpoints(config('https://id.example/'), async () =>
        Response.json({
          issuer,
          authorization_endpoint: 'https://id.example/authorize',
          token_endpoint: 'https://id.example/token',
          jwks_uri: 'https://id.example/jwks',
        }),
      ),
      /issuer does not match/,
    );
  }
});

test('signed ID token accepts the exact trailing-slash issuer and rejects the normalized alternative', async () => {
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const settings = config('https://id.example/');
  settings._jwks = createLocalJWKSet({ keys: [jwk] });
  const token = (issuer) =>
    new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setSubject('owner')
      .setAudience(settings.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  const claims = await verifyIdToken(settings, {}, await token('https://id.example/'), 'nonce');
  assert.equal(claims.sub, 'owner');
  await assert.rejects(verifyIdToken(settings, {}, await token('https://id.example'), 'nonce'), {
    code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
  });
});
