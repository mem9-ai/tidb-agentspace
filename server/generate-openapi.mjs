import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { capabilities } from './store.mjs';
const regionSchema = {
  type: 'string',
  enum: [...new Set(Object.values(capabilities).flatMap((value) => value.regions))],
};
const schemas = {
  Resource: {
    type: 'object',
    required: ['id', 'name', 'kind', 'region', 'status', 'createdAt'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      kind: { enum: ['mysql', 'postgresql', 'filesystem'] },
      region: { type: 'string' },
      status: { enum: ['active', 'provisioning', 'failed', 'suspended', 'deleting', 'deleted'] },
      provider: {
        enum: ['local', 'drive9-anonymous'],
        description: 'Missing on legacy local resources.',
      },
      uploadLimitBytes: {
        type: 'integer',
        description: 'Negotiated gateway upload limit; zero means uploads are unavailable.',
      },
      connectionError: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  File: {
    type: 'object',
    required: ['id', 'resourceId', 'path', 'type', 'size', 'updatedAt'],
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
    required: [
      'id',
      'name',
      'prefix',
      'scopes',
      'resourceIds',
      'createdAt',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
    ],
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
    required: ['error'],
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
const array = (item) => ({
  type: 'object',
  required: ['data'],
  properties: { data: { type: 'array', items: item } },
});
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  required,
  properties,
});
Object.assign(schemas, {
  Workspace: object({
    id: str,
    name: str,
    description: str,
    plan: str,
    createdAt: { type: 'string', format: 'date-time' },
  }),
  Profile: object({ name: str, email: str, role: str }),
  Event: object(
    {
      id: str,
      action: str,
      resource: str,
      resourceId: { type: ['string', 'null'] },
      actor: str,
      at: str,
      outcome: str,
    },
    ['id', 'action', 'resource', 'actor', 'at', 'outcome'],
  ),
  Usage: object({
    resourceId: str,
    name: str,
    kind: { enum: ['mysql', 'postgresql', 'filesystem'] },
    storageBytes: { type: ['integer', 'null'] },
    storageLimitBytes: { type: ['integer', 'null'] },
    monthlyRU: { type: ['integer', 'null'] },
    monthlyRULimit: { type: ['integer', 'null'] },
    fileCount: { type: ['integer', 'null'] },
    measured: { type: 'boolean' },
  }),
  Capability: object(
    {
      label: str,
      regions: { type: 'array', items: regionSchema },
      storageGiB: { type: ['number', 'null'] },
      monthlyRU: { type: 'number' },
      maxFiles: { type: ['integer', 'null'] },
      preview: { type: 'boolean' },
      provider: str,
    },
    ['label', 'regions', 'storageGiB', 'preview'],
  ),
  Capabilities: object(
    Object.fromEntries(
      ['mysql', 'postgresql', 'filesystem'].map((kind) => [kind, ref('Capability')]),
    ),
  ),
  Bootstrap: object({
    workspace: ref('Workspace'),
    profile: ref('Profile'),
    resources: { type: 'array', items: ref('Resource') },
    files: { type: 'array', items: ref('File') },
    keys: { type: 'array', items: ref('Key') },
    events: { type: 'array', items: ref('Event') },
    usage: { type: 'array', items: ref('Usage') },
    queryCount: { type: 'integer' },
    capabilities: ref('Capabilities'),
    mode: { enum: ['demo', 'hybrid'] },
  }),
});
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
      422: response(ref('Error'), 'Unsupported demo SQL'),
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
      output: array(ref('Workspace')),
    }),
  },
  [ws]: {
    get: operation('getWorkspace', 'Describe a workspace', 'resources:read', {
      output: object({ data: ref('Workspace') }),
    }),
  },
  [ws + '/bootstrap']: {
    get: operation('getBootstrap', 'Load the local owner Console state', null, {
      owner: true,
      output: ref('Bootstrap'),
    }),
  },
  [ws + '/resources']: {
    get: operation('listResources', 'Discover databases and file systems', 'resources:read', {
      output: object({
        data: { type: 'array', items: ref('Resource') },
        capabilities: ref('Capabilities'),
      }),
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
            kind: { enum: ['mysql', 'postgresql', 'filesystem'] },
            region: {
              ...regionSchema,
              description:
                'Choose a region supported by the resource kind in capabilities. The first supported region is the Console default.',
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
                required: ['size'],
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
  [ws + '/queries']: {
    post: operation(
      'executeDemoQuery',
      'Execute supported demo SELECT patterns',
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
                'Only SELECT 1 [AS connected] or SELECT * FROM agent_events [LIMIT n]. Other SQL returns 422.',
            },
          },
        },
        output: {
          type: 'object',
          required: ['columns', 'rows', 'rowCount', 'mode', 'durationMs'],
          properties: {
            columns: { type: 'array', items: str },
            rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
            rowCount: { type: 'integer' },
            mode: { const: 'demo' },
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
        output: object({
          data: { type: 'array', items: ref('Usage') },
          mode: { const: 'demo' },
          queryCount: { type: 'integer' },
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
        output: array(ref('Event')),
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
        required: ['data', 'secret'],
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
paths['/api/health'] = {
  servers: [{ url: '/' }],
  get: {
    operationId: 'getHealth',
    security: [],
    responses: {
      200: response(
        object({ status: { const: 'ok' }, mode: { enum: ['demo', 'hybrid'] }, filesProvider: str }),
      ),
    },
  },
};
paths['/api/session'] = {
  servers: [{ url: '/' }],
  post: {
    ...operation('createLocalSession', 'Create a loopback-only demo owner session', null, {
      input: object({}, []),
      output: object({ workspaceId: { const: 'ws_agentlab' }, mode: { const: 'demo' } }),
    }),
    security: [],
    description:
      'Local demonstration only. Sets an HttpOnly SameSite=Strict cookie. Allowed browser origins require credentialed CORS; production identity is not implemented.',
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
      'A local demonstration API. Cloud provisioning, native database connections, and cloud telemetry are simulated. Files, API-key enforcement, and settings persist on this machine. Browser guest sessions are only suitable for loopback validation; production identity is deferred.',
  },
  servers: [
    { url: '/api/v1', description: 'Standalone Workspace API; resolve against the API origin' },
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
