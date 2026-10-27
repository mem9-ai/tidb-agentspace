import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { capabilities } from './store.mjs';
import { zeroRegion } from './providers/zero.mjs';
const schemas = {
  Resource: {
    type: 'object',
    required: ['id', 'name', 'kind', 'region', 'status'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      kind: { enum: ['mysql', 'filesystem'] },
      region: { type: 'string' },
      status: {
        enum: ['active', 'provisioning', 'failed', 'suspended', 'deleting', 'deleted', 'expired'],
      },
      provider: {
        enum: ['local', 'drive9-anonymous', 'tidb-cloud-zero'],
        description: 'Missing on legacy local resources.',
      },
      uploadLimitBytes: {
        type: 'integer',
        description: 'Negotiated gateway upload limit; zero means uploads are unavailable.',
      },
      connectionError: { type: 'string' },
      expiresAt: {
        type: 'string',
        format: 'date-time',
        description: 'Zero expiry reported by the provider. No automatic renewal or replacement.',
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  File: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      resourceId: { type: 'string' },
      path: { type: 'string' },
      type: { enum: ['file', 'directory'] },
      content: { type: 'string' },
      size: { type: 'integer' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  Key: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      prefix: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
      resourceIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit allowed resource IDs, or ["*"] for all current and future resources.',
      },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      lastUsedAt: { type: ['string', 'null'] },
      revokedAt: { type: ['string', 'null'] },
    },
  },
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'requestId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string' },
        },
      },
    },
  },
};
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const array = (item) => ({ type: 'object', properties: { data: { type: 'array', items: item } } });
const response = (schema, description = 'Success') => ({
  description,
  content: { 'application/json': { schema } },
});
function operation(
  id,
  summary,
  scope,
  { input, output = { type: 'object' }, status = 200, owner = false, parameters = [] } = {},
) {
  return {
    operationId: id,
    summary,
    tags: [owner ? 'Local owner' : 'Workspace'],
    description: owner
      ? 'Requires the local browser owner session. Workspace API keys cannot perform this operation.'
      : `Required workspace key scope: ${scope}. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.`,
    'x-required-scope': scope,
    security: owner ? [{ localOwner: [] }] : [{ workspaceKey: [] }, { localOwner: [] }],
    ...(parameters.length ? { parameters } : {}),
    ...(input
      ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } }
      : {}),
    responses: {
      [status]: response(output),
      400: response(ref('Error'), 'Invalid request'),
      401: response(ref('Error'), 'Missing, invalid, expired, or revoked credential'),
      403: response(ref('Error'), 'Insufficient permission'),
      404: response(ref('Error'), 'Resource or endpoint not found'),
      409: response(ref('Error'), 'Conflict or free-tier limit'),
      413: response(ref('Error'), 'Content too large'),
      415: response(ref('Error'), 'Unsupported content type'),
      429: response(ref('Error'), 'Provider quota or rate limit'),
      502: response(ref('Error'), 'Provider unavailable or invalid response'),
      503: response(ref('Error'), 'Provider binding needs operator recovery'),
      422: response(ref('Error'), 'SQL syntax, result limit, or unsupported demo query'),
      410: response(ref('Error'), 'Temporary database expired'),
      504: response(ref('Error'), 'SQL timeout; a write outcome may be unknown'),
    },
  };
}
const ws = '/workspaces/{workspaceId}';
const workspaceId = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { type: 'string', const: 'ws_agentlab' },
  description: 'This local prototype has one workspace.',
};
const paths = {
  '/workspaces': {
    get: operation('listWorkspaces', 'List available workspaces', 'resources:read', {
      output: array({ type: 'object', properties: { id: str, name: str, plan: str } }),
    }),
  },
  [ws]: { get: operation('getWorkspace', 'Describe a workspace', 'resources:read') },
  [ws + '/resources']: {
    get: operation('listResources', 'Discover databases and file systems', 'resources:read', {
      output: array(ref('Resource')),
    }),
    post: operation(
      'createResource',
      'Create a resource using the configured provider',
      'resources:write',
      {
        status: 201,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            schema: { type: 'string', maxLength: 128 },
            description:
              'Optional key for retry-safe creation. Reusing it with a different body returns 409.',
          },
        ],
        input: {
          type: 'object',
          required: ['name', 'kind', 'region'],
          properties: {
            name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,39}$' },
            kind: { enum: ['mysql', 'filesystem'] },
            region: {
              enum: [
                ...new Set([
                  ...Object.values(capabilities).flatMap((value) => value.regions),
                  zeroRegion,
                ]),
              ],
              description:
                'Choose a region supported by the resource kind in capabilities. Zero MySQL uses automatic provider assignment. The first supported region is the Console default.',
            },
          },
        },
        output: {
          type: 'object',
          properties: { data: ref('Resource'), mode: { enum: ['demo', 'live'] } },
        },
      },
    ),
  },
  [ws + '/files']: {
    get: operation(
      'listFiles',
      'List files (Drive9 metadata only; local files include UTF-8 contents)',
      'files:read',
      {
        parameters: [
          { name: 'resourceId', in: 'query', required: true, schema: str },
          {
            name: 'path',
            in: 'query',
            schema: str,
            description: 'Directory to list. Drive9 defaults to root; omit for all local files.',
          },
        ],
        output: array(ref('File')),
      },
    ),
    put: operation('writeFile', 'Create or replace a UTF-8 file or directory', 'files:write', {
      input: {
        type: 'object',
        required: ['resourceId', 'path', 'type'],
        properties: {
          resourceId: str,
          path: {
            type: 'string',
            description:
              'Absolute virtual path. Parent directory must exist; traversal is rejected.',
          },
          type: { enum: ['file', 'directory'] },
          content: {
            type: 'string',
            description:
              'Required for files; maximum 256 KiB of UTF-8 text and subject to the provider upload limit.',
          },
        },
      },
      output: { type: 'object', properties: { data: ref('File') } },
    }),
    delete: operation('deleteFile', 'Delete a file or empty directory', 'files:write', {
      input: {
        type: 'object',
        required: ['resourceId', 'path'],
        properties: { resourceId: str, path: str },
      },
      output: { type: 'object', properties: { deleted: { type: 'boolean' } } },
    }),
  },
  [ws + '/files/content']: {
    get: {
      ...operation(
        'downloadFile',
        'Download original bytes or request a bounded text preview (Drive9)',
        'files:read',
        {
          parameters: [
            { name: 'resourceId', in: 'query', required: true, schema: str },
            { name: 'path', in: 'query', required: true, schema: str },
            {
              name: 'preview',
              in: 'query',
              schema: { enum: ['1'] },
              description:
                'Returns JSON content or an unavailableReason. Never reads files larger than 128 KiB for preview.',
            },
          ],
        },
      ),
      responses: {
        200: {
          description:
            'Attachment download, or JSON when preview=1. Local resources use /files instead.',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/json': {
              schema: {
                type: 'object',
                properties: { content: str, size: { type: 'integer' }, unavailableReason: str },
              },
            },
          },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 502, 503].map((status) => [
            status,
            response(ref('Error'), 'Request failed'),
          ]),
        ),
      },
    },
    put: {
      ...operation(
        'uploadFile',
        'Upload original bytes to Drive9 (gateway maximum 1 MiB)',
        'files:write',
        {
          parameters: [
            { name: 'resourceId', in: 'query', required: true, schema: str },
            { name: 'path', in: 'query', required: true, schema: str },
            {
              name: 'If-None-Match',
              in: 'header',
              schema: { const: '*' },
              description: 'Only create a new file; fail if the path exists.',
            },
          ],
          output: {
            type: 'object',
            properties: { saved: { type: 'boolean' }, size: { type: 'integer' } },
          },
        },
      ),
      requestBody: {
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
    },
  },
  [ws + '/resources/{resourceId}/setup']: {
    parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
    post: operation(
      'retryDatabaseSetup',
      'Resume setup on the same Zero instance; never create a replacement for an uncertain request',
      'resources:write',
      {
        output: { type: 'object', properties: { data: { $ref: '#/components/schemas/Resource' } } },
      },
    ),
  },
  [ws + '/queries']: {
    post: operation(
      'executeQuery',
      'Execute one statement on a selected database; live SQL can read and write',
      'queries:execute',
      {
        input: {
          type: 'object',
          required: ['resourceId', 'sql'],
          properties: {
            resourceId: str,
            sql: {
              type: 'string',
              description:
                'Live Zero: one statement up to 64 KiB, a 15-second deadline, at most 1000 result rows / 1 MiB. queries:execute allows reads and writes under the internal database role. No persistent session or automatic retry. A timeout or result limit can leave writes committed; check before retrying. Demo resources accept only SELECT 1 [AS connected] or SELECT * FROM agent_events [LIMIT n].',
            },
          },
        },
        output: {
          type: 'object',
          properties: {
            columns: { type: 'array', items: str },
            rows: { type: 'array', items: { type: 'object' } },
            rowCount: { type: 'integer' },
            mode: { enum: ['demo', 'live'] },
            affectedRows: {
              type: 'integer',
              description: 'Live statement affected-row count; SELECT returns zero.',
            },
            durationMs: { type: 'number' },
          },
        },
      },
    ),
  },
  [ws + '/usage']: {
    get: operation(
      'getUsage',
      'Get local usage; live trial usage and allowances are unmeasured',
      'usage:read',
      {
        output: array({
          type: 'object',
          properties: {
            resourceId: str,
            kind: str,
            storageBytes: { type: ['integer', 'null'] },
            storageLimitBytes: { type: ['integer', 'null'] },
            monthlyRU: { type: ['integer', 'null'] },
            monthlyRULimit: { type: ['integer', 'null'] },
            fileCount: { type: ['integer', 'null'] },
            measured: {
              type: 'boolean',
              description: 'False for live trial usage; null counters are unknown, not zero.',
            },
          },
        }),
      },
    ),
  },
  [ws + '/events']: {
    get: operation(
      'listEvents',
      'List the latest 200 successful local mutation events',
      'resources:read',
      {
        output: array({
          type: 'object',
          properties: {
            id: str,
            action: str,
            resource: str,
            actor: str,
            at: { type: 'string', format: 'date-time' },
            outcome: str,
          },
        }),
      },
    ),
  },
  [ws + '/keys']: {
    get: operation('listKeys', 'List key metadata without secrets', null, {
      owner: true,
      output: array(ref('Key')),
    }),
    post: operation('createKey', 'Create an expiring scoped local API key', null, {
      owner: true,
      status: 201,
      input: {
        type: 'object',
        required: ['name', 'scopes', 'resourceIds', 'expiresInDays'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 60 },
          scopes: {
            type: 'array',
            minItems: 1,
            items: {
              enum: [
                'resources:read',
                'resources:write',
                'files:read',
                'files:write',
                'queries:execute',
                'usage:read',
              ],
            },
          },
          resourceIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description:
              'Choose existing workspace resource IDs, or ["*"] for all current and future resources. Mixed wildcard and IDs are rejected. Resource creation additionally requires resources:write and ["*"].',
          },
          expiresInDays: { enum: [7, 30, 90] },
        },
      },
      output: {
        type: 'object',
        properties: {
          data: ref('Key'),
          secret: {
            type: 'string',
            description: 'Returned once. Only a SHA-256 digest is persisted.',
          },
        },
      },
    }),
  },
  [ws + '/keys/{keyId}']: {
    parameters: [{ name: 'keyId', in: 'path', required: true, schema: str }],
    delete: operation('revokeKey', 'Immediately revoke an API key', null, {
      owner: true,
      output: { type: 'object', properties: { revoked: { type: 'boolean' } } },
    }),
  },
  [ws + '/settings']: {
    patch: operation('updateSettings', 'Update local workspace and profile', null, {
      owner: true,
      input: {
        type: 'object',
        required: ['workspaceName', 'name'],
        properties: {
          workspaceName: { type: 'string', minLength: 2, maxLength: 50 },
          name: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string', maxLength: 200 },
        },
      },
      output: { type: 'object', properties: { saved: { type: 'boolean' } } },
    }),
  },
};
for (const [path, item] of Object.entries(paths))
  if (path.includes('{workspaceId}')) item.parameters = [workspaceId, ...(item.parameters || [])];
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'TiDB Agent Workspace · Local Prototype API',
    version: '0.1.0',
    description:
      'A loopback Workspace gateway with opt-in real TiDB Cloud Zero MySQL and Singapore Drive9 files. Existing local resources remain demos. Workspace Keys authorize actions and resources; upstream credentials stay internal. Zero trials expire; cloud usage is unmeasured. Production identity and public hosting are deferred.',
  },
  servers: [
    { url: 'http://127.0.0.1:5173/api/v1', description: 'Local Vite proxy' },
    { url: 'http://127.0.0.1:4318/api/v1', description: 'Local API and built frontend' },
  ],
  tags: [{ name: 'Workspace' }, { name: 'Local owner' }],
  paths,
  components: {
    securitySchemes: {
      workspaceKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A unified, expiring Workspace Key. The same key authorizes resource discovery, database query operations, and file operations according to both action scopes and resourceIds. Upstream provider credentials are managed by the service.',
      },
      localOwner: {
        type: 'apiKey',
        in: 'cookie',
        name: 'aw_session',
        description: 'Created by POST /api/session with a JSON body. Local development only.',
      },
    },
    schemas,
  },
};
const target = new URL('../public/openapi.json', import.meta.url);
const rendered = await format(JSON.stringify(spec), {
  ...(await resolveConfig(fileURLToPath(target))),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== rendered) {
    console.error('OpenAPI contract drifted. Run npm run api:generate and commit the result.');
    process.exitCode = 1;
  } else console.log('Generated OpenAPI contract is current.');
} else await writeFile(target, rendered);
