import { createWorkspaceClient, resolveApiBaseUrl, responseData } from './transport';
import { createUploadFetch, type UploadProgress } from './upload-transport';
import { firstWorkspaceId } from './workspace-selection';
import type { components, operations } from './schema';

export type Resource = components['schemas']['Resource'];
export type Tutorial = components['schemas']['Tutorial'];
export type TableList = components['schemas']['TableList'];
export type TableDetail = components['schemas']['TableDetail'];
export type ApiKey = components['schemas']['Key'];
export type Data = components['schemas']['Bootstrap'];
export type WorkspaceFile = components['schemas']['File'];
export type QueryResult =
  operations['executeQuery']['responses'][200]['content']['application/json'];
type JsonBody<T extends { requestBody: { content: { 'application/json': unknown } } }> =
  T['requestBody']['content']['application/json'];
export type QuerySource = NonNullable<JsonBody<operations['executeQuery']>['sources']>[number];
export type CreateKeyInput = JsonBody<operations['createKey']>;
export type FileAnalysisResult =
  operations['analyzeFile']['responses'][200]['content']['application/json'];
export type FileAnalysisInput = JsonBody<operations['analyzeFile']>;
export type FileAnalysisCapabilities =
  operations['fileAnalysisCapabilities']['responses'][200]['content']['application/json'];
export type TabularFilePreview =
  operations['tabularFilePreview']['responses'][200]['content']['application/json'];
export type FileExportSource = components['schemas']['FileExportSource'];
export type FileExportParsing = components['schemas']['FileExportParsing'];
export type FileExportPreparation = components['schemas']['Preparation'];
export type FileExportPreparationInput = components['schemas']['FileExportPreparationInput'];
export type FileExportInput = components['schemas']['FileExportInput'];
export type FileExportOutput = components['schemas']['FileExportOutput'];
export type DatabaseImportParsing = components['schemas']['DatabaseImportParsing'];
export type DatabaseImportResult = components['schemas']['DatabaseImportResult'];
export type WriteFileInput = JsonBody<operations['writeFile']>;
export type SsoAuthConfig = {
  enabled: boolean;
  guestEnabled?: boolean;
  guestCleanupEnabled?: boolean;
  sessionKind?: 'account' | 'guest';
  provider?: string;
  label?: string;
  loginPath?: string;
  logoutPath?: string;
};
export type ResultExportInput = JsonBody<operations['exportResult']>;
export type ResultExportOutput =
  operations['exportResult']['responses'][200]['content']['application/json'];
export let workspaceId = '';
export let base = '';
let params = { path: { workspaceId } };
export let apiBaseUrl = window.location.origin;
export { apiBaseUrl as apiOrigin };
let client = createWorkspaceClient(apiBaseUrl);
let sessionClient = createWorkspaceClient(apiBaseUrl, fetch, '');

function clearWorkspace() {
  workspaceId = '';
  base = '';
  params = { path: { workspaceId } };
}

export function configureApi(config: unknown) {
  apiBaseUrl = resolveApiBaseUrl(config, window.location.origin);
  client = createWorkspaceClient(apiBaseUrl);
  sessionClient = createWorkspaceClient(apiBaseUrl, fetch, '');
  clearWorkspace();
}

export const workspaceApi = {
  listTutorials: (id: string, cursor?: string) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/tutorials', {
        params: { path: { workspaceId: id }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  replaceTutorial: (
    id: string,
    resourceId: string,
    body: components['schemas']['TutorialInput'],
    version?: string,
  ) =>
    responseData(
      client.PUT('/workspaces/{workspaceId}/tutorials/{resourceId}', {
        params: {
          path: { workspaceId: id, resourceId },
          header: version ? { 'If-Match': version } : { 'If-None-Match': '*' },
        },
        body,
      }),
    ),
  createDatabaseImportPreparation: (
    body: components['schemas']['DatabaseImportPreparationInput'],
    signal?: AbortSignal,
  ) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/database-import-preparations', {
        params,
        body,
        signal,
      }),
    ),
  createDatabaseImportPreparationUpload: (
    resourceId: string,
    file: File,
    parsing: DatabaseImportParsing,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ) =>
    responseData(
      createWorkspaceClient(apiBaseUrl, createUploadFetch(onProgress)).POST(
        '/workspaces/{workspaceId}/database-import-preparations',
        {
          params: {
            path: params.path,
            query: {
              resourceId,
              filename: file.name,
              format: parsing.format,
              ...(parsing.format === 'csv'
                ? {
                    header: parsing.header ? ('true' as const) : ('false' as const),
                    delimiter: parsing.delimiter,
                  }
                : {}),
            },
          },
          body: file,
          bodySerializer: () => file,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal,
        },
      ),
    ),
  createDatabaseImport: (body: components['schemas']['DatabaseImportInput']) =>
    responseData(client.POST('/workspaces/{workspaceId}/database-imports', { params, body })),
  createFileExportPreparation: (body: FileExportPreparationInput, signal?: AbortSignal) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/file-export-preparations', { params, body, signal }),
    ),
  exportFileContent: (body: FileExportInput) =>
    responseData(client.POST('/workspaces/{workspaceId}/file-exports', { params, body })),

  tabularFilePreview: (resourceId: string, path: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/files/tabular-preview', {
        params: { path: { workspaceId }, query: { resourceId, path } },
        signal,
      }),
    ),
  exportResult: (body: ResultExportInput) =>
    responseData(client.POST('/workspaces/{workspaceId}/result-exports', { params, body })),
  fileAnalysisCapabilities: (resourceId: string, path: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/file-analyses/capabilities', {
        params: { path: { workspaceId }, query: { resourceId, path } },
        signal,
      }),
    ),
  analyzeFile: (body: FileAnalysisInput, signal?: AbortSignal) =>
    responseData(client.POST('/workspaces/{workspaceId}/file-analyses', { params, body, signal })),
  startSession: () => responseData(sessionClient.POST('/api/session', { body: {} })),
  startGuestSession: () => responseData(sessionClient.POST('/api/auth/guest')),
  endGuestSession: () => responseData(sessionClient.POST('/api/auth/guest/logout')),
  discoverWorkspace: async () => {
    clearWorkspace();
    const id = firstWorkspaceId(await responseData(client.GET('/workspaces')));
    workspaceId = id;
    base = `/api/v1/workspaces/${encodeURIComponent(id)}`;
    params = { path: { workspaceId: id } };
  },
  authConfig: async (): Promise<SsoAuthConfig> => {
    const response = await fetch(apiBaseUrl + '/api/auth/config', { credentials: 'include' });
    if (!response.ok) return { enabled: false };
    return (await response.json()) as SsoAuthConfig;
  },
  bootstrap: () => responseData(client.GET('/workspaces/{workspaceId}/bootstrap', { params })),
  resources: () => responseData(client.GET('/workspaces/{workspaceId}/resources', { params })),
  resourcesPage: (cursor?: string) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/resources', {
        params: { path: params.path, query: { limit: 100, cursor } },
      }),
    ),
  resource: (resourceId: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/resources/{resourceId}', {
        params: { path: { workspaceId, resourceId } },
        signal,
      }),
    ),
  usage: () => responseData(client.GET('/workspaces/{workspaceId}/usage', { params })),
  usagePage: (cursor?: string) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/usage', {
        params: { path: params.path, query: { limit: 100, cursor } },
      }),
    ),
  events: () => responseData(client.GET('/workspaces/{workspaceId}/events', { params })),
  createResource: (body: JsonBody<operations['createResource']>, idempotencyKey: string) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/resources', {
        params: { ...params, header: { 'Idempotency-Key': idempotencyKey } },
        body,
      }),
    ),
  createResourceSetupAttempt: (resourceId: string) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/resources/{resourceId}/setup-attempts', {
        params: {
          path: { workspaceId, resourceId },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
      }),
    ),
  tables: (resourceId: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/resources/{resourceId}/tables', {
        params: { path: { workspaceId, resourceId } },
        signal,
      }),
    ),
  table: (resourceId: string, name: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/resources/{resourceId}/tables/{tableName}', {
        params: { path: { workspaceId, resourceId, tableName: name } },
        signal,
      }),
    ),
  tableRows: (resourceId: string, name: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/resources/{resourceId}/tables/{tableName}/rows', {
        params: { path: { workspaceId, resourceId, tableName: name } },
        signal,
      }),
    ),
  query: (body: JsonBody<operations['executeQuery']>, signal?: AbortSignal) =>
    responseData(client.POST('/workspaces/{workspaceId}/queries', { params, body, signal })),
  saveFile: (body: WriteFileInput, onProgress?: (progress: UploadProgress) => void) =>
    responseData(
      (onProgress ? createWorkspaceClient(apiBaseUrl, createUploadFetch(onProgress)) : client).PUT(
        '/workspaces/{workspaceId}/files',
        { params, body },
      ),
    ),
  deleteFile: (entry: Pick<WorkspaceFile, 'resourceId' | 'path'>) =>
    responseData(
      client.DELETE('/workspaces/{workspaceId}/files/entry', {
        params: { path: params.path, query: entry },
      }),
    ),
  listFiles: (resourceId: string, path?: string, signal?: AbortSignal, cursor?: string) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/files', {
        params: { path: params.path, query: { resourceId, path, cursor } },
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
  uploadFile: (
    file: Pick<WorkspaceFile, 'resourceId' | 'path'>,
    body: Blob,
    onProgress: (progress: UploadProgress) => void,
  ) =>
    responseData(
      createWorkspaceClient(apiBaseUrl, createUploadFetch(onProgress)).PUT(
        '/workspaces/{workspaceId}/files/content',
        {
          params: { path: params.path, query: file, header: { 'If-None-Match': '*' } },
          body,
          bodySerializer: (value) => value,
          headers: { 'Content-Type': 'application/octet-stream' },
        },
      ),
    ),
  createKey: (body: CreateKeyInput) =>
    responseData(client.POST('/workspaces/{workspaceId}/keys', { params, body })),
  keysPage: (cursor?: string) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/keys', {
        params: { path: params.path, query: { limit: 100, cursor } },
      }),
    ),
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
  return apiBaseUrl + base + '/files/content?' + new URLSearchParams(file);
}
