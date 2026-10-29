import { createWorkspaceClient, resolveApiOrigin, responseData } from './transport';
import { createUploadFetch, type UploadProgress } from './upload-transport';
import type { components, operations } from './schema';

export type Resource = components['schemas']['Resource'];
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
export type FileExportPreparation = components['schemas']['FileExportPreparation'];
export type FileExportPreparationInput = components['schemas']['FileExportPreparationInput'];
export type FileExportInput = components['schemas']['FileExportInput'];
export type FileExportOutput = components['schemas']['FileExportOutput'];
export type DatabaseImportParsing = components['schemas']['DatabaseImportParsing'];
export type DatabaseImportResult = components['schemas']['DatabaseImportResult'];
export type WriteFileInput = JsonBody<operations['writeFile']>;
export type ResultExportInput = JsonBody<operations['exportResult']>;
export type ResultExportOutput =
  operations['exportResult']['responses'][200]['content']['application/json'];
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
  prepareDatabaseImport: (
    body: components['schemas']['DatabaseImportPreparationInput'],
    signal?: AbortSignal,
  ) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/database-imports/prepare', { params, body, signal }),
    ),
  prepareDatabaseImportUpload: (
    resourceId: string,
    file: File,
    parsing: DatabaseImportParsing,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ) =>
    responseData(
      createWorkspaceClient(apiOrigin, createUploadFetch(onProgress)).POST(
        '/workspaces/{workspaceId}/database-imports/prepare-upload',
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
          bodySerializer: (value) => value,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal,
        },
      ),
    ),
  commitDatabaseImport: (body: components['schemas']['DatabaseImportInput']) =>
    responseData(client.POST('/workspaces/{workspaceId}/database-imports', { params, body })),
  prepareFileExport: (body: FileExportPreparationInput, signal?: AbortSignal) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/file-exports/prepare', { params, body, signal }),
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
  retryDatabaseSetup: (resourceId: string) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/resources/{resourceId}/setup', {
        params: { path: { workspaceId, resourceId } },
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
      client.GET('/workspaces/{workspaceId}/resources/{resourceId}/table', {
        params: { path: { workspaceId, resourceId }, query: { name } },
        signal,
      }),
    ),
  tableRows: (resourceId: string, name: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/resources/{resourceId}/table/rows', {
        params: { path: { workspaceId, resourceId }, query: { name } },
        signal,
      }),
    ),
  query: (body: JsonBody<operations['executeQuery']>, signal?: AbortSignal) =>
    responseData(client.POST('/workspaces/{workspaceId}/queries', { params, body, signal })),
  saveFile: (body: WriteFileInput, onProgress?: (progress: UploadProgress) => void) =>
    responseData(
      (onProgress ? createWorkspaceClient(apiOrigin, createUploadFetch(onProgress)) : client).PUT(
        '/workspaces/{workspaceId}/files',
        { params, body },
      ),
    ),
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
  uploadFile: (
    file: Pick<WorkspaceFile, 'resourceId' | 'path'>,
    body: Blob,
    onProgress: (progress: UploadProgress) => void,
  ) =>
    responseData(
      createWorkspaceClient(apiOrigin, createUploadFetch(onProgress)).PUT(
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
