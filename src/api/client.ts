import { createWorkspaceClient, resolveApiOrigin, responseData } from './transport';
import type { components, operations } from './schema';

export type Resource = components['schemas']['Resource'];
export type ApiKey = components['schemas']['Key'];
export type Data = components['schemas']['Bootstrap'];
export type WorkspaceFile = components['schemas']['File'];
export type QueryResult =
  operations['executeDemoQuery']['responses'][200]['content']['application/json'];
type JsonBody<T extends { requestBody: { content: { 'application/json': unknown } } }> =
  T['requestBody']['content']['application/json'];
export type CreateKeyInput = JsonBody<operations['createKey']>;
export type WriteFileInput = JsonBody<operations['writeFile']>;
export const workspaceId = 'ws_agentlab';
export const base = `/api/v1/workspaces/${workspaceId}`;
const params = { path: { workspaceId } } as const;
export let apiOrigin = window.location.origin;
let client = createWorkspaceClient(apiOrigin);
let sessionClient = createWorkspaceClient(apiOrigin, fetch, '');

export function configureApi(config: unknown) {
  apiOrigin = resolveApiOrigin(config, window.location.origin);
  client = createWorkspaceClient(apiOrigin);
  sessionClient = createWorkspaceClient(apiOrigin, fetch, '');
}

export const workspaceApi = {
  startSession: () => responseData(sessionClient.POST('/api/session', { body: {} })),
  bootstrap: () => responseData(client.GET('/workspaces/{workspaceId}/bootstrap', { params })),
  resources: () => responseData(client.GET('/workspaces/{workspaceId}/resources', { params })),
  usage: () => responseData(client.GET('/workspaces/{workspaceId}/usage', { params })),
  events: () => responseData(client.GET('/workspaces/{workspaceId}/events', { params })),
  createResource: (body: JsonBody<operations['createResource']>, idempotencyKey: string) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/resources', {
        params: { ...params, header: { 'Idempotency-Key': idempotencyKey } },
        body,
      }),
    ),
  query: (body: JsonBody<operations['executeDemoQuery']>) =>
    responseData(client.POST('/workspaces/{workspaceId}/queries', { params, body })),
  saveFile: (body: WriteFileInput) =>
    responseData(client.PUT('/workspaces/{workspaceId}/files', { params, body })),
  deleteFile: (body: JsonBody<operations['deleteFile']>) =>
    responseData(client.DELETE('/workspaces/{workspaceId}/files', { params, body })),
  listFiles: (resourceId: string, path?: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/files', {
        params: { path: params.path, query: { resourceId, path } },
        signal,
      }),
    ),
  previewFile: async (file: Pick<WorkspaceFile, 'resourceId' | 'path'>, signal?: AbortSignal) => {
    const result = await responseData(
      client.GET('/workspaces/{workspaceId}/files/content', {
        params: { path: params.path, query: { ...file, preview: '1' } },
        signal,
      }),
    );
    if ('arrayBuffer' in result) throw new Error('Expected a JSON preview.');
    return result;
  },
  uploadFile: (file: Pick<WorkspaceFile, 'resourceId' | 'path'>, body: Blob) =>
    responseData(
      client.PUT('/workspaces/{workspaceId}/files/content', {
        params: { path: params.path, query: file, header: { 'If-None-Match': '*' } },
        body,
        bodySerializer: (value) => value,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    ),
  createKey: (body: CreateKeyInput) =>
    responseData(client.POST('/workspaces/{workspaceId}/keys', { params, body })),
  revokeKey: (keyId: string) =>
    responseData(
      client.DELETE('/workspaces/{workspaceId}/keys/{keyId}', {
        params: { path: { workspaceId, keyId } },
      }),
    ),
  settings: (body: JsonBody<operations['updateSettings']>) =>
    responseData(client.PATCH('/workspaces/{workspaceId}/settings', { params, body })),
};

export function contentUrl(file: Pick<WorkspaceFile, 'resourceId' | 'path'>) {
  return apiOrigin + base + '/files/content?' + new URLSearchParams(file);
}
