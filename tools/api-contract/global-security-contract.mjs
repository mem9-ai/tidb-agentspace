// Public Global authority only. Region data paths remain in the independent regional contract.
export function globalSecurityContract() {
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const string = { type: 'string' };
  const number = { type: 'integer', minimum: 1 };
  const array = { type: 'array', items: string };
  const object = (properties, required = Object.keys(properties)) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  });
  const schemas = {
    Error: object({ error: object({ code: string, message: string, requestId: string }) }),
    Key: object({
      name: { type: 'string', minLength: 1, maxLength: 80 },
      createdAt: { type: 'integer', minimum: 0 },
      workspaceId: string,
      keyId: { type: 'string', format: 'uuid' },
      principalId: string,
      keyVersion: number,
      grantRef: string,
      expiresAt: number,
      revoked: { type: 'boolean' },
    }),
    Grants: object({
      scopes: { ...array, minItems: 1, maxItems: 8 },
      resourceIds: { ...array, minItems: 1, maxItems: 1024 },
      regionId: string,
    }),
    Region: object({
      regionId: string,
      apiOrigin: { type: 'string', format: 'uri' },
      apiPathPrefix: string,
    }),
    Issuance: object({
      id: string,
      keyId: string,
      principalId: string,
      expiresAt: number,
      audience: string,
      status: { const: 'issued' },
    }),
    Token: object({
      id: string,
      accessToken: string,
      tokenType: { const: 'Bearer' },
      expiresAt: number,
      scopes: array,
    }),
  };
  schemas.RegionToken = object({
    id: string,
    accessToken: string,
    tokenType: { const: 'Bearer' },
    expiresAt: number,
    scopes: array,
    keyId: string,
    principalId: string,
    keyVersion: number,
    region: ref('Region'),
    enrollmentTicket: string,
    enrollmentExpiresAt: number,
    nonce: string,
  });
  schemas.RegionAccessToken = object(
    Object.fromEntries(
      Object.entries(schemas.RegionToken.properties).filter(
        ([key]) => !['enrollmentTicket', 'enrollmentExpiresAt', 'nonce'].includes(key),
      ),
    ),
  );
  const response = (schema, description = 'Successful response') => ({
    description,
    headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
    content: { 'application/json': { schema } },
  });
  const workspace = {
    name: 'workspaceId',
    in: 'path',
    required: true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' },
  };
  const mutation = {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description:
      'Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat.',
  };
  const condition = {
    name: 'If-Match',
    in: 'header',
    required: true,
    schema: string,
    description: 'Quoted current Key version ETag.',
  };
  const origin = {
    name: 'Origin',
    in: 'header',
    required: true,
    schema: { type: 'string', format: 'uri' },
    description:
      'Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations.',
  };
  const parameter = (name) => ({ name, in: 'path', required: true, schema: string });
  const request = (schema) => ({ required: true, content: { 'application/json': { schema } } });
  const owner = [{ globalOwner: [] }];
  const token = [{ globalAccess: [] }];
  const key = [{ workspaceKey: [] }];
  const paths = {};
  const add = (path, method, id, security, status, schema, extra = {}) => {
    paths[path] ??= {};
    paths[path][method] = {
      operationId: id,
      summary: id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase()),
      security,
      parameters: [workspace],
      responses: {
        [status]: response(schema),
        default: response(
          ref('Error'),
          'Structured denial or unknown outcome; no credential is echoed.',
        ),
      },
      ...extra,
    };
  };
  const delivery = object({
    data: object({
      id: string,
      keyId: string,
      keyVersion: number,
      regionalStatus: { enum: ['pending', 'applied'] },
      regionalContinuity: { enum: ['pending', 'eligible', 'unavailable'] },
    }),
  });
  add('/key-policy-deliveries', 'post', 'createGlobalKeyPolicyDelivery', owner, 201, delivery, {
    parameters: [workspace, mutation, origin],
    requestBody: request(object({ keyId: string, keyVersion: number })),
    description:
      'Explicit bounded application attempt for the current Key version, including revoked Keys. Replays reconcile the same immutable command. No background retry or data proxy is implied.',
  });
  add(
    '/key-policy-deliveries/{deliveryId}',
    'get',
    'getGlobalKeyPolicyDelivery',
    owner,
    200,
    delivery,
    {
      parameters: [workspace, parameter('deliveryId')],
      description:
        'Observe durable application evidence without contacting Region or retrying effects.',
    },
  );
  const keyData = object({
    data: ref('Key'),
    grants: ref('Grants'),
    regionalStatus: { enum: ['pending', 'applied'] },
  });
  add(
    '/keys',
    'get',
    'listGlobalKeys',
    owner,
    200,
    object({
      data: { type: 'array', items: keyData },
      nextCursor: { type: ['string', 'null'] },
    }),
    {
      parameters: [
        workspace,
        { name: 'cursor', in: 'query', schema: string },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      ],
    },
  );
  add(
    '/keys',
    'post',
    'createGlobalKey',
    owner,
    201,
    object({
      data: ref('Key'),
      secret: string,
      grants: ref('Grants'),
      regionalStatus: { enum: ['pending', 'applied'] },
    }),
    {
      parameters: [workspace, mutation, origin],
      requestBody: request(
        object(
          {
            name: { type: 'string', minLength: 1, maxLength: 80, default: 'Agent key' },
            scopes: { ...array, minItems: 1, maxItems: 8 },
            resourceIds: { ...array, minItems: 1, maxItems: 1024 },
            expiresAt: number,
          },
          ['scopes', 'resourceIds', 'expiresAt'],
        ),
      ),
      description:
        'Owner only. Unix-second expiry. Store the returned secret securely; it cannot be retrieved or returned again.',
    },
  );
  add('/keys/{keyId}', 'get', 'getGlobalKey', owner, 200, keyData, {
    parameters: [workspace, parameter('keyId')],
  });
  add(
    '/keys/{keyId}',
    'patch',
    'renewGlobalKey',
    owner,
    200,
    object({
      data: ref('Key'),
      regionalStatus: { enum: ['pending', 'applied'] },
      regionalContinuity: { enum: ['pending', 'eligible', 'unavailable'] },
    }),
    {
      parameters: [workspace, parameter('keyId'), mutation, condition, origin],
      requestBody: request(object({ expiresAt: number })),
      description:
        'Extends expiry while retaining the Key secret, advances Key version and invalidates old Global Tokens. Regional application is reported separately. Only an explicit same-secret renewal durably observed by both authorities before the previous expiry enables existing proof-bound families to cross versions. An unreachable Region remains pending; unavailable continuity requires fresh enrollment.',
    },
  );
  add(
    '/keys/{keyId}',
    'delete',
    'revokeGlobalKey',
    owner,
    202,
    object({ id: string, regionalStatus: { enum: ['pending', 'applied'] } }),
    { parameters: [workspace, parameter('keyId'), mutation, condition, origin] },
  );
  add(
    '/keys/{keyId}/versions',
    'post',
    'rotateGlobalKey',
    owner,
    201,
    object({ data: ref('Key'), secret: string, regionalStatus: { enum: ['pending', 'applied'] } }),
    { parameters: [workspace, parameter('keyId'), mutation, condition, origin] },
  );
  add(
    '/keys/{keyId}/versions/{version}',
    'get',
    'getGlobalKeyVersion',
    owner,
    200,
    object({ data: ref('Key') }),
    { parameters: [workspace, parameter('keyId'), parameter('version')] },
  );
  add(
    '/key-revocations/{revocationId}',
    'get',
    'getGlobalKeyRevocation',
    owner,
    200,
    object({
      data: object({
        id: string,
        keyId: string,
        keyVersion: number,
        regionalStatus: { enum: ['pending', 'applied'] },
      }),
    }),
    { parameters: [workspace, parameter('revocationId')] },
  );
  add(
    '/token-issuances',
    'post',
    'createGlobalTokenIssuance',
    key,
    201,
    { oneOf: [ref('Token'), ref('RegionAccessToken'), ref('RegionToken')] },
    {
      requestBody: request(
        object({ audience: string, scopes: array, clientThumbprint: string }, ['audience']),
      ),
      description:
        'Exchange the Workspace Key at Global only. Region audience requests require matching applied regional policy. Without clientThumbprint the response is a short-lived Region access Token. With an Ed25519 client JWK thumbprint it also includes a client-bound enrollment ticket for direct regional refresh enrollment.',
    },
  );
  add(
    '/token-issuances/{issuanceId}',
    'get',
    'getGlobalTokenIssuance',
    token,
    200,
    object({ data: ref('Issuance') }),
    { parameters: [workspace, parameter('issuanceId')] },
  );
  add(
    '/regions',
    'get',
    'listAuthorizedRegions',
    token,
    200,
    object({ data: { type: 'array', items: ref('Region') }, nextCursor: { type: 'null' } }),
    {
      description:
        'Requires resources:read on a current Global Token. Only the Key-granted Region is returned. Data requests go directly to Region.',
    },
  );
  const base = '/api/v1/workspaces/{workspaceId}';
  const mounted = Object.fromEntries(
    Object.entries(paths).map(([path, value]) => [base + path, value]),
  );
  mounted['/api/health'] = {
    get: {
      operationId: 'getGlobalHealth',
      security: [],
      responses: {
        200: response(object({ status: { const: 'ok' }, authority: { const: 'global' } })),
        default: response(ref('Error')),
      },
    },
  };
  mounted['/api/auth/config'] = {
    get: {
      operationId: 'getGlobalAuthConfig',
      security: [],
      responses: {
        200: response(
          object({
            mode: { enum: ['local', 'oidc'] },
            loginPath: string,
            localSessionPath: string,
          }),
        ),
        default: response(ref('Error')),
      },
    },
  };
  mounted['/api/auth/session'] = {
    get: {
      operationId: 'getGlobalOwnerSession',
      security: owner,
      parameters: [{ name: 'workspaceId', in: 'query', required: true, schema: string }],
      responses: {
        200: response(object({ workspaceId: string, regionId: string })),
        default: response(ref('Error')),
      },
    },
  };
  mounted['/api/session'] = {
    post: {
      operationId: 'createLocalGlobalOwnerSession',
      security: [],
      description:
        'Explicit development profile only, real loopback peer and trusted Origin required. Unavailable in hosted deployments.',
      parameters: [origin],
      responses: {
        201: response(object({ workspaceId: string, regionId: string })),
        default: response(ref('Error')),
      },
    },
  };
  mounted['/api/auth/tidbcloud/login'] = {
    get: {
      operationId: 'startGlobalOwnerLogin',
      security: [],
      parameters: [
        { name: 'workspaceId', in: 'query', required: true, schema: string },
        {
          name: 'returnTo',
          in: 'query',
          schema: { type: 'string', format: 'uri' },
          description: 'Optional return URL on an explicitly trusted Console origin.',
        },
      ],
      responses: {
        303: {
          description:
            'Redirect to the trusted configured identity provider; opaque host-only flow cookie.',
        },
        default: response(ref('Error')),
      },
    },
  };
  mounted['/api/auth/tidbcloud/callback'] = {
    get: {
      operationId: 'completeGlobalOwnerLogin',
      security: [],
      parameters: ['code', 'state'].map((name) => ({
        name,
        in: 'query',
        required: true,
        schema: string,
      })),
      responses: {
        200: response(object({ workspaceId: string, regionId: string, expiresAt: number })),
        303: { description: 'Owner cookie issued; redirect to the validated Console return URL.' },
        default: response(ref('Error')),
      },
      description:
        'Verified one-use OIDC+PKCE callback. Requires the browser-bound flow cookie; issues an eight-hour, durable, host-only HttpOnly Owner cookie after checking Global Directory membership.',
    },
  };
  mounted['/api/auth/tidbcloud/logout'] = {
    post: {
      operationId: 'revokeGlobalOwnerSession',
      security: owner,
      parameters: [{ name: 'workspaceId', in: 'query', required: true, schema: string }, origin],
      responses: {
        204: {
          description: 'Durably revoked the Global Owner session and cleared the host-only cookie.',
        },
        default: response(ref('Error')),
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Workspace Global Public API',
      version: '0.1.0',
      description:
        'Independent Global management authority. Key and Global Token issuance are available. Regional data and refresh endpoints are served by Region directly. All expiry values use Unix seconds. Credentials must never be logged or stored in URLs.',
    },
    servers: [{ url: '/' }],
    paths: mounted,
    components: {
      schemas,
      securitySchemes: {
        globalOwner: { type: 'apiKey', in: 'cookie', name: 'aw_global_owner' },
        globalAccess: { type: 'http', scheme: 'bearer', bearerFormat: 'Global JWT' },
        workspaceKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Workspace Key is sent only to Global token issuance, never forwarded to Region.',
        },
      },
    },
  };
}
