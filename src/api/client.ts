import {
  createWorkspaceClient,
  resolveApiBaseUrl,
  responseData,
  WorkspaceApiError,
} from './transport';
import { createUploadFetch, type UploadProgress } from './upload-transport';
import { firstWorkspaceId } from './workspace-selection';
import type { components, operations } from './schema';
import { createGlobalApiClient } from './global-client';
import type { components as GlobalComponents } from './global-schema';

export type Resource = components['schemas']['Resource'];
export type Tutorial = components['schemas']['Tutorial'];
export type SalesSampleAttempt = components['schemas']['SalesSampleAttempt'];
export type AuditHistory =
  operations['listAuditHistory']['responses'][200]['content']['application/json'];
export type RequestHistory =
  operations['listRequestHistory']['responses'][200]['content']['application/json'];
export type TableList = components['schemas']['TableList'];
export type TableDetail = components['schemas']['TableDetail'];
export type ApiKey = components['schemas']['Key'] & { regionalStatus?: 'pending' | 'applied' };
export type Data = components['schemas']['Bootstrap'];
export type WorkspaceFile = components['schemas']['File'];
export type QueryResult =
  operations['executeQuery']['responses'][200]['content']['application/json'];
type JsonBody<T extends { requestBody: { content: { 'application/json': unknown } } }> =
  T['requestBody']['content']['application/json'];
export type QuerySource = NonNullable<JsonBody<operations['executeQuery']>['sources']>[number];
export type CreateKeyInput = {
  name: string;
  scopes: string[];
  resourceIds: string[];
  expiresInDays: 1 | 7 | 30 | 90;
};
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
  globalApi?: { apiOrigin: string; apiPathPrefix: string };
  regionId?: string;
  guestEnabled?: boolean;
  guestCleanupEnabled?: boolean;
  sessionKind?: 'account' | 'guest';
  provider?: string;
  label?: string;
  loginPath?: string;
  loginUrl?: string;
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
const portalApiPath = '/api/portal/v1';
let client = createWorkspaceClient(apiBaseUrl, fetch, portalApiPath);
let sessionClient = createWorkspaceClient(apiBaseUrl, fetch, '');
let distributedGlobalBase: string | undefined;
const distributedHintKey = () => `workspace-portal:${distributedGlobalBase || ''}`;

function clearWorkspace() {
  workspaceId = '';
  base = '';
  params = { path: { workspaceId } };
}

export function configureApi(config: unknown) {
  apiBaseUrl = resolveApiBaseUrl(config, window.location.origin);
  distributedGlobalBase =
    config &&
    typeof config === 'object' &&
    'portalMode' in config &&
    config.portalMode === 'distributed'
      ? apiBaseUrl
      : undefined;
  if (distributedGlobalBase) apiBaseUrl = new URL(distributedGlobalBase).origin;
  client = createWorkspaceClient(apiBaseUrl, fetch, portalApiPath);
  sessionClient = createWorkspaceClient(apiBaseUrl, fetch, '');
  clearWorkspace();
  globalSettings = undefined;
}

export const workspaceApi = {
  auditHistory: (id: string, cursor?: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/audit-history', {
        params: { path: { workspaceId: id }, query: { limit: 50, ...(cursor ? { cursor } : {}) } },
        signal,
      }),
    ),
  requestHistory: (id: string, cursor?: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/request-history', {
        params: { path: { workspaceId: id }, query: { limit: 50, ...(cursor ? { cursor } : {}) } },
        signal,
      }),
    ),
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
      createWorkspaceClient(apiBaseUrl, createUploadFetch(onProgress), portalApiPath).POST(
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
  selectGuestWorkspace: (id: string) => {
    // The ID comes from the authenticated guest enrollment response; the subsequent bootstrap
    // still enforces the browser session and workspace boundary on the server.
    const selected = firstWorkspaceId({ data: [{ id }] });
    clearWorkspace();
    workspaceId = selected;
    base = `${portalApiPath}/workspaces/${encodeURIComponent(selected)}`;
    params = { path: { workspaceId: selected } };
  },
  discoverWorkspace: async (signal?: AbortSignal) => {
    clearWorkspace();
    let selectedWorkspace: string | undefined;
    if (distributedGlobalBase) {
      const page = new URL(window.location.href);
      const hint =
        page.searchParams.get('portal_workspace') || localStorage.getItem(distributedHintKey());
      if (!hint || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hint))
        throw new WorkspaceApiError('Sign in to your workspace.', 401, 'UNAUTHENTICATED');
      const global = createGlobalApiClient(
        distributedGlobalBase,
        [new URL(distributedGlobalBase).origin],
        fetch,
        true,
      );
      const issued = await globalResult(
        await global.POST('/api/portal/v1/workspaces/{workspaceId}/regional-session-tickets', {
          params: { path: { workspaceId: hint }, header: { Origin: window.location.origin } },
          signal,
        }),
      );
      const region = new URL(issued.region.apiOrigin);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(region.hostname);
      if (
        region.origin !== issued.region.apiOrigin ||
        region.username ||
        region.password ||
        region.search ||
        region.hash ||
        (region.protocol !== 'https:' && !(region.protocol === 'http:' && loopback)) ||
        !/^(?:\/[A-Za-z0-9_-]+)*$/.test(issued.region.apiPathPrefix)
      )
        throw new Error('The Workspace Region address is invalid.');
      const regionalBase = region.origin + issued.region.apiPathPrefix;
      const exchange = await fetch(regionalBase + '/api/portal/auth/session-exchanges', {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: issued.ticket }),
        signal,
      });
      if (!exchange.ok)
        throw new WorkspaceApiError('Unable to establish the Workspace session.', exchange.status);
      const established: unknown = await exchange.json();
      if (
        !established ||
        typeof established !== 'object' ||
        !('workspaceId' in established) ||
        established.workspaceId !== hint
      )
        throw new Error('The Workspace session does not match.');
      signal?.throwIfAborted();
      selectedWorkspace = hint;
      apiBaseUrl = regionalBase;
      client = createWorkspaceClient(apiBaseUrl, fetch, portalApiPath);
      sessionClient = createWorkspaceClient(apiBaseUrl, fetch, '');
      localStorage.setItem(distributedHintKey(), hint);
      page.searchParams.delete('portal_workspace');
      window.history.replaceState(window.history.state, '', page);
      const globalUrl = new URL(distributedGlobalBase);
      globalSettings = {
        enabled: true,
        regionId: issued.region.regionId,
        globalApi: {
          apiOrigin: globalUrl.origin,
          apiPathPrefix: globalUrl.pathname === '/' ? '' : globalUrl.pathname,
        },
      };
    }
    const id = firstWorkspaceId(await responseData(client.GET('/workspaces', { signal })));
    signal?.throwIfAborted();
    if (selectedWorkspace && id !== selectedWorkspace)
      throw new Error('The Workspace returned by the Region does not match.');
    workspaceId = id;
    base = `${portalApiPath}/workspaces/${encodeURIComponent(id)}`;
    params = { path: { workspaceId: id } };
  },
  authConfig: async (): Promise<SsoAuthConfig> => {
    if (distributedGlobalBase) {
      const globalUrl = new URL(distributedGlobalBase);
      const login = new URL(distributedGlobalBase + '/api/auth/tidbcloud/login');
      login.searchParams.set('returnTo', window.location.href);
      return {
        enabled: true,
        provider: 'tidbcloud',
        label: 'Continue with TiDB Account',
        guestEnabled: false,
        loginPath: '/api/auth/tidbcloud/login',
        loginUrl: login.toString(),
        logoutPath: '/api/auth/tidbcloud/logout',
        globalApi: {
          apiOrigin: globalUrl.origin,
          apiPathPrefix: globalUrl.pathname === '/' ? '' : globalUrl.pathname,
        },
      };
    }
    const response = await fetch(apiBaseUrl + '/api/auth/config', { credentials: 'include' });
    if (!response.ok) return { enabled: false };
    return (await response.json()) as SsoAuthConfig;
  },
  bootstrap: () => responseData(client.GET('/workspaces/{workspaceId}/bootstrap', { params })),
  listSalesSampleAttempts: () =>
    responseData(
      client.GET('/workspaces/{workspaceId}/sales-sample-attempts', {
        params: { ...params, query: { fixture: 'us-sales-v1' } },
      }),
    ),
  startSalesSample: (idempotencyKey: string, resourceId?: string) =>
    responseData(
      client.POST('/workspaces/{workspaceId}/sales-sample-attempts', {
        params: { ...params, header: { 'Idempotency-Key': idempotencyKey } },
        body: { fixture: 'us-sales-v1', ...(resourceId ? { resourceId } : {}) },
      }),
    ),
  fileMetadata: (resourceId: string, path: string, signal?: AbortSignal) =>
    responseData(
      client.GET('/workspaces/{workspaceId}/files/metadata', {
        params: { ...params, query: { resourceId, path } },
        signal,
      }),
    ),
  endDistributedSession: async () => {
    if (!distributedGlobalBase) return false;
    const region = await fetch(apiBaseUrl + '/api/auth/tidbcloud/logout', {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
    });
    const global = await fetch(
      distributedGlobalBase + '/api/auth/tidbcloud/logout?' + new URLSearchParams({ workspaceId }),
      { method: 'POST', credentials: 'include', redirect: 'error' },
    );
    if ((!region.ok && region.status !== 401) || (!global.ok && global.status !== 401))
      throw new Error('Unable to complete sign-out. Please try again.');
    localStorage.removeItem(distributedHintKey());
    return true;
  },
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
      (onProgress
        ? createWorkspaceClient(apiBaseUrl, createUploadFetch(onProgress), portalApiPath)
        : client
      ).PUT('/workspaces/{workspaceId}/files', { params, body }),
    ),
  saveReport: (body: WriteFileInput & { type: 'file'; content: string }) =>
    responseData(
      client.PUT('/workspaces/{workspaceId}/files', {
        params: { ...params, header: { 'If-None-Match': '*' } },
        body: { ...body, purpose: 'report' },
      }),
    ),
  createSampleFile: (body: WriteFileInput) =>
    responseData(
      client.PUT('/workspaces/{workspaceId}/files', {
        params: { ...params, header: { 'If-None-Match': '*' } },
        body,
      }),
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
      createWorkspaceClient(apiBaseUrl, createUploadFetch(onProgress), portalApiPath).PUT(
        '/workspaces/{workspaceId}/files/content',
        {
          params: { path: params.path, query: file, header: { 'If-None-Match': '*' } },
          body,
          bodySerializer: (value) => value,
          headers: { 'Content-Type': 'application/octet-stream' },
        },
      ),
    ),
  createKey: async (body: CreateKeyInput) => {
    const global = await ownerGlobalClient();
    const result = await global.POST('/api/portal/v1/workspaces/{workspaceId}/keys', {
      params: {
        path: { workspaceId },
        header: { Origin: window.location.origin, 'Idempotency-Key': crypto.randomUUID() },
      },
      body: {
        name: body.name,
        scopes: body.scopes,
        resourceIds: body.resourceIds,
        expiresAt: Math.floor(Date.now() / 1000) + body.expiresInDays * 86400,
      },
    });
    const value = await globalResult(result);
    return { ...value, data: portalKey(value) };
  },
  keysPage: async (cursor?: string) => {
    const global = await ownerGlobalClient();
    const value = await globalResult(
      await global.GET('/api/portal/v1/workspaces/{workspaceId}/keys', {
        params: { path: { workspaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
      }),
    );
    return { data: value.data.map(portalKey), nextCursor: value.nextCursor };
  },
  revokeKey: async (keyId: string) => {
    const global = await ownerGlobalClient();
    const current = await globalResult(
      await global.GET('/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}', {
        params: { path: { workspaceId, keyId } },
      }),
    );
    return globalResult(
      await global.DELETE('/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}', {
        params: {
          path: { workspaceId, keyId },
          header: {
            Origin: window.location.origin,
            'If-Match': `"${current.data.keyVersion}"`,
            'Idempotency-Key': crypto.randomUUID(),
          },
        },
      }),
    );
  },
  retryKeyPolicy: async (keyId: string) => {
    const global = await ownerGlobalClient();
    const current = await globalResult(
      await global.GET('/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}', {
        params: { path: { workspaceId, keyId } },
      }),
    );
    return globalResult(
      await global.POST('/api/portal/v1/workspaces/{workspaceId}/key-policy-deliveries', {
        params: {
          path: { workspaceId },
          header: { Origin: window.location.origin, 'Idempotency-Key': crypto.randomUUID() },
        },
        body: { keyId, keyVersion: current.data.keyVersion },
      }),
    );
  },
  settings: (body: JsonBody<operations['updateSettings']>) =>
    responseData(client.PATCH('/workspaces/{workspaceId}/settings', { params, body })),
};

export function contentUrl(file: Pick<WorkspaceFile, 'resourceId' | 'path'>) {
  return apiBaseUrl + base + '/files/content?' + new URLSearchParams(file);
}

let globalSettings: SsoAuthConfig | undefined;
export async function globalApiSettings() {
  globalSettings ??= await workspaceApi.authConfig();
  const descriptor = globalSettings.globalApi;
  if (!descriptor) {
    globalSettings = undefined;
    throw new Error(
      'Global API is not configured. Ask the service operator to enable Global Key management.',
    );
  }
  const url = new URL(descriptor.apiOrigin);
  if (
    url.origin !== descriptor.apiOrigin ||
    !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(descriptor.apiPathPrefix || '/')
  )
    throw new Error('Invalid Global API configuration.');
  return {
    baseUrl: descriptor.apiOrigin + descriptor.apiPathPrefix,
    endpoint:
      descriptor.apiOrigin +
      (descriptor.apiPathPrefix.endsWith('/api/global')
        ? descriptor.apiPathPrefix.slice(0, -'/api/global'.length)
        : descriptor.apiPathPrefix) +
      '/api',
    regionId: globalSettings.regionId || '',
  };
}
async function ownerGlobalClient() {
  const { baseUrl } = await globalApiSettings();
  const client = createGlobalApiClient(baseUrl, [new URL(baseUrl).origin], fetch, true);
  const session = await client.GET('/api/auth/session', { params: { query: { workspaceId } } });
  if (session.error) {
    const config = await globalResult(await client.GET('/api/auth/config'));
    if (config.mode === 'local')
      await globalResult(
        await client.POST('/api/session', {
          params: { header: { Origin: window.location.origin } },
        }),
      );
    else throw new Error('Sign in to manage API keys.');
  }
  return client;
}
export async function signInGlobal() {
  const { baseUrl } = await globalApiSettings();
  window.location.assign(
    baseUrl +
      '/api/auth/tidbcloud/login?' +
      new URLSearchParams({ workspaceId, returnTo: window.location.href }),
  );
}
async function globalResult<T>(result: {
  data?: T;
  error?: { error: { code: string; message: string } };
  response?: Response;
}) {
  if (result.error)
    throw new WorkspaceApiError(
      result.error.error.message || result.error.error.code,
      result.response?.status || 500,
      result.error.error.code,
    );
  if (!result.data) throw new Error('Global returned no result.');
  return result.data;
}
type GlobalKeySummary = {
  data: GlobalComponents['schemas']['Key'];
  grants: GlobalComponents['schemas']['Grants'];
  regionalStatus: 'pending' | 'applied';
};
function portalKey(summary: GlobalKeySummary): ApiKey {
  const { data: key, grants } = summary;
  return {
    id: key.keyId,
    regionalStatus: summary.regionalStatus,
    name: key.name,
    prefix: 'awk_' + key.keyId,
    scopes: grants.scopes,
    resourceIds: grants.resourceIds,
    createdAt: new Date(key.createdAt * 1000).toISOString(),
    expiresAt: new Date(key.expiresAt * 1000).toISOString(),
    lastUsedAt: null,
    revokedAt: key.revoked ? new Date(key.createdAt * 1000).toISOString() : null,
  };
}
