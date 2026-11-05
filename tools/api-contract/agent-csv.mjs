export function addAgentCsv(spec) {
  const string = { type: 'string' };
  const object = (properties) => ({
    type: 'object',
    required: Object.keys(properties),
    properties,
  });
  const json = (schema) => ({ 'application/json': { schema } });
  const base = '/agent-csv/workspaces';
  const file = base + '/{workspaceId}/sources/{resourceId}';
  const params = ['workspaceId', 'resourceId'].map((name) => ({
    in: 'path',
    name,
    required: true,
    schema: string,
  }));
  const operation = (operationId, description, content, extra = {}) => ({
    operationId,
    description,
    tags: ['Private CSV workspace'],
    security: [{ csvWorkspace: [] }],
    ...extra,
    responses: {
      200: { description: 'Success', content },
      default: {
        description: 'Rejected or unavailable',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
    },
  });
  spec.components.securitySchemes.csvWorkspace = {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description:
      'CsvWorkspace followed by a space and 32 cryptographically random bytes encoded in hex. Generate once per project in the OS credential store. Use HTTPS; omit Cookie and Origin.',
  };
  spec.paths[base] = {
    post: operation(
      'openPrivateCsvWorkspace',
      'Enroll or recover the same private 24-hour Guest workspace and its default File System using the same project capability. Send an empty body. Resume known files using the source endpoints.',
      json(
        object({
          workspaceId: { type: 'string', format: 'uuid' },
          resourceId: string,
          expiresAt: { type: 'integer', description: 'Original expiry in Unix seconds' },
        }),
      ),
    ),
  };
  const established = spec.paths['/workspaces/{workspaceId}/files/metadata'].get.responses[200];
  spec.paths[file + '/metadata'] = {
    parameters: params,
    get: {
      ...operation(
        'getPrivateCsvVersion',
        'Read the current source version. Missing source returns 404.',
        established.content,
      ),
      responses: {
        200: established,
        default: {
          description: 'Rejected or unavailable',
          content: json({ $ref: '#/components/schemas/Error' }),
        },
      },
    },
  };
  spec.paths[file + '/content'] = {
    parameters: params,
    get: operation(
      'downloadPrivateCsv',
      'Read the private source from its original workspace without a local file or a new signup.',
      { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    ),
    put: operation(
      'uploadPrivateCsv',
      'Write one nonempty UTF-8 CSV of up to 1048576 bytes. Supply exactly one of If-None-Match: * (new) or If-Match (explicit replacement). A stale precondition cannot overwrite the source.',
      json(object({ saved: { type: 'boolean' }, size: { type: 'integer' } })),
      {
        parameters: ['If-Match', 'If-None-Match'].map((name) => ({
          in: 'header',
          name,
          schema: string,
        })),
        requestBody: { required: true, content: { 'text/csv': { schema: string } } },
      },
    ),
  };
}
