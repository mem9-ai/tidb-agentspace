const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const map = { type: 'object', additionalProperties: integer };
export function operatorContract() {
  const counts = object({
    pageViews: integer,
    tryClicks: integer,
    signInClicks: integer,
    ready: integer,
    successes: integer,
    failures: integer,
    helpful: integer,
    votes: integer,
    events: map,
    sources: map,
    campaigns: map,
    journeys: map,
  });
  const cohort = object({
    actor: str,
    ready: integer,
    eligible: integer,
    activated: integer,
    d1Eligible: integer,
    d1Returned: integer,
    d7Eligible: integer,
    d7Returned: integer,
  });
  const summary = object({
    firstUseSources: map,
    firstUseCampaigns: map,
    authority: str,
    from: str,
    to: str,
    timezone: { const: 'UTC' },
    counts,
    sessions: integer,
    trials: integer,
    activeWorkspaces: integer,
    apiWorkspaces: integer,
    cohorts: { type: 'array', items: cohort },
    timeToValueSeconds: map,
    generatedAt: integer,
    unconfirmedEvents: integer,
    coverage: str,
  });
  const envelope = object({
    authorities: { type: 'array', items: summary },
    missingRegions: { type: 'array', items: str },
    definitionsVersion: { const: 1 },
    timezone: { const: 'UTC' },
    partial: { type: 'boolean' },
    monitoring: { const: 'not_included' },
  });
  const error = {
    description: 'Structured service error. No customer content or secrets.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'object', required: ['code'], properties: { code: str } } },
        },
      },
    },
  };
  const response = (schema) => ({
    description: 'Success',
    content: { 'application/json': { schema } },
  });
  const operation = (operationId, schema, { status = 200, anonymous = false } = {}) => ({
    operationId,
    security: anonymous ? [] : [{ operatorSession: [] }],
    responses: {
      [status]: response(schema),
      400: error,
      401: error,
      403: error,
      404: error,
      413: error,
      415: error,
      422: error,
      429: error,
      503: error,
    },
  });
  const events = [
    object(
      {
        name: { const: 'public_page_view' },
        page: { enum: ['home', 'get_started', 'sales_guide', 'api_docs', 'workspace'] },
        source: { enum: ['search', 'ai_referral', 'social', 'other', 'direct_or_unknown'] },
        device: { enum: ['mobile', 'desktop'] },
        campaign: { type: ['string', 'null'] },
      },
      ['name', 'page', 'source', 'device'],
    ),
    ...['try_clicked', 'sign_in_clicked'].map((name) =>
      object({
        name: { const: name },
        page: { enum: ['home', 'get_started', 'sales_guide', 'api_docs', 'workspace'] },
      }),
    ),
    object({ name: { const: 'journey_selected' }, journey: { enum: ['agent', 'self_service'] } }),
    object({ name: { const: 'helpful_vote' }, helpful: { type: 'boolean' } }),
  ];
  const ingest = operation(
    'ingestProductEvents',
    object({ accepted: { const: true }, durability: { const: 'queued' } }),
    {
      status: 202,
      anonymous: true,
    },
  );
  ingest.description =
    'Untrusted optional browser events only. Exact trusted Origin and application/json required; no account or Workspace authorization is established. 202 acknowledges queued acceptance by the independent analytics service, not object-storage durability. Queued writes may be lost on a crash. Retained event IDs deduplicate retries. GPC suppression returns 204.';
  ingest.requestBody = {
    required: true,
    content: {
      'application/json': {
        schema: object({
          version: { const: 1 },
          sessionId: { type: 'string', format: 'uuid' },
          events: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: object({ id: { type: 'string', format: 'uuid' }, event: { oneOf: events } }),
          },
        }),
      },
    },
  };
  ingest.responses[204] = {
    description: 'Optional collection suppressed by Global Privacy Control.',
  };
  ingest.responses[409] = error;
  const range = ['from', 'to'].map((name) => ({
    name,
    in: 'query',
    schema: { type: 'string', format: 'date' },
    description: `${name === 'from' ? 'Inclusive' : 'Exclusive'} UTC date. Maximum 31-day range, within the retained window.`,
  }));
  const read = operation('getProductInsights', envelope);
  read.parameters = range;
  const coverage = operation('getProductAnalyticsCoverage', envelope);
  coverage.parameters = range;
  return {
    openapi: '3.1.0',
    info: {
      title: 'Product analytics and Admin API',
      version: '1.0.0',
      description:
        'Separate platform authority. TiDB Cloud OIDC with a verified pingcap.com email is required for Admin. Workspace Keys and personal Owner sessions grant no access. Business actions use native outcomes; browser events are untrusted. HTTP monitoring is excluded.',
    },
    servers: [{ url: '/api/global' }],
    paths: {
      '/analytics/config': {
        get: operation(
          'getProductAnalyticsConfig',
          object({
            enabled: { type: 'boolean' },
            campaigns: { type: 'array', items: str },
            policy: { const: 'session_only' },
            version: { const: 1 },
          }),
          { anonymous: true },
        ),
      },
      '/analytics/events': { post: ingest },
      '/analytics/session': {
        post: {
          operationId: 'enableAnalyticsAttribution',
          security: [],
          responses: {
            204: {
              description:
                'Clear the server-side optional-analytics opt-out flag; exact trusted Origin required.',
            },
            403: error,
          },
        },
        delete: {
          ...operation('clearAnalyticsAttribution', {}, { anonymous: true }),
          responses: {
            204: { description: 'Pending attribution cleared. Exact trusted Origin required.' },
            403: error,
          },
        },
      },
      '/operator/session': {
        get: operation('getOperatorSession', object({ operator: { const: true } })),
      },
      '/operator/auth/login': {
        get: {
          operationId: 'beginOperatorLogin',
          security: [],
          responses: {
            303: {
              description:
                'Redirect to the existing TiDB Cloud code/PKCE login with operator mode. The existing registered callback verifies the flow before issuing a distinct Admin session. No customer Workspace is created.',
            },
          },
        },
      },
      '/operator/auth/logout': {
        post: {
          operationId: 'endOperatorSession',
          security: [{ operatorSession: [] }],
          responses: {
            204: { description: 'Revoked and cleared. Exact trusted Origin required.' },
            401: error,
            403: error,
          },
        },
      },
      '/operator/analytics/breakdowns/{kind}': {
        parameters: [
          {
            name: 'kind',
            in: 'path',
            required: true,
            schema: { enum: ['acquisition', 'funnel', 'retention', 'outcomes'] },
          },
        ],
        get: { ...read, operationId: 'getProductInsightBreakdown' },
      },
      '/operator/analytics/summary': { get: read },
      '/operator/analytics/coverage': { get: coverage },
    },
    components: {
      securitySchemes: {
        operatorSession: {
          type: 'apiKey',
          in: 'cookie',
          name: 'aw_operator',
          description:
            'Host-only Secure HttpOnly SameSite=Strict session, one-hour maximum; current private policy is checked on every read.',
        },
      },
      schemas: { ProductInsights: envelope },
    },
  };
}
