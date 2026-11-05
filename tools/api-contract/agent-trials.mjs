/** Dedicated regional trial credentials never grant access to Workspace resources. */
export function addAgentTrials(spec) {
  const string = { type: 'string' };
  const timestamp = { type: 'integer', description: 'Unix seconds' };
  const object = (properties) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  const content = (schema) => ({ 'application/json': { schema } });
  const report = object({
    id: { type: 'string', format: 'uuid' },
    sample: { const: 'us-sales-v1' },
    stateSales: { type: ['object', 'null'], additionalProperties: { type: 'integer' } },
    leadingStateProducts: { type: ['object', 'null'], additionalProperties: { type: 'integer' } },
    expiresAt: timestamp,
    revision: { type: 'integer', minimum: 0, maximum: 2 },
  });
  const op = (operationId, schema, opts = {}) => ({
    operationId,
    security: [],
    ...opts,
    responses: {
      200: { description: 'Success', content: content(schema) },
      default: {
        description: 'Request rejected',
        content: content({ $ref: '#/components/schemas/Error' }),
      },
    },
  });
  const body = (schema) => ({ required: true, content: content(schema) });
  const security = [{ trialSession: [] }];
  spec.components.securitySchemes.trialSession = {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: 'Trial <session token>, usable only for the originating public-sample report.',
  };
  spec.components.securitySchemes.trialReportView = {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description:
      'TrialView v1.<publicKey>.<reportId>.<expiresAt>.<signature>. Sign the LF-separated UTF-8 lines drive9/trial/report-view/v1, canonical UUID, and original decimal Unix expiry with the project Ed25519 key. Key and signature use unpadded base64url.',
  };
  const routes = {
    'report-view': {
      get: op('getAgentTrialReportView', report, {
        security: [{ trialReportView: [] }],
        description:
          'Read the latest saved revision. Grant is valid for one report until its original 48-hour deadline (410 when expired). Cookies and query parameters are rejected. Reading never enrolls, renews, or changes a trial.',
      }),
    },
    challenges: {
      post: op('createAgentTrialChallenge', object({ challenge: string, expiresAt: timestamp })),
    },
    sessions: {
      post: op('createAgentTrialSession', object({ token: string, report }), {
        description:
          'Sign the UTF-8 text drive9/trial/v1, challenge, and start (enroll=true) or resume, joined by LF, with the project Ed25519 key. Keys and signatures use unpadded base64url. Challenges expire after 60 seconds. Sessions expire within five minutes; trial lifetime is 48 hours.',
        requestBody: body(
          object({
            publicKey: string,
            challenge: string,
            signature: string,
            enroll: { type: 'boolean' },
          }),
        ),
      }),
    },
    report: {
      get: op('getAgentTrialReport', report, { security }),
      put: op('updateAgentTrialReport', report, {
        security,
        description:
          'The report is the immutable us-sales-v1 sample plus the selected analyses. Revision 0 is empty, 1 contains state totals, and 2 also contains the top product for the leading state. Append in order. Read back after unknown outcomes.',
        parameters: [
          {
            in: 'header',
            name: 'If-Match',
            required: true,
            schema: { enum: ['"0"', '"1"', '"2"'] },
          },
        ],
        requestBody: body(object({ section: { enum: ['states', 'products'] } })),
      }),
    },
    'us-sales-v1.csv': {
      get: {
        operationId: 'downloadAgentTrialSample',
        security: [],
        responses: {
          200: {
            description: 'Immutable public US sales fixture',
            content: { 'text/csv': { schema: string } },
          },
          default: {
            description: 'Unavailable',
            content: content({ $ref: '#/components/schemas/Error' }),
          },
        },
      },
    },
  };
  for (const [route, operations] of Object.entries(routes))
    spec.paths['/agent-trial/' + route] = operations;
}
