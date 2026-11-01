export function extendRegionalSecurityContract(spec) {
  const str = { type: 'string' },
    num = { type: 'integer', minimum: 1 };
  const object = (properties) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const ws = '/workspaces/{workspaceId}';
  const parameters = [{ name: 'workspaceId', in: 'path', required: true, schema: str }];
  const schemes = spec.components.securitySchemes;
  schemes.regionalAccess = {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Region JWT',
    description:
      'Audience-bound regional access. Checked against Region-local Key, grant, family, denial and policy checkpoints; never introspected at Global.',
  };
  schemes.regionalRefresh = {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description:
      'Refresh <credential>, bound to the enrolled client key and rotating nonce. Requires DPoP proof. Never sent to Global.',
  };
  for (const path of Object.values(spec.paths))
    for (const op of Object.values(path))
      if (op?.security?.some?.((entry) => 'workspaceKey' in entry))
        op.security = op.security.map((entry) =>
          'workspaceKey' in entry ? { regionalAccess: [] } : entry,
        );
  delete schemes.workspaceKey;
  delete spec.paths[ws + '/keys'];
  delete spec.paths[ws + '/keys/{keyId}'];
  Object.assign(spec.components.schemas, {
    RegionalEnrollment: object({
      keyId: str,
      familyId: str,
      refreshCredential: str,
      nonce: str,
      expiresAt: num,
    }),
    RegionalToken: object({
      id: str,
      accessToken: str,
      tokenType: { const: 'Bearer' },
      expiresAt: num,
      refreshCredential: str,
      refreshExpiresAt: num,
      nonce: str,
      familyId: str,
      keyId: str,
      scopes: { type: 'array', items: str },
    }),
    RegionalFamily: object({
      id: str,
      keyId: str,
      keyVersion: num,
      generation: num,
      securityEpoch: num,
      expiresAt: num,
      revoked: { type: 'boolean' },
    }),
    RegionalIssuance: object({
      id: str,
      keyId: str,
      familyId: str,
      principalId: str,
      expiresAt: num,
      status: { const: 'issued' },
    }),
  });
  const response = (schema) => ({
    description: 'Successful regional response',
    headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
    content: { 'application/json': { schema } },
  });
  const operation = (id, security, status, schema, extra = {}) => ({
    operationId: id,
    'x-authentication-profile': 'regional-token',
    tags: ['Region security'],
    security,
    parameters: [...parameters],
    responses: {
      [status]:
        status === 204
          ? { description: 'Durably denied and local in-flight authorization leases fenced.' }
          : response(schema),
      default: response(ref('Error')),
    },
    description:
      'Available on a Region listener configured with the regional security profile. Direct regional operation; no Global callback. Uncertain credential-producing outcomes are not automatically retried.',
    ...extra,
  });
  const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
  const proof = {
    name: 'DPoP',
    in: 'header',
    required: true,
    schema: str,
    description:
      'Ed25519 proof bound to POST, exact configured URI, server nonce, client thumbprint and fresh unique jti.',
  };
  spec.paths[ws + '/refresh-families'] = {
    post: operation('enrollRegionalRefreshFamily', [], 201, ref('RegionalEnrollment'), {
      parameters: [...parameters, proof],
      requestBody: body(object({ ticket: str })),
    }),
  };
  spec.paths[ws + '/token-issuances'] = {
    post: operation('issueRegionalToken', [{ regionalRefresh: [] }], 201, ref('RegionalToken'), {
      parameters: [...parameters, proof],
      requestBody: body(object({ keyId: str })),
    }),
  };
  const pathParameter = (name) => ({ name, in: 'path', required: true, schema: str });
  spec.paths[ws + '/refresh-families/{familyId}'] = {
    get: operation(
      'getRegionalRefreshFamily',
      [{ regionalAccess: [] }],
      200,
      object({ data: ref('RegionalFamily') }),
      { parameters: [...parameters, pathParameter('familyId')] },
    ),
    delete: operation('revokeRegionalRefreshFamily', [{ regionalAccess: [] }], 204, null, {
      parameters: [...parameters, pathParameter('familyId')],
    }),
  };
  spec.paths[ws + '/token-issuances/{issuanceId}'] = {
    get: operation(
      'getRegionalTokenIssuance',
      [{ regionalAccess: [] }],
      200,
      object({ data: ref('RegionalIssuance') }),
      { parameters: [...parameters, pathParameter('issuanceId')] },
    ),
  };
  spec.paths[ws + '/access-tokens/{tokenId}'] = {
    delete: operation('revokeRegionalAccessToken', [{ regionalAccess: [] }], 204, null, {
      parameters: [...parameters, pathParameter('tokenId')],
      description:
        'Locally deny the authenticated access token itself until its original expiry. An arbitrary ID is not authorization.',
    }),
  };
}
