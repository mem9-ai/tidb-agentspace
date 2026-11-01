import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { metadataCertificates } from './meta-tls.mjs';
import { port } from './meta-fixture.mjs';

// Real Global public API and mTLS policy delivery, used by regional acceptance fixtures.
export async function globalOwnerFixture(
  meta,
  globalMeta,
  region,
  workspaceId,
  regionOrigin,
  index,
) {
  const directory = resolve(meta.directory, `global-owner-${index}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directory, { mode: 0o700 });
  const certificates = await metadataCertificates(directory);
  async function signer(name) {
    const pair = generateKeyPairSync('ed25519');
    const privateFile = resolve(directory, name + '.der');
    const publicFile = resolve(directory, name + '.pub');
    await writeFile(privateFile, pair.privateKey.export({ format: 'der', type: 'pkcs8' }), {
      mode: 0o600,
    });
    await writeFile(
      publicFile,
      Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'),
      { mode: 0o600 },
    );
    return { privateFile, publicFile };
  }
  const global = await signer('global'),
    regional = await signer('region');
  const origin = regionOrigin + '/api/global';
  const control = `127.0.0.1:${await port()}`;
  const configFile = resolve(directory, 'global.json');
  const config = {
    bind: new URL(regionOrigin).host,
    metadata: { transport: 'remote', client: globalMeta.clientConfig },
    publicOrigin: regionOrigin,
    publicPath: '/api/global',
    sharedListener: true,
    environment: 'test',
    signerId: 'global-fixture',
    signingKeyFile: global.privateFile,
    verificationKeyFile: global.publicFile,
    clockDirectory: resolve(directory, 'global-clock'),
    initializeClock: true,
    localWorkspace: { workspaceId, regionId: region.server.authorityId },
    regions: [{ regionId: region.server.authorityId, apiOrigin: regionOrigin, apiPathPrefix: '' }],
    regionConnection: {
      bind: control,
      ...certificates.server,
      allowedRegions: [
        {
          regionId: region.server.authorityId,
          certificateFile: certificates.client.certificateFile,
        },
      ],
    },
    regionControls: [
      {
        regionId: region.server.authorityId,
        origin: `https://${control}`,
        tls: certificates.client,
      },
    ],
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const security = {
    publicOrigin: regionOrigin,
    environment: 'test',
    globalIssuer: origin,
    globalSignerId: 'global-fixture',
    globalPublicKeyFile: global.publicFile,
    regionalSignerId: 'region-fixture',
    regionalSigningKeyFile: regional.privateFile,
    regionalPublicKeyFile: regional.publicFile,
    clockDirectory: resolve(directory, 'region-clock'),
    initializeClock: true,
    accessTokenTtl: 900,
    control: {
      bind: control,
      ...certificates.server,
      globalClientCertificates: [certificates.client.certificateFile],
    },
    regionConnection: { origin: `https://${control}`, tls: certificates.client },
  };
  let cookie;
  async function request(route, { method = 'GET', body, headers = {}, token, pathProfile } = {}) {
    if (!cookie && !token) {
      const session = await fetch(origin + '/api/session', {
        method: 'POST',
        headers: { Origin: regionOrigin },
      });
      assert.equal(session.status, 201, await session.clone().text());
      cookie = session.headers.get('set-cookie').split(';')[0];
      await session.body.cancel();
    }
    const api =
      pathProfile === 'portal'
        ? '/api/portal/v1'
        : pathProfile === 'agent' || token
          ? '/api/v1'
          : '/api/portal/v1';
    const r = await fetch(origin + `${api}/workspaces/${workspaceId}` + route, {
      method,
      headers: {
        Origin: regionOrigin,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
    return { status: r.status, body: await r.json(), headers: r.headers };
  }
  const versions = new Map();
  return {
    security,
    controlProbe: {
      address: control,
      tls: certificates.client,
      regionId: region.server.authorityId,
      apiOrigin: regionOrigin,
    },
    request,
    service: { kind: 'global', configFile },
    origin,
    async restart() {
      config.initializeClock = false;
      security.initializeClock = false;
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    },
    async issueKey(input) {
      const created = await request('/keys', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: {
          name: input.name,
          scopes: input.scopes,
          resourceIds: input.resourceIds,
          expiresAt: Math.floor(Date.now() / 1000) + input.expiresInDays * 86400,
        },
      });
      if (created.status !== 201) return created;
      const key = created.body.data;
      versions.set(key.keyId, key.keyVersion);
      // Delivery can report an uncertain outcome while the Region reconnects. No token is
      // signed before that error; retry only that specific response with the same Key.
      let token;
      const deadline = Date.now() + 15_000;
      do {
        token = await request('/token-issuances', {
          method: 'POST',
          token: created.body.secret,
          body: { audience: region.server.authorityId },
        });
        if (token.status !== 503 || token.body.error?.code !== 'POLICY_DELIVERY_UNKNOWN') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      if (token.status !== 201) return token;
      return {
        ...created,
        body: {
          ...created.body,
          workspaceKey: created.body.secret,
          accessExpiresAt: token.body.expiresAt,
          data: { ...key, id: key.keyId },
          secret: token.body.accessToken,
        },
      };
    },
    revokeKey: (keyId) =>
      request('/keys/' + keyId, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': randomUUID(), 'If-Match': `"${versions.get(keyId)}"` },
      }),
    listKeys: () => request('/keys'),
    deliver: (keyId, keyVersion) =>
      request('/key-policy-deliveries', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { keyId, keyVersion },
      }),
  };
}
