import createClient from 'openapi-fetch';
import type { paths } from './global-schema';

/** The Global authority manages Keys and discovery; a data request uses a Region client. */
export function createGlobalApiClient(
  origin: string,
  trustedOrigins: readonly string[],
  fetcher: typeof fetch = fetch,
  owner = false,
) {
  const url = new URL(origin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.search ||
    url.hash ||
    !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(url.pathname) ||
    !trustedOrigins.includes(url.origin) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password
  )
    throw new Error('Untrusted Global origin.');
  const boundedFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (
      target.origin !== url.origin ||
      !target.pathname.startsWith(url.pathname.replace(/\/$/, '') + '/api/')
    )
      throw new Error('Request outside the Global API.');
    return fetcher(
      new Request(request, { redirect: 'error', credentials: owner ? 'include' : 'omit' }),
    );
  };
  return createClient<paths>({ baseUrl: origin, fetch: boundedFetch });
}

/** No credential is persisted. Callers keep the Workspace Key in application secret storage. */
export async function exchangeGlobalKey(
  client: ReturnType<typeof createGlobalApiClient>,
  workspaceId: string,
  workspaceKey: string,
  scopes?: string[],
) {
  if (!workspaceKey || /\s/.test(workspaceKey)) throw new Error('Invalid Workspace Key.');
  const result = await client.POST('/api/v1/workspaces/{workspaceId}/token-issuances', {
    params: { path: { workspaceId } },
    headers: { Authorization: `Bearer ${workspaceKey}` },
    body: { audience: 'global', ...(scopes ? { scopes } : {}) },
  });
  if (result.error) throw new Error(result.error.error.code);
  if (!result.data) throw new Error('Token issuance returned no result.');
  return result.data;
}

export async function discoverAuthorizedRegions(
  client: ReturnType<typeof createGlobalApiClient>,
  workspaceId: string,
  globalToken: string,
) {
  if (!globalToken || /\s/.test(globalToken)) throw new Error('Invalid Global Token.');
  const result = await client.GET('/api/v1/workspaces/{workspaceId}/regions', {
    params: { path: { workspaceId } },
    headers: { Authorization: `Bearer ${globalToken}` },
  });
  if (result.error) throw new Error(result.error.error.code);
  if (!result.data) throw new Error('Region discovery returned no result.');
  return result.data.data;
}
