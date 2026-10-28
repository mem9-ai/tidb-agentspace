import createClient from 'openapi-fetch';
import type { paths } from './schema';

export function resolveApiOrigin(config: unknown, pageOrigin: string): string {
  if (
    !config ||
    typeof config !== 'object' ||
    !('apiOrigin' in config) ||
    typeof config.apiOrigin !== 'string'
  )
    throw new Error('config.json must provide an apiOrigin string.');
  const url = new URL(config.apiOrigin || pageOrigin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== (config.apiOrigin || pageOrigin)
  )
    throw new Error('apiOrigin must be an HTTP(S) origin without a path or credentials.');
  return url.origin;
}

export function resolveApiBaseUrl(config: unknown, pageOrigin: string): string {
  const origin = resolveApiOrigin(config, pageOrigin);
  const prefix =
    config && typeof config === 'object' && 'apiPathPrefix' in config ? config.apiPathPrefix : '';
  if (typeof prefix !== 'string' || !/^(?:\/[A-Za-z0-9_-]+)*$/.test(prefix))
    throw new Error('apiPathPrefix must be empty or an absolute path without a trailing slash.');
  return origin + prefix;
}

export class WorkspaceApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function createWorkspaceClient(
  origin: string,
  fetcher: typeof fetch = fetch,
  apiPath = '/api/v1',
) {
  const client = createClient<paths>({
    baseUrl: origin + apiPath,
    credentials: 'include',
    fetch: fetcher,
  });
  client.use({
    async onResponse({ response }) {
      if (response.ok) return;
      let message = `Request failed (${response.status}).`,
        code: string | undefined;
      let requestId = response.headers.get('X-Request-Id') || undefined;
      try {
        const body: unknown = await response.clone().json();
        if (
          body &&
          typeof body === 'object' &&
          'error' in body &&
          body.error &&
          typeof body.error === 'object'
        ) {
          if ('message' in body.error && typeof body.error.message === 'string')
            message = body.error.message;
          if ('code' in body.error && typeof body.error.code === 'string') code = body.error.code;
          if ('requestId' in body.error && typeof body.error.requestId === 'string')
            requestId = body.error.requestId;
        }
      } catch {
        /* A proxy may return an HTML error page. Preserve its HTTP status. */
      }
      throw new WorkspaceApiError(message, response.status, code, requestId);
    },
  });
  return client;
}

export async function responseData<T>(result: Promise<{ data?: T }>): Promise<T> {
  const { data } = await result;
  if (data === undefined) throw new Error('The API returned no response body.');
  return data;
}
