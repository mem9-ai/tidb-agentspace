export interface paths {
  '/api/v1/workspaces/{workspaceId}/key-policy-deliveries': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Explicit bounded application attempt for the current Key version, including revoked Keys. Replays reconcile the same immutable command. No background retry or data proxy is implied. */
    post: operations['createGlobalKeyPolicyDelivery'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/key-policy-deliveries/{deliveryId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Observe durable application evidence without contacting Region or retrying effects. */
    get: operations['getGlobalKeyPolicyDelivery'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/keys': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listGlobalKeys'];
    put?: never;
    /** @description Owner only. Unix-second expiry. Store the returned secret securely; it cannot be retrieved or returned again. */
    post: operations['createGlobalKey'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/keys/{keyId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalKey'];
    put?: never;
    post?: never;
    delete: operations['revokeGlobalKey'];
    options?: never;
    head?: never;
    /** @description Extends expiry while retaining the Key secret, advances Key version and invalidates old Global Tokens. Regional application is reported separately. Only an explicit same-secret renewal durably observed by both authorities before the previous expiry enables existing proof-bound families to cross versions. An unreachable Region remains pending; unavailable continuity requires fresh enrollment. */
    patch: operations['renewGlobalKey'];
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/keys/{keyId}/versions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['rotateGlobalKey'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/keys/{keyId}/versions/{version}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalKeyVersion'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/key-revocations/{revocationId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalKeyRevocation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/token-issuances': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Exchange the Workspace Key at Global only. Region audience requests require an Ed25519 client JWK thumbprint and matching applied regional policy. The response includes a client-bound enrollment ticket for direct regional refresh enrollment. */
    post: operations['createGlobalTokenIssuance'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/token-issuances/{issuanceId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalTokenIssuance'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/regions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Requires resources:read on a current Global Token. Only the Key-granted Region is returned. Data requests go directly to Region. */
    get: operations['listAuthorizedRegions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/health': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalHealth'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/tidbcloud/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['startGlobalOwnerLogin'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/tidbcloud/callback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Verified one-use OIDC+PKCE callback. Requires the browser-bound flow cookie; issues an eight-hour, durable, host-only HttpOnly Owner cookie after checking Global Directory membership. */
    get: operations['completeGlobalOwnerLogin'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/tidbcloud/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['revokeGlobalOwnerSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    Error: {
      error: {
        code: string;
        message: string;
        requestId: string;
      };
    };
    Key: {
      workspaceId: string;
      /** Format: uuid */
      keyId: string;
      principalId: string;
      keyVersion: number;
      grantRef: string;
      expiresAt: number;
      revoked: boolean;
    };
    Grants: {
      scopes: string[];
      resourceIds: string[];
      regionId: string;
    };
    Region: {
      regionId: string;
      /** Format: uri */
      apiOrigin: string;
      apiPathPrefix: string;
    };
    Issuance: {
      id: string;
      keyId: string;
      principalId: string;
      expiresAt: number;
      audience: string;
      /** @constant */
      status: 'issued';
    };
    Token: {
      id: string;
      accessToken: string;
      /** @constant */
      tokenType: 'Bearer';
      expiresAt: number;
      scopes: string[];
    };
    RegionToken: {
      id: string;
      accessToken: string;
      /** @constant */
      tokenType: 'Bearer';
      expiresAt: number;
      scopes: string[];
      keyId: string;
      principalId: string;
      keyVersion: number;
      region: components['schemas']['Region'];
      enrollmentTicket: string;
      enrollmentExpiresAt: number;
      nonce: string;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  createGlobalKeyPolicyDelivery: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Must equal the configured Global public origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          keyId: string;
          keyVersion: number;
        };
      };
    };
    responses: {
      /** @description Successful response */
      201: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: {
              id: string;
              keyId: string;
              keyVersion: number;
              /** @enum {unknown} */
              regionalStatus: 'pending' | 'applied';
              /** @enum {unknown} */
              regionalContinuity: 'pending' | 'eligible' | 'unavailable';
            };
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getGlobalKeyPolicyDelivery: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        deliveryId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: {
              id: string;
              keyId: string;
              keyVersion: number;
              /** @enum {unknown} */
              regionalStatus: 'pending' | 'applied';
              /** @enum {unknown} */
              regionalContinuity: 'pending' | 'eligible' | 'unavailable';
            };
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listGlobalKeys: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'][];
            nextCursor: string | null;
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  createGlobalKey: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Must equal the configured Global public origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          scopes: string[];
          resourceIds: string[];
          expiresAt: number;
        };
      };
    };
    responses: {
      /** @description Successful response */
      201: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'];
            secret: string;
            grants: components['schemas']['Grants'];
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getGlobalKey: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        keyId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'];
            grants: components['schemas']['Grants'];
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  revokeGlobalKey: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Quoted current Key version ETag. */
        'If-Match': string;
        /** @description Must equal the configured Global public origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
        keyId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      202: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  renewGlobalKey: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Quoted current Key version ETag. */
        'If-Match': string;
        /** @description Must equal the configured Global public origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
        keyId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          expiresAt: number;
        };
      };
    };
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'];
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
            /** @enum {unknown} */
            regionalContinuity: 'pending' | 'eligible' | 'unavailable';
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  rotateGlobalKey: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Quoted current Key version ETag. */
        'If-Match': string;
        /** @description Must equal the configured Global public origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
        keyId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      201: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'];
            secret: string;
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getGlobalKeyVersion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        keyId: string;
        version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'];
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getGlobalKeyRevocation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        revocationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: {
              id: string;
              keyId: string;
              keyVersion: number;
              /** @enum {unknown} */
              regionalStatus: 'pending' | 'applied';
            };
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  createGlobalTokenIssuance: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          audience: string;
          scopes?: string[];
          clientThumbprint?: string;
        };
      };
    };
    responses: {
      /** @description Successful response */
      201: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Token'] | components['schemas']['RegionToken'];
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getGlobalTokenIssuance: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        issuanceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Issuance'];
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listAuthorizedRegions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Region'][];
            nextCursor: null;
          };
        };
      };
      /** @description Structured denial or unknown outcome; no credential is echoed. */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getGlobalHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @constant */
            status: 'ok';
            /** @constant */
            authority: 'global';
          };
        };
      };
      /** @description Successful response */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  startGlobalOwnerLogin: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to the trusted configured identity provider; opaque host-only flow cookie. */
      303: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Successful response */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  completeGlobalOwnerLogin: {
    parameters: {
      query: {
        code: string;
        state: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            workspaceId: string;
            regionId: string;
            expiresAt: number;
          };
        };
      };
      /** @description Successful response */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  revokeGlobalOwnerSession: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header: {
        /** @description Must equal the configured Global public origin for Owner mutations. */
        Origin: string;
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Durably revoked the Global Owner session and cleared the host-only cookie. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Successful response */
      default: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
}
