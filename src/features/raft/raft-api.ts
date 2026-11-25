import { createGlobalApiClient } from '../../api/global-client';
import { globalApiSettings } from '../../api/client';
import type { components } from '../../api/global-schema';

type Schemas = components['schemas'];
export type RaftContext = Schemas['RaftContext'];
export type RaftResource = Schemas['RaftResource'];
export type RaftEnrollment = Schemas['RaftEnrollment'];
export type RaftGrant = Schemas['RaftGrant'];
export type RaftFile = Schemas['RaftFile'];
export type RaftTags = Schemas['RaftTags'];
export class RaftError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function unpack<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error || !result.response.ok) {
    const error = result.error;
    const code = error && typeof error === 'object' && 'error' in error ? error.error : undefined;
    throw new RaftError(
      result.response.status,
      code && typeof code === 'object' && 'code' in code && typeof code.code === 'string'
        ? code.code
        : 'REQUEST_FAILED',
    );
  }
  if (result.data === undefined) throw new Error('The service returned no response.');
  return result.data;
}
export async function raftApi() {
  const { baseUrl } = await globalApiSettings();
  const client = createGlobalApiClient(baseUrl, [new URL(baseUrl).origin], fetch, true);
  return {
    loginUrl: `${baseUrl}/auth/raft/login`,
    config: async () => unpack(await client.GET('/api/raft/config')),
    context: async (cursor?: string) =>
      unpack(await client.GET('/api/raft/actions/context', { params: { query: { cursor } } })),
    workspace: async (workspaceId: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}', {
          params: { path: { workspaceId } },
        }),
      ),
    createWorkspace: async (requestId: string, name: string, regionId: string) =>
      unpack(await client.POST('/api/raft/workspaces', { body: { requestId, name, regionId } })),
    admissionCandidate: async (workspaceId: string, principalId: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}/principals/{principalId}', {
          params: { path: { workspaceId, principalId } },
        }),
      ),
    invite: async (
      workspaceId: string,
      requestId: string,
      principalId: string,
      generation: number,
    ) =>
      unpack(
        await client.POST('/api/raft/workspaces/{workspaceId}/invitations', {
          params: { path: { workspaceId }, header: { 'If-Match': `"${generation}"` } },
          body: { requestId, principalId },
        }),
      ),
    audit: async (workspaceId: string, cursor?: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}/audit-events', {
          params: { path: { workspaceId }, query: { cursor } },
        }),
      ),
    ownEnrollment: async (workspaceId: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}/enrollments/self', {
          params: { path: { workspaceId } },
        }),
      ),
    enroll: async (workspaceId: string) =>
      unpack(
        await client.POST('/api/raft/workspaces/{workspaceId}/enrollments', {
          params: { path: { workspaceId } },
          body: {},
        }),
      ),
    enrollments: async (workspaceId: string, cursor?: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}/enrollments', {
          params: { path: { workspaceId }, query: { cursor } },
        }),
      ),
    decide: async (
      workspaceId: string,
      principalId: string,
      approved: boolean,
      generation: number,
    ) =>
      unpack(
        await client.PATCH('/api/raft/workspaces/{workspaceId}/enrollments/{principalId}', {
          params: { path: { workspaceId, principalId }, header: { 'If-Match': `"${generation}"` } },
          body: { approved },
        }),
      ),
    removeMember: async (workspaceId: string, principalId: string, generation: number) =>
      unpack(
        await client.DELETE('/api/raft/workspaces/{workspaceId}/members/{principalId}', {
          params: { path: { workspaceId, principalId }, header: { 'If-Match': `"${generation}"` } },
        }),
      ),
    inventory: async (workspaceId: string, cursor?: string) =>
      unpack(
        await client.GET('/api/raft/actions/list-resources', {
          params: { query: { workspaceId, cursor } },
        }),
      ),
    catalog: async (workspaceId: string, cursor?: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}/resources', {
          params: { path: { workspaceId }, query: { cursor } },
        }),
      ),
    createResource: async (
      workspaceId: string,
      body: { requestId: string; kind: 'filesystem' | 'postgresql'; name: string; region: string },
    ) =>
      unpack(
        await client.POST('/api/raft/workspaces/{workspaceId}/resources', {
          params: { path: { workspaceId } },
          body,
        }),
      ),
    shareBatch: async (
      workspaceId: string,
      body: Schemas['RaftShareBatchInput'],
      generation: number,
    ) =>
      unpack(
        await client.POST('/api/raft/workspaces/{workspaceId}/resources/share-batches', {
          params: { path: { workspaceId }, header: { 'If-Match': `"${generation}"` } },
          body,
        }),
      ),
    grants: async (workspaceId: string, resourceId: string, cursor?: string) =>
      unpack(
        await client.GET('/api/raft/workspaces/{workspaceId}/resources/{resourceId}/grants', {
          params: { path: { workspaceId, resourceId }, query: { cursor } },
        }),
      ),
    share: async (
      workspaceId: string,
      resourceId: string,
      grantId: string,
      body: Schemas['RaftGrantInput'],
      generation: number,
    ) =>
      unpack(
        await client.PUT(
          '/api/raft/workspaces/{workspaceId}/resources/{resourceId}/grants/{grantId}',
          {
            params: {
              path: { workspaceId, resourceId, grantId },
              header: { 'If-Match': `"${generation}"` },
            },
            body,
          },
        ),
      ),
    read: async (workspaceId: string, resourceId: string, path: string) =>
      unpack(
        await client.GET('/api/raft/actions/read-file', {
          params: { query: { workspaceId, resourceId, path } },
        }),
      ),
    write: async (
      workspaceId: string,
      resourceId: string,
      path: string,
      content: string,
      version?: string,
    ) =>
      unpack(
        await client.PUT('/api/raft/workspaces/{workspaceId}/resources/{resourceId}/files', {
          params: { path: { workspaceId, resourceId } },
          body: { path, content, ...(version ? { version } : {}) },
        }),
      ),
    tags: async (workspaceId: string, resourceId: string, body: RaftTags) =>
      unpack(
        await client.PUT('/api/raft/workspaces/{workspaceId}/resources/{resourceId}/tags', {
          params: { path: { workspaceId, resourceId } },
          body,
        }),
      ),
    query: async (body: Schemas['RaftQueryInput']) =>
      unpack(await client.POST('/api/raft/actions/query', { body })),
    queryStatus: async (workspaceId: string, resourceId: string, requestId: string) =>
      unpack(
        await client.GET('/api/raft/actions/query-status', {
          params: { query: { workspaceId, resourceId, requestId } },
        }),
      ),
    logout: async () => {
      const response = await fetch(`${baseUrl}/auth/raft/logout`, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new RaftError(response.status, 'SIGN_OUT_FAILED');
    },
  };
}
export type RaftApi = Awaited<ReturnType<typeof raftApi>>;

export function errorMessage(error: unknown) {
  if (error instanceof RaftError) {
    if (error.code === 'INVALID_SQL') return 'Enter a valid SQL query of at most 64 KiB.';
    if (error.code === 'READ_ONLY_SQL_REQUIRED')
      return 'Only read-only SQL is allowed. Edit the query and run it again.';
    if (error.status === 401) return 'Your sign-in has expired. Sign in with Raft again.';
    if (error.status === 403) return 'Your current permissions do not allow this operation.';
    if (error.status === 412) return 'This item changed. Load the latest version before saving.';
    if (error.code === 'REGIONAL_OUTCOME_UNKNOWN')
      return 'The response was lost. Keep the same request and check its status before retrying.';
    if (error.status === 503)
      return 'The service is temporarily unavailable. Retry the same request.';
    return `The request could not complete (${error.code}).`;
  }
  return error instanceof Error ? error.message : 'The service could not be reached.';
}
