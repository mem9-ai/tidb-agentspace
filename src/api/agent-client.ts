import { createGlobalApiClient } from './global-client.ts';
import { createRegionClient, validateRegionEndpoint } from './region-client.ts';
import type { RegionEndpoint } from './region-client.ts';

/** Implement with OS/application secret storage and an atomic save. Do not use browser storage. */
export interface RegionalSecretStore {
  load(): Promise<RegionalCredentials | undefined>;
  save(session: RegionalCredentials): Promise<void>;
}
type RegionalIdentity = {
  workspaceId: string;
  regionId: string;
  principalId: string;
  keyId: string;
  endpoint: RegionEndpoint;
  thumbprint: string;
  nonce: string;
  expiresAt: number;
};
export type RegionalSession = RegionalIdentity & {
  state: 'ready';
  familyId: string;
  refreshCredential: string;
};
export type PendingEnrollment = RegionalIdentity & { state: 'enrolling'; enrollmentTicket: string };
export type RegionalCredentials = RegionalSession | PendingEnrollment;
export type AgentConnectionOptions = {
  globalOrigin: string;
  trustedGlobalOrigins: readonly string[];
  trustedRegionOrigins: readonly string[];
  workspaceId: string;
  regionId: string;
  workspaceKey?: string;
  proofKey: CryptoKeyPair;
  secrets: RegionalSecretStore;
  fetcher?: typeof fetch;
};
function base64url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid regional response.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || /\s/.test(value))
    throw new Error('Invalid regional credential response.');
  return value;
}
function expiry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid regional expiry.');
  return value;
}

/** Cached refresh credentials and routes use Region directly, including during Global outage. */
export async function connectAgentWorkspace(options: AgentConnectionOptions) {
  const fetcher = options.fetcher ?? fetch;
  if (
    options.proofKey.privateKey.type !== 'private' ||
    options.proofKey.privateKey.algorithm.name !== 'Ed25519' ||
    options.proofKey.publicKey.algorithm.name !== 'Ed25519'
  )
    throw new Error('An Ed25519 client proof key is required.');
  const exported = await crypto.subtle.exportKey('jwk', options.proofKey.publicKey);
  if (exported.crv !== 'Ed25519' || exported.kty !== 'OKP' || !exported.x)
    throw new Error('Invalid client public key.');
  const jwk = { crv: 'Ed25519', kty: 'OKP', x: exported.x };
  const thumbprint = base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(jwk))),
    ),
  );
  const sign = async (uri: string, nonce: string) => {
    const header = base64url(
      new TextEncoder().encode(JSON.stringify({ typ: 'dpop+jwt', alg: 'EdDSA', jwk })),
    );
    const payload = base64url(
      new TextEncoder().encode(
        JSON.stringify({
          jti: crypto.randomUUID(),
          htm: 'POST',
          htu: uri,
          nonce,
          iat: Math.floor(Date.now() / 1000),
        }),
      ),
    );
    const input = `${header}.${payload}`;
    return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', options.proofKey.privateKey, new TextEncoder().encode(input))))}`;
  };
  let stored = await options.secrets.load();
  let session: RegionalSession;
  let access: { token: string; expiresAt: number } | undefined;
  const regionRequest = async (
    endpoint: RegionEndpoint,
    route: string,
    input: object,
    nonce: string,
    credential?: string,
  ) => {
    const url =
      endpoint.apiOrigin +
      endpoint.apiPathPrefix +
      `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}` +
      route;
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        DPoP: await sign(url, nonce),
        ...(credential ? { Authorization: `Refresh ${credential}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty regional authentication response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new Error('Regional authentication response exceeded its limit.');
      }
      chunks.push(chunk.value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(all));
    if (!response.ok) {
      const error = record(record(body).error);
      throw new Error(typeof error.code === 'string' ? error.code : 'REGION_AUTH_UNAVAILABLE');
    }
    return record(body);
  };
  if (stored) {
    if (
      stored.workspaceId !== options.workspaceId ||
      stored.regionId !== options.regionId ||
      stored.thumbprint !== thumbprint ||
      stored.endpoint.regionId !== options.regionId
    )
      throw new Error('Cached regional identity mismatch.');
    stored = {
      ...stored,
      endpoint: validateRegionEndpoint(stored.endpoint, options.trustedRegionOrigins),
    };
  } else {
    if (!options.workspaceKey || /\s/.test(options.workspaceKey))
      throw new Error('Workspace Key required for initial enrollment.');
    const global = createGlobalApiClient(
      options.globalOrigin,
      options.trustedGlobalOrigins,
      fetcher,
    );
    const issuance = await global.POST('/api/v1/workspaces/{workspaceId}/token-issuances', {
      params: { path: { workspaceId: options.workspaceId } },
      headers: { Authorization: `Bearer ${options.workspaceKey}` },
      body: { audience: options.regionId, clientThumbprint: thumbprint },
    });
    if (issuance.error) throw new Error(issuance.error.error.code);
    const value = issuance.data;
    if (!value || !('enrollmentTicket' in value) || value.region.regionId !== options.regionId)
      throw new Error('Regional enrollment result required.');
    stored = {
      state: 'enrolling',
      workspaceId: options.workspaceId,
      regionId: options.regionId,
      principalId: value.principalId,
      keyId: value.keyId,
      endpoint: validateRegionEndpoint(value.region, options.trustedRegionOrigins),
      thumbprint,
      enrollmentTicket: value.enrollmentTicket,
      nonce: value.nonce,
      expiresAt: value.enrollmentExpiresAt,
    };
    // Keep the exact one-use enrollment intent before sending it. Lost replies cannot create
    // a second family by silently obtaining another Global ticket on reconnect.
    await options.secrets.save(stored);
    access = { token: value.accessToken, expiresAt: value.expiresAt };
  }
  if (stored.state === 'enrolling') {
    const enrolled = await regionRequest(
      stored.endpoint,
      '/refresh-families',
      { ticket: stored.enrollmentTicket },
      stored.nonce,
    );
    if (enrolled.keyId !== stored.keyId) throw new Error('Regional Key mismatch.');
    session = {
      state: 'ready',
      workspaceId: stored.workspaceId,
      regionId: stored.regionId,
      principalId: stored.principalId,
      keyId: stored.keyId,
      endpoint: stored.endpoint,
      thumbprint: stored.thumbprint,
      familyId: text(enrolled.familyId),
      refreshCredential: text(enrolled.refreshCredential),
      nonce: text(enrolled.nonce),
      expiresAt: expiry(enrolled.expiresAt),
    };
    await options.secrets.save(session);
  } else {
    session = stored;
  }
  let renewing: Promise<void> | undefined;
  let unavailable: unknown;
  const renew = async () => {
    if (unavailable) throw unavailable;
    if (!renewing)
      renewing = (async () => {
        if (!session) throw new Error('Regional session unavailable.');
        const result = await regionRequest(
          session.endpoint,
          '/token-issuances',
          { keyId: session.keyId },
          session.nonce,
          session.refreshCredential,
        );
        if (result.keyId !== session.keyId || result.familyId !== session.familyId)
          throw new Error('Regional refresh identity mismatch.');
        const next = {
          ...session,
          refreshCredential: text(result.refreshCredential),
          nonce: text(result.nonce),
          expiresAt: expiry(result.refreshExpiresAt),
        };
        const token = { token: text(result.accessToken), expiresAt: expiry(result.expiresAt) };
        await options.secrets.save(next);
        session = next;
        access = token;
      })()
        .catch((error: unknown) => {
          unavailable = error instanceof Error ? error : new Error('REGION_AUTH_OUTCOME_UNKNOWN');
          throw unavailable;
        })
        .finally(() => {
          renewing = undefined;
        });
    await renewing;
  };
  const credential = async () => {
    if (unavailable) throw unavailable;
    if (!access || access.expiresAt <= Math.floor(Date.now() / 1000)) await renew();
    if (!access) throw new Error('Regional token unavailable.');
    return access.token;
  };
  return {
    client: createRegionClient(
      session.endpoint,
      options.trustedRegionOrigins,
      options.workspaceId,
      credential,
      fetcher,
    ),
    endpoint: session.endpoint,
    renew,
  };
}
