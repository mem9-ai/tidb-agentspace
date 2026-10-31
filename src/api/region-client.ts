import { createWorkspaceClient } from './transport.ts';

/** An already authenticated discovery result or explicitly configured Region. */
export type RegionEndpoint = {
  regionId: string;
  apiOrigin: string;
  apiPathPrefix: string;
};

export type RegionRoute = {
  workspaceId: string;
  principalId: string;
  endpoint: RegionEndpoint;
};

/** Revalidate a cached route before use; a known route needs no Global request. */
export async function resolveRegionRoute(
  identity: Pick<RegionRoute, 'workspaceId' | 'principalId'> & { regionId: string },
  allowedOrigins: readonly string[],
  cached: RegionRoute | undefined,
  discover: () => Promise<RegionRoute>,
): Promise<RegionRoute> {
  if (!identity.workspaceId || !identity.principalId) throw new Error('Invalid route identity.');
  const candidate = cached ?? (await discover());
  if (
    candidate.workspaceId !== identity.workspaceId ||
    candidate.principalId !== identity.principalId ||
    candidate.endpoint.regionId !== identity.regionId
  )
    throw new Error('Region route identity mismatch.');
  return { ...candidate, endpoint: validateRegionEndpoint(candidate.endpoint, allowedOrigins) };
}

/** Validate a Region endpoint against deployment-owned trust, never a redirect or error body. */
export function validateRegionEndpoint(
  endpoint: RegionEndpoint,
  allowedOrigins: readonly string[],
): RegionEndpoint {
  if (!/^region:[A-Za-z0-9_.:-]{1,100}$/.test(endpoint.regionId))
    throw new Error('Invalid Region identity.');
  const url = new URL(endpoint.apiOrigin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.origin !== endpoint.apiOrigin ||
    !allowedOrigins.includes(url.origin) ||
    !/^(?:\/[A-Za-z0-9_-]+)*$/.test(endpoint.apiPathPrefix)
  )
    throw new Error('Untrusted Region endpoint.');
  return { ...endpoint };
}

/** Create an origin-bound Workspace client using only the supplied regional credential. */
export function createRegionClient(
  endpoint: RegionEndpoint,
  allowedOrigins: readonly string[],
  workspaceId: string,
  credential: string,
  fetcher: typeof fetch = fetch,
) {
  const target = validateRegionEndpoint(endpoint, allowedOrigins);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId) || ['.', '..'].includes(workspaceId))
    throw new Error('Invalid Workspace identity.');
  if (!credential || /[\r\n]/.test(credential)) throw new Error('Invalid regional credential.');
  const apiPath = target.apiPathPrefix + '/api/v1';
  const workspacePath = `${apiPath}/workspaces/${encodeURIComponent(workspaceId)}`;
  const regionalFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== target.apiOrigin ||
      (url.pathname !== workspacePath && !url.pathname.startsWith(workspacePath + '/'))
    )
      throw new Error('Request outside the Region API.');
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${credential}`);
    return fetcher(new Request(request, { headers, redirect: 'error', credentials: 'omit' }));
  };
  return createWorkspaceClient(target.apiOrigin, regionalFetch, apiPath);
}
