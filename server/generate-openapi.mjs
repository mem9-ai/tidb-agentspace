import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { analysisLimits } from '../tools/api-contract/analysis-limits.mjs';
import { fileExportSchemas } from '../tools/api-contract/file-export-schemas.mjs';
import { databaseImportSchemas } from '../tools/api-contract/database-import-schemas.mjs';
import { resultExportSchemas } from '../tools/api-contract/result-export-schemas.mjs';
const regionSchema = {
  type: 'string',
  enum: ['aws-us-east-1', 'aws-us-west-2', 'automatic', 'aws-ap-southeast-1'],
};
const schemas = {
  Resource: {
    type: 'object',
    required: ['id', 'name', 'kind', 'region', 'status', 'createdAt'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      kind: { enum: ['mysql', 'postgresql', 'duckdb', 'filesystem'] },
      region: { type: 'string' },
      status: {
        enum: ['active', 'provisioning', 'failed', 'suspended', 'deleting', 'deleted', 'expired'],
      },
      provider: {
        enum: ['local', 'drive9-anonymous', 'tidb-cloud-zero', 'duckdb-drive9', 'db9-anonymous'],
        description:
          'Missing on legacy local resources. db9-anonymous is PostgreSQL-compatible; its NUMERIC supports 28–29 significant digits. Provider compatibility limits apply.',
      },
      deletion: {
        type: 'object',
        required: ['phase', 'requestedAt'],
        properties: {
          phase: { enum: ['outcome-unknown', 'provider-accepted', 'completed'] },
          requestedAt: { type: 'string', format: 'date-time' },
        },
      },
      allowedActions: { type: 'array', items: { type: 'string' } },
      capabilities: {
        type: 'object',
        required: ['delete', 'deletionCompletion', 'readOnlyQueries', 'conditionalFileWrites'],
        properties: {
          delete: { type: 'boolean' },
          deletionCompletion: {
            enum: ['synchronous', 'providerStatus', 'operatorReconciliation', 'unsupported'],
          },
          readOnlyQueries: { type: 'boolean' },
          conditionalFileWrites: { type: 'boolean' },
        },
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
    required: ['id', 'resourceId', 'path', 'type', 'size', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      resourceId: { type: 'string' },
      path: { type: 'string' },
      type: { enum: ['file', 'directory'] },
      version: {
        type: 'string',
        description:
          'Opaque strong version validator, including its double quotes; send unchanged in If-Match.',
      },
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
Object.assign(schemas, resultExportSchemas, fileExportSchemas, databaseImportSchemas);
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
  QueryResult: {
    type: 'object',
    required: ['columns', 'rows', 'rowCount', 'mode', 'durationMs'],
    properties: {
      columns: { type: 'array', items: str },
      rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rowCount: { type: 'integer' },
      mode: { enum: ['demo', 'live'] },
      affectedRows: {
        type: 'integer',
        description: 'Live statement affected-row count; SELECT returns zero.',
      },
      durationMs: { type: 'number' },
    },
  },
  DatabaseTable: object({ name: str, type: str }),
  TableList: object({
    data: { type: 'array', maxItems: 500, items: ref('DatabaseTable') },
    truncated: { type: 'boolean' },
    mode: { enum: ['demo', 'live'] },
  }),
  TableDetail: object({
    name: str,
    type: str,
    mode: { enum: ['demo', 'live'] },
    query: str,
    columns: {
      type: 'array',
      items: object({
        name: str,
        type: str,
        nullable: { type: 'boolean' },
        default: { type: ['string', 'null'] },
        key: str,
        extra: str,
      }),
    },
    indexes: {
      type: 'array',
      items: object({
        name: str,
        unique: { type: 'boolean' },
        columns: {
          type: 'array',
          items: object({
            name: { type: ['string', 'null'] },
            position: { type: 'integer' },
            prefixLength: { type: ['integer', 'null'] },
          }),
        },
      }),
    },
  }),
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
    kind: { enum: ['mysql', 'postgresql', 'duckdb', 'filesystem'] },
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
      monthlyRU: { type: ['number', 'null'] },
      maxFiles: { type: ['integer', 'null'] },
      preview: { type: 'boolean' },
      provider: str,
      available: {
        type: 'boolean',
        description: 'False when this resource provider is not configured or available.',
      },
    },
    ['label', 'regions', 'storageGiB', 'preview'],
  ),
  Capabilities: object(
    Object.fromEntries(
      ['mysql', 'postgresql', 'duckdb', 'filesystem'].map((kind) => [kind, ref('Capability')]),
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
schemas.ResourceSetupAttempt = object({
  id: { type: 'string', format: 'uuid' },
  resourceId: str,
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  status: { enum: ['succeeded', 'failed', 'outcome-unknown'] },
  errorCode: { type: ['string', 'null'] },
  resource: ref('Resource'),
});
schemas.TutorialInput = {
  ...object({
    sampleId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
    state: { enum: ['pending', 'attempted', 'ready', 'completed'] },
  }),
  additionalProperties: false,
};
schemas.Tutorial = object({
  ...schemas.TutorialInput.properties,
  resourceId: str,
  version: {
    type: 'string',
    pattern: '^"tutorial-[a-f0-9]{32}"$',
    description: 'Strong opaque ETag, including quotes. Send unchanged in If-Match.',
  },
  updatedAt: { type: 'string', format: 'date-time' },
});
const ownerSessions = [{ localOwner: [] }, { accountOwner: [] }, { guestOwner: [] }];
function operation(
  id,
  summary,
  scope,
  { input, output = { type: 'object' }, status = 200, owner = false, parameters = [] } = {},
) {
  return {
    operationId: id,
    summary,
    tags: [owner ? 'Owner' : 'Workspace'],
    description: owner
      ? 'Requires an authenticated Workspace Owner session under the enabled account, Guest, or local/legacy profile. Workspace API keys cannot perform this operation.'
      : `Required workspace key scope: ${scope ?? 'authenticated caller; no additional action scope'}. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. An authenticated Workspace Owner session under the enabled profile may also call this endpoint.`,
    'x-required-scope': scope,
    security: owner ? ownerSessions : [{ workspaceKey: [] }, ...ownerSessions],
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
      405: response(ref('Error'), 'Resource lifecycle operation unsupported by provider'),
      412: response(ref('Error'), 'Version precondition failed without a write'),
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
  schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' },
  description: 'A Workspace ID returned by the authenticated Workspace discovery API.',
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
  [ws + '/tutorials']: {
    get: operation(
      'listTutorials',
      'List durable Workspace tutorial progress in resource-ID order',
      null,
      {
        owner: true,
        parameters: [
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
          },
        ],
        output: object({
          data: { type: 'array', maxItems: 100, items: ref('Tutorial') },
          nextCursor: { type: ['string', 'null'] },
        }),
      },
    ),
  },
  [ws + '/tutorials/{resourceId}']: {
    parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
    get: operation(
      'getTutorial',
      'Read a tutorial bookmark without querying or writing sample data',
      null,
      {
        owner: true,
        output: object({ data: ref('Tutorial') }),
      },
    ),
    put: operation(
      'replaceTutorial',
      'Create or conditionally replace Workspace tutorial progress',
      null,
      {
        owner: true,
        input: ref('TutorialInput'),
        output: object({ data: ref('Tutorial') }),
        parameters: [
          {
            name: 'If-Match',
            in: 'header',
            schema: str,
            description:
              'Existing tutorial version, including quotes. Required for replacement; stale/missing records return 412 without changes. Mutually exclusive with If-None-Match.',
          },
          {
            name: 'If-None-Match',
            in: 'header',
            schema: { const: '*' },
            description:
              'Required for create-only progress migration/creation. An existing record returns 412 without changes. Mutually exclusive with If-Match.',
          },
        ],
      },
    ),
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
            kind: { enum: ['mysql', 'postgresql', 'duckdb', 'filesystem'] },
            region: {
              ...regionSchema,
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
  [ws + '/files/tabular-preview']: {
    get: operation(
      'tabularFilePreview',
      'Read a fixed bounded CSV/Parquet schema and sample',
      'files:read',
      {
        parameters: [
          { name: 'resourceId', in: 'query', required: true, schema: str },
          { name: 'path', in: 'query', required: true, schema: str },
        ],
        output: object({
          resourceId: str,
          path: str,
          format: { enum: ['csv', 'parquet'] },
          readOnly: { const: true },
          inputBytes: { type: 'integer' },
          durationMs: { type: 'integer' },
          fileVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          columns: { type: 'array', maxItems: 50, items: str },
          columnTypes: { type: 'array', maxItems: 50, items: str },
          schema: {
            type: 'array',
            maxItems: 50,
            items: object({ column_name: str, column_type: str }),
          },
          rows: {
            type: 'array',
            maxItems: 20,
            items: { type: 'object', additionalProperties: true },
          },
          rowCount: { type: 'integer', minimum: 0, maximum: 20 },
          totalRows: {
            type: ['string', 'null'],
            description: 'Exact Parquet metadata row count; null for CSV. Not the sample count.',
          },
          typesInferred: { type: 'boolean' },
          truncated: { type: 'boolean' },
        }),
      },
    ),
  },
  [ws + '/file-analyses/capabilities']: {
    get: operation(
      'fileAnalysisCapabilities',
      'Discover read-only analysis for a selected file',
      'files:read',
      {
        parameters: [
          { name: 'resourceId', in: 'query', required: true, schema: str },
          { name: 'path', in: 'query', required: true, schema: str },
        ],
        output: object({
          engine: {
            type: ['string', 'null'],
            enum: ['duckdb', 'bash', null],
            description: 'Default engine, retained for compatibility. Select from engines.',
          },
          engines: {
            type: 'array',
            description:
              'Supported analysis methods with individual availability. CSV offers both engines; Parquet only DuckDB; recognized text only Bash. Availability checks metadata, not successful parsing or UTF-8 decoding.',
            items: object(
              {
                engine: { enum: ['duckdb', 'bash'] },
                available: { type: 'boolean' },
                reason: str,
                input: {
                  ...object(
                    {
                      path: str,
                      workingDirectory: { const: '/workspace' },
                      aliases: { type: 'array', items: str },
                      fileVariable: {
                        const: 'FILE',
                        description:
                          'When present, Workspace sets FILE to input.path for each fresh Bash run. Use quoted "$FILE" or "${FILE}"; this is a Workspace convention, not a Bash built-in. Script assignments do not persist.',
                      },
                    },
                    ['path', 'workingDirectory', 'aliases'],
                  ),
                  description:
                    'Bash only: the selected absolute Workspace path in its read-only virtual snapshot, working directory, and compatible aliases. The legacy alias is omitted when it would shadow the selected path or a parent directory. Not a host path or a mount of other files.',
                },
              },
              ['engine', 'available', 'reason'],
            ),
          },
          format: { type: ['string', 'null'] },
          available: { type: 'boolean', description: 'Availability of the default engine.' },
          reason: { type: 'string', description: 'Unavailable reason for the default engine.' },
          size: { type: 'integer' },
          readOnly: { const: true },
          limits: object(
            Object.fromEntries(
              Object.entries(analysisLimits).map(([k, v]) => [k, { type: 'integer', const: v }]),
            ),
          ),
        }),
      },
    ),
  },
  [ws + '/file-analyses']: {
    post: operation(
      'analyzeFile',
      'Run bounded read-only DuckDB SQL or Just Bash on one selected file',
      'files:analyze',
      {
        input: {
          type: 'object',
          additionalProperties: false,
          required: ['resourceId', 'path', 'engine'],
          properties: {
            resourceId: str,
            path: str,
            engine: { enum: ['duckdb', 'bash'] },
            sql: { type: 'string', maxLength: 65536 },
            command: { type: 'string', maxLength: 65536 },
          },
          oneOf: [
            {
              required: ['sql'],
              properties: { engine: { const: 'duckdb' } },
              not: { required: ['command'] },
            },
            {
              required: ['command'],
              properties: { engine: { const: 'bash' } },
              not: { required: ['sql'] },
            },
          ],
        },
        output: object(
          {
            engine: { enum: ['duckdb', 'bash'] },
            resourceId: str,
            path: str,
            readOnly: { const: true },
            inputBytes: { type: 'integer' },
            durationMs: { type: 'integer' },
            columns: { type: 'array', items: str },
            schema: { type: 'array', items: object({ column_name: str, column_type: str }) },
            columnTypes: { type: 'array', items: str },
            rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
            rowCount: { type: 'integer' },
            stdout: str,
            stderr: str,
            exitCode: { type: 'integer' },
            fileVersion: {
              type: 'string',
              pattern: '^[a-f0-9]{64}$',
              description: 'Saved-byte digest when supported; compare with tabular preview.',
            },
          },
          [
            'engine',
            'resourceId',
            'path',
            'readOnly',
            'inputBytes',
            'durationMs',
            'columns',
            'schema',
            'columnTypes',
            'rows',
            'rowCount',
            'stdout',
            'stderr',
            'exitCode',
          ],
        ),
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
  },
  [ws + '/files/entry']: {
    delete: operation(
      'deleteFile',
      'Delete a file or empty directory identified by its URI',
      'files:write',
      {
        parameters: [
          { name: 'resourceId', in: 'query', required: true, schema: str },
          { name: 'path', in: 'query', required: true, schema: str },
        ],
        output: object({ deleted: { type: 'boolean' } }),
      },
    ),
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
  [ws + '/resources/{resourceId}/setup-attempts']: {
    parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
    post: operation(
      'createResourceSetupAttempt',
      'Create a durable setup attempt on the saved target',
      'resources:write',
      {
        status: 201,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 128 },
            description:
              'Caller/resource-scoped key. Replays return the original attempt without executing setup. No body.',
          },
        ],
        output: object({ data: ref('ResourceSetupAttempt') }),
      },
    ),
    get: operation(
      'listResourceSetupAttempts',
      'List retained setup attempts by opaque ID',
      'resources:read or resources:write',
      {
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        output: object({
          data: { type: 'array', maxItems: 100, items: ref('ResourceSetupAttempt') },
          nextCursor: { type: ['string', 'null'] },
        }),
      },
    ),
  },
  [ws + '/resources/{resourceId}/setup-attempts/{attemptId}']: {
    parameters: [
      { name: 'resourceId', in: 'path', required: true, schema: str },
      { name: 'attemptId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ],
    get: operation(
      'getResourceSetupAttempt',
      'Observe a setup attempt without provider calls or retry',
      'resources:read or resources:write',
      { output: object({ data: ref('ResourceSetupAttempt') }) },
    ),
  },
  [ws + '/resources/{resourceId}/tables']: {
    parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
    get: operation(
      'listDatabaseTables',
      'List up to 500 tables and views in the selected database, ordered by name; truncated means more exist',
      'queries:read',
      { output: ref('TableList') },
    ),
  },
  [ws + '/resources/{resourceId}/tables/{tableName}']: {
    parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
    get: operation(
      'getDatabaseTable',
      'Read columns and ordered index parts for an exact table name; includes a SELECT for the editor',
      'queries:read',
      {
        parameters: [
          {
            name: 'tableName',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 64 },
            description:
              'Exact table name in the current database; not a schema-qualified SQL expression.',
          },
        ],
        output: ref('TableDetail'),
      },
    ),
  },
  [ws + '/resources/{resourceId}/tables/{tableName}/rows']: {
    parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
    get: operation(
      'getDatabaseTableRows',
      'Read up to 100 unordered rows, bounded by 1 MiB and 15 seconds per statement; not pagination or a full export',
      'queries:read',
      {
        parameters: [
          {
            name: 'tableName',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 64 },
          },
        ],
        output: ref('QueryResult'),
      },
    ),
  },
  [ws + '/database-import-preparations']: {
    post: {
      ...operation(
        'createDatabaseImportPreparation',
        'Create a private destination-bound import review',
        'queries:execute on destination; Workspace inputs also require source files:read/analyze',
        {
          status: 201,
          parameters: [
            {
              name: 'resourceId',
              in: 'query',
              schema: str,
              description: 'Required only for octet-stream uploads. Forbidden on JSON requests.',
            },
            {
              name: 'filename',
              in: 'query',
              schema: { type: 'string', minLength: 1, maxLength: 255 },
              description: 'Upload basename, required for octet-stream.',
            },
            {
              name: 'format',
              in: 'query',
              schema: { enum: ['csv', 'parquet'] },
              description: 'Required for octet-stream.',
            },
            {
              name: 'header',
              in: 'query',
              schema: { enum: ['true', 'false'] },
              description: 'Required for CSV uploads, forbidden for Parquet.',
            },
            {
              name: 'delimiter',
              in: 'query',
              schema: { enum: [',', '\t', ';', '|'] },
              description: 'Required for CSV uploads, forbidden for Parquet.',
            },
          ],
          output: ref('Preparation'),
        },
      ),
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: ref('DatabaseImportPreparationInput') },
          'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        },
      },
    },
  },
  [ws + '/database-imports']: {
    post: operation(
      'createDatabaseImport',
      'Confirm reviewed server rows and create a new database table',
      'queries:execute on destination; Workspace files additionally require source files:read and files:analyze',
      { input: ref('DatabaseImportInput'), output: ref('DatabaseImportResult') },
    ),
  },
  [ws + '/file-export-preparations']: {
    post: operation(
      'createFileExportPreparation',
      'Parse an original file or Bash stream for explicit schema review',
      'files:analyze',
      {
        status: 201,
        input: ref('FileExportPreparationInput'),
        output: ref('Preparation'),
      },
    ),
  },
  [ws + '/file-exports']: {
    post: operation(
      'exportFileContent',
      'Copy original bytes, export Bash text or commit a confirmed database import',
      'files:read',
      {
        input: ref('FileExportInput'),
        output: ref('FileExportOutput'),
      },
    ),
  },
  [ws + '/result-exports']: {
    post: operation(
      'exportResult',
      'Export a supplied result snapshot without rerunning its source query',
      'Source database: queries:read (also implied by queries:execute); source File System: files:read and files:analyze. Destination additionally requires files:write or queries:execute and its resource grant',
      { input: ref('ResultExportInput'), output: ref('ResultExportOutput') },
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
            readOnly: {
              type: 'boolean',
              default: false,
              description:
                'Enforced read-only mode. Automatically enabled for queries:read-only Keys.',
            },
            sources: {
              type: 'array',
              maxItems: 4,
              description:
                'DuckDB only: query-scoped CSV/JSON/NDJSON/Parquet snapshots as files.NAME. Nonempty sources require files:read, files:analyze and every source File System grant in addition to database query access. SELECT only; 16 MiB combined input and a shared 15-second deadline. Sources are not persisted.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'resourceId', 'path'],
                properties: {
                  name: {
                    type: 'string',
                    pattern: '^[a-z][a-z0-9_]{0,31}$',
                    description: 'Unique source table name in the per-query files catalog.',
                  },
                  resourceId: str,
                  path: {
                    type: 'string',
                    maxLength: 512,
                    description:
                      'Exact absolute Workspace file path; no globs, traversal, external URLs or native paths.',
                  },
                },
              },
            },
            sql: {
              type: 'string',
              description:
                'queries:read grants a constrained parsed read-only SELECT/CTE/VALUES subset; unknown functions, locks, writes and multiple statements are rejected before provider I/O. queries:execute also permits reads and writes. readOnly:true constrains a full-access caller. Live Zero/DuckDB: one statement up to 64 KiB, a 15-second deadline, at most 1000 result rows / 1 MiB. queries:execute allows reads and writes under the internal database role. No persistent session or automatic retry. A timeout or result limit can leave writes committed; check before retrying. Demo resources accept only SELECT 1 [AS connected] or SELECT * FROM agent_events [LIMIT n].',
            },
          },
        },
        output: ref('QueryResult'),
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
                'files:analyze',
                'queries:read',
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
      503: response(
        ref('Error'),
        'Configured metadata authority is unavailable; no fallback state is seeded',
      ),
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
      output: object({ workspaceId: str, mode: { const: 'demo' } }),
    }),
    security: [],
    description:
      'Explicit loopback guest mode only; disabled when TiDB Account SSO is configured. Requires a real loopback peer. Sets an HttpOnly SameSite=Strict cookie scoped to the configured public path.',
  },
};
paths['/api/auth/config'] = {
  servers: [{ url: '/' }],
  get: {
    operationId: 'getAuthConfig',
    security: [],
    responses: {
      200: response(
        object(
          {
            enabled: { type: 'boolean' },
            guestEnabled: { type: 'boolean' },
            guestCleanupEnabled: { type: 'boolean' },
            sessionKind: { type: 'string', enum: ['account', 'guest'] },
            provider: { const: 'tidbcloud' },
            label: str,
            loginPath: str,
            logoutPath: str,
          },
          ['enabled'],
        ),
      ),
    },
  },
};
paths[ws + '/queries'].post['x-required-scope'] = 'queries:read';
paths[ws + '/tutorials'].get.description +=
  ' Each resource has one current bookmark, retained across sessions and API restarts in encrypted Workspace metadata. This owner-reported progress is a navigation hint, not saved results or proof of data availability. No provider or sample-data I/O occurs.';
paths[ws + '/tutorials/{resourceId}'].put.description +=
  ' One version precondition is mandatory (428 when absent). Creates return 201; replacements return 200. Failed or unknown acknowledgements must be inspected before proceeding. Save attempted before sample writes; saving progress never creates or executes sample data. A new sampleId explicitly replaces the bookmark while keeping previous data intact.';
paths[ws + '/tutorials/{resourceId}'].put.responses[201] = response(
  object({ data: ref('Tutorial') }),
  'Tutorial created',
);
paths[ws + '/tutorials/{resourceId}'].put.responses[201].headers = {
  Location: { schema: str, description: 'URI of this tutorial bookmark.' },
};
paths[ws + '/tutorials/{resourceId}'].put.responses[428] = response(
  ref('Error'),
  'A version precondition is required',
);
for (const [method, status] of [
  ['get', 200],
  ['put', 200],
  ['put', 201],
]) {
  paths[ws + '/tutorials/{resourceId}'][method].responses[status].headers = {
    ...paths[ws + '/tutorials/{resourceId}'][method].responses[status].headers,
    ETag: { schema: str, description: 'Strong opaque tutorial version; equals data.version.' },
  };
}
paths[ws + '/queries'].post['x-write-scope'] = 'queries:execute';
paths[ws + '/queries'].post.description =
  'Requires queries:read (implied by queries:execute) and the database grant. Writes additionally require queries:execute. Read-only mode is enforced for read-only Keys even when readOnly=false. The constrained read-only subset permits at most 1024 lexer tokens and 32 nested delimiters; unsupported syntax/functions fail closed.';
paths[ws + '/resources'].post.responses[201].headers = {
  Location: { schema: str, description: 'URI of the created resource.' },
};
const versionConditions = [
  {
    name: 'If-Match',
    in: 'header',
    schema: { type: 'string', maxLength: 256 },
    description:
      'One strong opaque ETag returned by file metadata. No weak tags, wildcard or lists. Atomically reject a changed/missing file with 412. Mutually exclusive with If-None-Match.',
  },
  {
    name: 'If-None-Match',
    in: 'header',
    schema: { const: '*' },
    description: 'Create only; an existing path returns 412. Mutually exclusive with If-Match.',
  },
];
paths[ws + '/files'].put.parameters = versionConditions;
paths[ws + '/files/content'].put.parameters = paths[ws + '/files/content'].put.parameters
  .filter((p) => p.in !== 'header')
  .concat(versionConditions);
paths[ws + '/files/metadata'] = {
  get: operation(
    'getFileMetadata',
    'Read file identity and an opaque conditional-write version',
    'files:read',
    {
      parameters: [
        { name: 'resourceId', in: 'query', required: true, schema: str },
        { name: 'path', in: 'query', required: true, schema: str },
      ],
      output: object({
        data: object({
          resourceId: str,
          path: str,
          type: { enum: ['file', 'directory'] },
          size: { type: 'integer' },
          version: { type: ['string', 'null'] },
          conditionalWrites: { type: 'boolean' },
        }),
      }),
    },
  ),
};
paths[ws + '/files/metadata'].get.responses[200].headers = {
  ETag: {
    schema: str,
    description: 'Strong version validator when available. Never cache authenticated metadata.',
  },
};
paths[ws + '/context'] = {
  get: operation(
    'getAgentContext',
    'Discover the current caller and effective Workspace permissions',
    null,
    {
      output: object({
        workspaceId: str,
        principal: object({
          id: str,
          kind: { enum: ['owner', 'workspaceKey'] },
          scopes: { type: 'array', items: str },
          resourceIds: { type: 'array', items: str },
          expiresAt: { type: ['string', 'null'], format: 'date-time' },
        }),
        links: object({ self: str, resources: str, queries: str, files: str }),
        capabilities: ref('Capabilities'),
        limits: object({
          sqlBytes: { const: 65536 },
          queryRows: { const: 1000 },
          queryResultBytes: { const: 1048576 },
          fileUploadBytes: { const: 1048576 },
          sqlTimeoutSeconds: { const: 15 },
          readOnlySqlTokens: { const: 1024 },
          readOnlySqlNesting: { const: 32 },
        }),
        permissions: object({
          manageKeys: { type: 'boolean' },
          createResources: { type: 'boolean' },
        }),
      }),
    },
  ),
};
paths[ws + '/context'].get.description +=
  ' Bootstrap with the regional Workspace API URL (including workspaceId) and one Key. No Global lookup or bearer-only scan across Workspaces. No other Key or upstream credentials are returned; effective grants do not override resource/provider availability. queries:execute implies queries:read. Owner session expiry remains governed by its authentication profile.';
paths[ws + '/resources/{resourceId}'] = {
  parameters: [{ name: 'resourceId', in: 'path', required: true, schema: str }],
  get: operation(
    'getResource',
    'Read one resource, its permitted actions and lifecycle status',
    'resources:read',
    { output: object({ data: ref('Resource') }) },
  ),
  delete: operation(
    'deleteResource',
    'Request removal and retain an observable deletion tombstone',
    'resources:write',
    { output: object({ data: ref('Resource') }) },
  ),
};
paths[ws + '/resources/{resourceId}'].delete.responses[405].headers = {
  Allow: {
    schema: { const: 'GET' },
    description: 'Methods available on this provider-backed resource.',
  },
};
paths[ws + '/resources/{resourceId}'].delete.responses[202] = response(
  object({ data: ref('Resource') }),
  'Deletion accepted or outcome unknown. Inspect GET at Location; repeated DELETE never retries the upstream effect. Credentials remain private and retained.',
);
paths[ws + '/resources/{resourceId}'].delete.responses[202].headers = {
  Location: { schema: str, description: 'URI of the retained resource and deletion status.' },
};
paths[ws + '/resources/{resourceId}'].delete.description +=
  ' Local removal completes synchronously (200). Drive9/DuckDB and db9 may return 202 with deletion.phase=provider-accepted or outcome-unknown. This is not proof of physical erasure. Drive9 completion is observed from provider status; db9 requires operator reconciliation. Zero returns 405 unchanged. No automatic retry or re-provisioning, including after restart. Deleting/deleted resources deny new data operations; admitted bounded downloads may finish.';
paths['/api/auth/guest'] = {
  servers: [{ url: '/' }],
  post: {
    operationId: 'startGuestSession',
    security: [],
    description:
      'Start or resume a Guest session from a trusted origin. A new session sets a secure, HttpOnly, SameSite=Strict cookie with an absolute expiry.',
    responses: {
      200: response(object({ workspaceId: str })),
      404: response(ref('Error'), 'Guest sign-in is disabled'),
      default: response(ref('Error'), 'Guest sign-in unavailable or denied'),
    },
  },
};
paths['/api/auth/guest/logout'] = {
  servers: [{ url: '/' }],
  post: {
    operationId: 'logoutGuestSession',
    security: [{ guestOwner: [] }],
    description:
      'End an authenticated Guest Workspace session and durably schedule resource cleanup. Provider deletion can be asynchronous, unsupported or require reconciliation; acceptance is not proof of deletion.',
    responses: {
      200: response(object({ loggedOut: { type: 'boolean' }, cleanup: { const: 'scheduled' } })),
      default: response(ref('Error'), 'Guest logout or cleanup scheduling unavailable'),
    },
  },
};
for (const route of ['login', 'callback']) {
  paths['/api/auth/tidbcloud/' + route] = {
    servers: [{ url: '/' }],
    get: {
      operationId: route === 'login' ? 'startTidbLogin' : 'completeTidbLogin',
      security: [],
      description:
        route === 'login'
          ? 'Browser redirect to the configured provider using code + S256 PKCE. Server retains a single-use ten-minute flow.'
          : 'Registered server callback; verifies signature, issuer, audience and nonce with single-use, cookie-bound state. Managed hosts establish a Workspace-bound aw_account continuity grant with no absolute server expiry; explicit local/legacy profiles require their configured owner grants and issue an eight-hour aw_session.',
      responses: {
        302: {
          description:
            'Redirect to provider or configured same-origin Console; sets HttpOnly flow/session cookies.',
        },
        default: response(ref('Error'), 'Sign-in unavailable, invalid or unauthorized'),
      },
    },
  };
}
paths['/api/auth/tidbcloud/logout'] = {
  servers: [{ url: '/' }],
  post: {
    operationId: 'logoutTidbSession',
    security: [],
    description:
      'Revoke the TiDB Account session and attached Guest cookie. Guest-only sessions must use POST /api/auth/guest/logout to schedule cleanup.',
    responses: { 200: response(object({ loggedOut: { type: 'boolean' } })) },
  },
  get: {
    operationId: 'logoutTidbSessionAndRedirect',
    security: [],
    description:
      'Revoke the TiDB Account session and attached Guest cookie, then redirect. Guest-only sessions must use POST /api/auth/guest/logout.',
    responses: {
      302: { description: 'Session revoked and browser redirected to the configured Console.' },
      200: response(object({ loggedOut: { type: 'boolean' } })),
    },
  },
};
for (const collection of ['database-import-preparations', 'file-export-preparations']) {
  paths[ws + '/' + collection + '/{preparationId}'] = {
    parameters: [
      {
        name: 'preparationId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    get: operation(
      collection === 'database-import-preparations'
        ? 'getDatabaseImportPreparation'
        : 'getFileExportPreparation',
      'Read the current actor review without parsing or provider I/O',
      collection === 'database-import-preparations'
        ? 'queries:execute on destination; source files:read/analyze when present'
        : 'files:read and files:analyze',
      { output: ref('Preparation') },
    ),
    delete: operation(
      collection === 'database-import-preparations'
        ? 'deleteDatabaseImportPreparation'
        : 'deleteFileExportPreparation',
      'Cancel an unconsumed review',
      collection === 'database-import-preparations'
        ? 'queries:execute on destination; source files:read/analyze when present'
        : 'files:read and files:analyze',
      { status: 204 },
    ),
  };
  paths[ws + '/' + collection + '/{preparationId}'].delete.responses[204] = {
    description: 'Review cancelled; no response body. Already consumed reviews return 409.',
  };
  paths[ws + '/' + collection].post.responses[201].headers = {
    Location: { schema: str, description: 'Address of the created actor-bound review resource.' },
  };
}
paths[ws + '/resources/{resourceId}/setup-attempts'].post.responses[201].headers = {
  Location: { schema: str, description: 'Address of the durable setup attempt.' },
};
paths[ws + '/resources/{resourceId}/setup-attempts'].post.description +=
  ' Journaled before I/O; executes inline without a queue. Same caller/resource/idempotency key replays without effects. A different key explicitly requests a new attempt using saved bindings and supported reconciliation/idempotent setup only. Missing bindings cannot provision a replacement. succeeded/failed/outcome-unknown describe the attempt, not HTTP resource creation. GET never executes setup; existing credentials are retained.';
for (const [path, item] of Object.entries(paths))
  if (path.includes('{workspaceId}')) item.parameters = [workspaceId, ...(item.parameters || [])];
for (const route of ['/database-import-preparations', '/database-imports']) {
  paths[ws + route].post.description +=
    ' CSV/Parquet only. Preparations are principal- and destination-bound, expire after five minutes, and retain at most 1,000 rows/100 columns/1 MiB parsed data. Preview returns at most 20 rows; commit uses all retained rows. Local uploads are ephemeral and never create a File System resource. Workspace inputs retain a 16 MiB snapshot budget. Parsing has a 15-second deadline and two slots. Existing 64 KiB SQL-statement budgets apply. Only server-generated DuckDB import writes have a fixed 30-second worker deadline per statement; ordinary SQL and parsing keep 15 seconds. New tables only; no append, overwrite, DROP or automatic write retry. Inspect the destination after an incomplete or uncertain outcome. Changing the target requires a new preparation. API restart invalidates preparations.';
}
paths[ws + '/file-export-preparations'].post.description +=
  ' Also requires files:read and the source File System grant. Fixed CSV/Parquet/text-line parsing, no scripts. Up to 16 MiB original or 1 MiB output text, 1000 rows/100 columns/1 MiB parsed data and 15 seconds, shared worker admission. Returns 20 sample rows and suggested field types with an actor-bound five-minute preparation. Parsing writes nothing. CSV keeps leading zeros and distinguishes quoted empty strings from NULL. Text lines are explicit one-column records.';
paths[ws + '/file-exports'].post.description +=
  ' Original copies require read access; Bash output requires read plus analyze. File targets require files:write and a target grant. Database commits require the exact actor preparation, confirmed=true, reviewed fields, source read/analyze and target queries:execute/grant. Original versions must match; single-use writes, no append/overwrite/retry. Output text is client-supplied authorization context, not attested command lineage. Only file-exports and file-export-preparations permit an 8 MiB JSON envelope for at most 1 MiB output text. Original downloads retain /files/content (local files use /files).';
paths[ws + '/files/tabular-preview'].get.description +=
  ' Fixed CSV/Parquet schema/sample only: accepts resourceId/path, no custom SQL or engine settings. Requires files:read, not files:analyze. Whole version-verified snapshot up to 16 MiB, 15 seconds and shared two-worker budget; at most 20 rows, 50 columns, 128 KiB. CSV types are inferred and totalRows unknown; Parquet count is metadata. No automatic retry. Download unsupported or over-budget files.';
paths[ws + '/file-analyses'].post.description +=
  ' Also requires files:read. Discover engines from capabilities: CSV supports DuckDB SQL over table file or Just Bash over its raw UTF-8 text. Bash exposes the selected absolute Workspace path; discover input.path, input.workingDirectory and compatibility aliases on its engine option. Paths refer only to the virtual selected-file snapshot. Parquet supports only DuckDB, and other recognized text only Just Bash. Only the selected snapshot is available; no provider credentials, network, persistent writes or host paths. Limits: 16 MiB input, 64 KiB script, 15 seconds, 1000 rows / 1 MiB output, two active analyses. Large/unsupported files remain downloadable. No implicit retry.';
paths[ws + '/result-exports'].post.description +=
  ' Client-supplied snapshot, not attested provenance. Up to 100 columns, 1000 rows, 16 nesting levels and 1 MiB request. Downloads: CSV/JSON/JSON Lines, up to 4 MiB encoded output. Files: conditional create, 256 KiB local / 1 MiB live plus provider limits. Database targets: active live resources, CREATE then one INSERT, each up to 64 KiB and 15 seconds; no transaction across both statements. Name collisions never append/replace. EXPORT_INCOMPLETE or a timeout may leave a new table; inspect before retrying. No automatic retry. Precision strings remain text; CSV renders null as empty and prefixes spreadsheet-formula strings. No result values are audited.';
paths[ws + '/result-exports'].post.responses[500] = response(
  ref('Error'),
  'Export may have completed but its activity record could not be saved',
);
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'TiDB Agent Workspace · Local Prototype API',
    version: '0.1.0',
    description:
      'A loopback Workspace gateway with opt-in real db9 PostgreSQL and TiDB Cloud Zero MySQL and Singapore Drive9 files. Existing local resources remain demos. Workspace Keys authorize actions and resources; upstream credentials stay internal. Zero trials expire; cloud usage is unmeasured. Production identity and public hosting are deferred.',
  },
  servers: [
    { url: '/api/v1', description: 'Standalone Workspace API; resolve against the API origin' },
  ],
  tags: [{ name: 'Workspace' }, { name: 'Owner' }],
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
        description:
          "Eight-hour, process-local Owner session for explicit local/legacy profiles, created by that profile's verified SSO callback or POST /api/session (loopback only). HttpOnly; Secure for HTTPS; logout revokes it. Managed account and regional Guest hosts use their separate credentials below.",
      },
      accountOwner: {
        type: 'apiKey',
        in: 'cookie',
        name: 'aw_account',
        description:
          'Opaque, Workspace-bound regional Owner continuity grant issued after verified TiDB Account sign-in. Host-only, HttpOnly, SameSite=Strict and Secure on HTTPS. Browser-session cookie with no absolute server expiry; logout or regional policy denial revokes access. Existing grants survive Region restart and Global outage. Not a Workspace Key and never inferred from a Workspace URL.',
      },
      guestOwner: {
        type: 'apiKey',
        in: 'cookie',
        name: 'aw_guest',
        description:
          'Opaque regional Guest Owner session issued by POST /api/auth/guest when enabled. Host-only, HttpOnly, Secure, SameSite=Strict, Workspace-bound and subject to its absolute Guest expiry. Guest logout revokes access and schedules scoped cleanup. Never grants access to an account or another Guest Workspace.',
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
