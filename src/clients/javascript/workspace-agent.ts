import { connectAgent, type RegionalSecretStore } from '../../api/agent-client.ts';

/** A Workspace connection configured with one public endpoint and one API key. */
export async function connectWorkspace(options: {
  endpoint: string;
  apiKey: string;
  proofKey?: CryptoKeyPair;
  secrets?: RegionalSecretStore;
  fetcher?: typeof fetch;
}) {
  const connection = await connectAgent({
    endpoint: options.endpoint,
    key: options.apiKey,
    proofKey: options.proofKey,
    secrets: options.secrets,
    fetcher: options.fetcher,
  });
  const { client, workspaceId } = connection;
  return {
    async listResources(page: { cursor?: string; limit?: number } = {}) {
      const result = await client.GET('/workspaces/{workspaceId}/resources', {
        params: { path: { workspaceId }, query: page },
      });
      if (!result.data) throw new Error('Unable to list resources.');
      return result.data;
    },
    async query(databaseId: string, sql: string, options: { readOnly?: boolean } = {}) {
      const result = await client.POST('/workspaces/{workspaceId}/queries', {
        params: { path: { workspaceId } },
        body: { resourceId: databaseId, sql, readOnly: options.readOnly ?? true },
      });
      if (!result.data) throw new Error('Unable to run query.');
      return result.data;
    },
    async listFiles(
      fileSystemId: string,
      path = '/',
      page: { cursor?: string; limit?: number } = {},
    ) {
      const result = await client.GET('/workspaces/{workspaceId}/files', {
        params: { path: { workspaceId }, query: { resourceId: fileSystemId, path, ...page } },
      });
      if (!result.data) throw new Error('Unable to list files.');
      return result.data;
    },
    /** Generated API for other operations; Workspace identity is discovered automatically. */
    api: client,
    workspaceId,
    renew: connection.renew,
  };
}
