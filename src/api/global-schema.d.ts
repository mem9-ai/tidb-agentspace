export interface paths {
  '/.well-known/raft-agent-manifest.json': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Public v0 manifest for five actions
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftManifest'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/config': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalAuthConfig'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getGlobalOwnerSession'];
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
    /** @description For independently configured Global OIDC only: verified one-use PKCE callback with browser-bound state and Global Directory membership. Bundled Portal deployments use their existing Portal callback instead and do not register or enable this second callback. */
    get: operations['completeGlobalOwnerLogin'];
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
    /** @description Bundled hosted deployments redirect to the existing Portal login; its single verified callback establishes both separate sessions. Independently configured Global OIDC deployments begin their own registered flow. */
    get: operations['startGlobalOwnerLogin'];
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
  '/api/portal/v1/workspaces/{workspaceId}/key-policy-deliveries': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Global Key Policy Delivery
     * @description Explicit bounded application attempt for the current Key version, including revoked Keys. Replays reconcile the same immutable command. The Region connection profile also reconciles durable pending changes after reconnection.
     */
    post: operations['createGlobalKeyPolicyDelivery'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/key-policy-deliveries/{deliveryId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Global Key Policy Delivery
     * @description Observe durable application evidence without contacting Region or retrying effects.
     */
    get: operations['getGlobalKeyPolicyDelivery'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/key-revocations/{revocationId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Global Key Revocation */
    get: operations['getGlobalKeyRevocation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/keys': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List Global Keys */
    get: operations['listGlobalKeys'];
    put?: never;
    /**
     * Create Global Key
     * @description Owner only. Pass expiresInDays (1, 2, 7, 30 or 90) and the server computes the expiry; the deprecated absolute expiresAt is accepted only inside the same 90-day ceiling. Store the returned secret securely; it cannot be retrieved or returned again.
     */
    post: operations['createGlobalKey'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Global Key */
    get: operations['getGlobalKey'];
    put?: never;
    post?: never;
    /** Revoke Global Key */
    delete: operations['revokeGlobalKey'];
    options?: never;
    head?: never;
    /**
     * Renew Global Key
     * @description Extends expiry while retaining the Key secret, advances Key version and invalidates old Global Tokens. Regional application is reported separately. Only an explicit same-secret renewal durably observed by both authorities before the previous expiry enables existing proof-bound families to cross versions. An unreachable Region remains pending; unavailable continuity requires fresh enrollment.
     */
    patch: operations['renewGlobalKey'];
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}/versions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Rotate Global Key */
    post: operations['rotateGlobalKey'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/keys/{keyId}/versions/{version}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Global Key Version */
    get: operations['getGlobalKeyVersion'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/portal/v1/workspaces/{workspaceId}/regional-session-tickets': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Portal Region Session Ticket
     * @description Create a short-lived one-use user-session exchange ticket for the Workspace Region. A verified Portal Owner session is required.
     */
    post: operations['createPortalRegionSessionTicket'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/actions/context': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Inspect current identity and own Workspaces
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftContext'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/actions/list-resources': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Discover only currently authorized resources
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftListResources'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/actions/query': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Submit SQL with a retained request UUID; never retry uncertain writes with a new ID
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftQuery'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/actions/query-status': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Observe an existing own request without repeating SQL
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftQueryStatus'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/actions/read-file': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read at most 128 KiB of UTF-8 content
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftReadFile'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/config': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Discover public Raft sign-in and Region choices
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftConfig'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List current own Workspaces
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftWorkspaces'];
    put?: never;
    /**
     * Explicitly create an empty federated Workspace
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftCreateWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    /**
     * Read current membership and Workspace policy generation for a Human review
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftWorkspace'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/audit-events': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    /**
     * Human governor reads durable security history in chronological pages
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftAuditEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/enrollments': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    /**
     * Human governor reads admission requests
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftEnrollments'];
    put?: never;
    /**
     * Request admission without data or creation rights
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftRequestEnrollment'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/enrollments/self': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    /**
     * Inspect own pending, approved or denied enrollment
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftOwnEnrollment'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/enrollments/{principalId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        principalId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /**
     * Human governor approves or denies one enrollment
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    patch: operations['raftDecideEnrollment'];
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/invitations': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Human admits a verified identity with no resource or creation rights
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftInvite'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/invitations/{requestId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        requestId: string;
      };
      cookie?: never;
    };
    /**
     * Read original admission outcome; a removed member is never reactivated by retry
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftInvitation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/members/{principalId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        principalId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Remove membership without deleting data; never remove last Human owner
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    delete: operations['raftRemoveMember'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/principals/{principalId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        principalId: string;
      };
      cookie?: never;
    };
    /**
     * Human governor reviews one exact previously verified identity in this Server
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftAdmissionCandidate'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/resources': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    /**
     * Human governor lists resource metadata for sharing
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftGovernanceResources'];
    put?: never;
    /**
     * Human governor explicitly creates a native resource
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftCreateResource'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/resources/share-batches': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Freeze exact reviewed resources before sharing; partial edges are explicit and retries retain the same request ID
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftShareBatch'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/resources/{resourceId}/files': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read an authorized text file
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftGetFile'];
    /**
     * Create-only text write, or replace with the exact current revision; 64 KiB limit
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    put: operations['raftWriteFile'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/resources/{resourceId}/grants': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        resourceId: string;
      };
      cookie?: never;
    };
    /**
     * Human governor inspects exact resource grants
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    get: operations['raftResourceGrants'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/resources/{resourceId}/grants/{grantId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        resourceId: string;
        grantId: string;
      };
      cookie?: never;
    };
    get?: never;
    /**
     * Human governor shares one exact resource or irrevocably revokes a grant ID
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    put: operations['raftPutGrant'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/raft/workspaces/{workspaceId}/resources/{resourceId}/tags': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /**
     * Replace organizational tags with tags:write and current version
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    put: operations['raftSetTags'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Explicit development profile only, real loopback peer and trusted Origin required. Unavailable in hosted deployments. */
    post: operations['createLocalGlobalOwnerSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/token-issuances': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Exchange a Workspace Key without configuring a Workspace or Region
     * @description The Key identifies its Workspace. Use audience global or region; region selects the Key-granted Region. Legacy Keys without a Workspace hint continue to use the Workspace-scoped issuance endpoint. Never forward the Workspace Key to a Region.
     */
    post: operations['createDiscoveredTokenIssuance'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspaceId}/region-route': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Discover the Region through a bodyless redirect
     * @description Send only a Global access Token. Inspect the redirect without automatic credential forwarding; validate the HTTPS target against authenticated Global discovery before using the Region Token. Do not send SQL or file content to this endpoint.
     */
    get: operations['getGlobalRegionRoute'];
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
    /**
     * List Authorized Regions
     * @description Requires resources:read on a current Global Token. Only the Key-granted Region is returned. Data requests go directly to Region.
     */
    get: operations['listAuthorizedRegions'];
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
    /**
     * Create Global Token Issuance
     * @description Exchange the Workspace Key at Global only. Region audience requests require matching applied regional policy. Without clientThumbprint the response is a short-lived Region access Token. With an Ed25519 client JWK thumbprint it also includes a client-bound enrollment ticket for direct regional refresh enrollment.
     */
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
    /** Get Global Token Issuance */
    get: operations['getGlobalTokenIssuance'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/raft/callback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Redeem a Human or no-state Agent code at one registered callback */
    get: operations['raftCallback'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/raft/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Start Human OIDC with one-use state, nonce and S256 PKCE */
    get: operations['raftLogin'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/raft/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Durably revoke this session
     * @description Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.
     */
    post: operations['raftLogout'];
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
    DiscoveredRegionAccessToken: {
      accessToken: string;
      expiresAt: number;
      id: string;
      keyId: string;
      keyVersion: number;
      principalId: string;
      region: components['schemas']['Region'];
      scopes: string[];
      /** @constant */
      tokenType: 'Bearer';
      workspaceId: string;
    };
    DiscoveredRegionToken: {
      accessToken: string;
      enrollmentExpiresAt: number;
      enrollmentTicket: string;
      expiresAt: number;
      id: string;
      keyId: string;
      keyVersion: number;
      nonce: string;
      principalId: string;
      region: components['schemas']['Region'];
      scopes: string[];
      /** @constant */
      tokenType: 'Bearer';
      workspaceId: string;
    };
    DiscoveredToken: {
      accessToken: string;
      expiresAt: number;
      id: string;
      scopes: string[];
      /** @constant */
      tokenType: 'Bearer';
      workspaceId: string;
    };
    Error: {
      error: {
        code: string;
        message: string;
        requestId: string;
      };
    };
    Grants: {
      regionId: string;
      resourceIds: string[];
      /** @description Selected types include current and future public resources in this Workspace. */
      resourceTypes?: ('database' | 'filesystem')[];
      scopes: string[];
    };
    Issuance: {
      audience: string;
      expiresAt: number;
      id: string;
      keyId: string;
      principalId: string;
      /** @constant */
      status: 'issued';
    };
    Key: {
      createdAt: number;
      expiresAt: number;
      grantRef: string;
      /** Format: uuid */
      keyId: string;
      keyVersion: number;
      name: string;
      principalId: string;
      revoked: boolean;
      workspaceId: string;
    };
    RaftAuditEvent: {
      action: string;
      actor: {
        id: string;
        /** @enum {unknown} */
        kind: 'human' | 'agent';
        serverId: string;
      };
      at: string;
      details: Record<string, never>;
      id: string;
      /** @enum {unknown} */
      outcome: 'recorded' | 'denied' | 'uncertain';
    };
    RaftCatalog: {
      capabilities: {
        filesystem: {
          provider: string;
          regions: string[];
        };
        postgresql: {
          available: boolean;
          provider: string;
          regions: string[];
        };
      };
      data: components['schemas']['RaftResource'][];
      nextCursor: string | null;
    };
    RaftContext: {
      actor: {
        id: string;
        /** @enum {unknown} */
        kind: 'human' | 'agent';
        serverId: string;
      };
      enrollmentRequired: boolean;
      expiresAt: number;
      nextCursor: string | null;
      /** @description Null until list-resources has checked resource readiness. */
      resourceReady: boolean | null;
      workspaces: components['schemas']['RaftWorkspace'][];
    };
    RaftEnrollment: {
      principal: components['schemas']['RaftPrincipal'];
      /** @enum {unknown} */
      status: 'pending' | 'approved' | 'denied' | 'removed';
    };
    RaftFile: {
      content: string;
      /** @constant */
      encoding: 'utf8';
      revision?: string;
      size: number;
    };
    RaftGrant: {
      actions: (
        | 'resources:read'
        | 'files:read'
        | 'files:write'
        | 'queries:read'
        | 'queries:execute'
        | 'tags:write'
      )[];
      expiresAt?: number;
      id: string;
      principalId: string;
      resourceId: string;
      revoked: boolean;
    };
    RaftGrantInput: {
      actions: (
        | 'resources:read'
        | 'files:read'
        | 'files:write'
        | 'queries:read'
        | 'queries:execute'
        | 'tags:write'
      )[];
      expiresAt?: number;
      principalId: string;
      revoked?: boolean;
    };
    RaftPrincipal: {
      id: string;
      identity: {
        /** @enum {unknown} */
        kind: 'human' | 'agent';
        provider: string;
        serverId: string;
        subject: string;
      };
    };
    RaftQuery: {
      errorCode: string | null;
      operationId: string;
      requestId: string;
      result: Record<string, never> | null;
      /** @enum {unknown} */
      status: 'running' | 'succeeded' | 'failed' | 'outcomeUnknown';
    };
    RaftQueryInput: {
      /** Format: uuid */
      requestId: string;
      resourceId: string;
      sql: string;
      workspaceId: string;
    };
    RaftResource: {
      allowedActions: string[];
      createdBy?: string;
      id: string;
      /** @enum {unknown} */
      kind: 'filesystem' | 'postgresql';
      name: string;
      provider: string;
      region: string;
      status: string;
      tags?: components['schemas']['RaftTags'];
    };
    RaftShareBatch: {
      requestId: string;
      results: {
        errorCode?: string;
        grant?: components['schemas']['RaftGrant'];
        resourceId: string;
        /** @enum {unknown} */
        status: 'applied' | 'pending' | 'failed';
      }[];
    };
    RaftShareBatchInput: {
      actions: (
        | 'resources:read'
        | 'files:read'
        | 'files:write'
        | 'queries:read'
        | 'queries:execute'
        | 'tags:write'
      )[];
      expiresAt: number;
      principalId: string;
      requestId: string;
      resourceIds: string[];
    };
    RaftTags: {
      values: {
        [key: string]: string;
      };
      version: number;
    };
    RaftWorkspace: {
      canManage?: boolean;
      generation: number;
      id: string;
      name: string;
      regionId: string;
      serverId: string;
    };
    Region: {
      /** Format: uri */
      apiOrigin: string;
      apiPathPrefix: string;
      regionId: string;
    };
    RegionAccessToken: {
      accessToken: string;
      expiresAt: number;
      id: string;
      keyId: string;
      keyVersion: number;
      principalId: string;
      region: components['schemas']['Region'];
      scopes: string[];
      /** @constant */
      tokenType: 'Bearer';
    };
    RegionToken: {
      accessToken: string;
      enrollmentExpiresAt: number;
      enrollmentTicket: string;
      expiresAt: number;
      id: string;
      keyId: string;
      keyVersion: number;
      nonce: string;
      principalId: string;
      region: components['schemas']['Region'];
      scopes: string[];
      /** @constant */
      tokenType: 'Bearer';
    };
    Token: {
      accessToken: string;
      expiresAt: number;
      id: string;
      scopes: string[];
      /** @constant */
      tokenType: 'Bearer';
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
  raftManifest: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': Record<string, never>;
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
  getGlobalAuthConfig: {
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
            localSessionPath: string;
            loginPath: string;
            /** @enum {unknown} */
            mode: 'local' | 'oidc';
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
  getGlobalOwnerSession: {
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
      /** @description Successful response */
      200: {
        headers: {
          'Cache-Control'?: 'no-store';
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            regionId: string;
            workspaceId: string;
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
            expiresAt: number;
            regionId: string;
            workspaceId: string;
          };
        };
      };
      /** @description Owner cookie issued; redirect to the validated Console return URL. */
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
  startGlobalOwnerLogin: {
    parameters: {
      query?: {
        /** @description Optional for first login when one Region is configured and registered. */
        workspaceId?: string;
        /** @description Optional return URL on an explicitly trusted Console origin. */
        returnTo?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to the existing Portal sign-in or the explicitly configured identity provider. */
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
  revokeGlobalOwnerSession: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header: {
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
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
            authority: 'global';
            /** @constant */
            status: 'ok';
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
  createGlobalKeyPolicyDelivery: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
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
              regionalContinuity: 'pending' | 'eligible' | 'unavailable';
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
              regionalContinuity: 'pending' | 'eligible' | 'unavailable';
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
            data: {
              data: components['schemas']['Key'];
              grants: components['schemas']['Grants'];
              /** @enum {unknown} */
              regionalStatus: 'pending' | 'applied';
            }[];
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
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json':
          | {
              /**
               * @description Lifetime choice; the server computes the expiry.
               * @enum {integer}
               */
              expiresInDays: 1 | 2 | 7 | 30 | 90;
              /** @default Agent key */
              name?: string;
              /** @description Explicit resource IDs or the existing workspace-wide wildcard. */
              resourceIds: string[];
              scopes: string[];
            }
          | {
              /**
               * @deprecated
               * @description Deprecated absolute Unix-second expiry, accepted only inside the 90-day ceiling.
               */
              expiresAt: number;
              /** @default Agent key */
              name?: string;
              /** @description Explicit resource IDs or the existing workspace-wide wildcard. */
              resourceIds: string[];
              scopes: string[];
            }
          | {
              /**
               * @description Lifetime choice; the server computes the expiry.
               * @enum {integer}
               */
              expiresInDays: 1 | 2 | 7 | 30 | 90;
              /** @default Agent key */
              name?: string;
              /** @description Selected types include current and future public resources in this Workspace. */
              resourceTypes: ('database' | 'filesystem')[];
              scopes: string[];
            }
          | {
              /**
               * @deprecated
               * @description Deprecated absolute Unix-second expiry, accepted only inside the 90-day ceiling.
               */
              expiresAt: number;
              /** @default Agent key */
              name?: string;
              /** @description Selected types include current and future public resources in this Workspace. */
              resourceTypes: ('database' | 'filesystem')[];
              scopes: string[];
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
            grants: components['schemas']['Grants'];
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
            secret: string;
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
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
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
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
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
        'application/json':
          | {
              /**
               * @description Renewal lifetime choice counted from now; the server computes the expiry.
               * @enum {integer}
               */
              expiresInDays: 1 | 2 | 7 | 30 | 90;
            }
          | {
              /**
               * @deprecated
               * @description Deprecated absolute Unix-second expiry, accepted only inside the 90-day ceiling.
               */
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
            regionalContinuity: 'pending' | 'eligible' | 'unavailable';
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
  rotateGlobalKey: {
    parameters: {
      query?: never;
      header: {
        /** @description Operation identity. A repeated secret-producing operation never returns another secret. Resolve uncertain outcomes; do not blindly repeat. */
        'Idempotency-Key': string;
        /** @description Quoted current Key version ETag. */
        'If-Match': string;
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
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
            /** @enum {unknown} */
            regionalStatus: 'pending' | 'applied';
            secret: string;
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
  createPortalRegionSessionTicket: {
    parameters: {
      query?: never;
      header: {
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
        Origin: string;
      };
      path: {
        workspaceId: string;
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
            /** @constant */
            expiresIn: 60;
            region: components['schemas']['Region'];
            ticket: string;
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
  raftContext: {
    parameters: {
      query?: {
        cursor?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftContext'];
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
  raftListResources: {
    parameters: {
      query: {
        workspaceId: string;
        cursor?: string;
        /** @description JSON object of at most 20 exact string key/value filters, AND semantics. Tags convey no permission. A changed policy/filter invalidates the cursor. */
        tags?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            nextCursor: string | null;
            resources: components['schemas']['RaftResource'][];
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
  raftQuery: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RaftQueryInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftQuery'];
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
  raftQueryStatus: {
    parameters: {
      query: {
        workspaceId: string;
        resourceId: string;
        requestId: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftQuery'];
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
  raftReadFile: {
    parameters: {
      query: {
        workspaceId: string;
        resourceId: string;
        /** @description Relative path without traversal, empty, dot or backslash segments. */
        path: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftFile'];
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
  raftConfig: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            loginUrl: string;
            regions: string[];
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
  raftWorkspaces: {
    parameters: {
      query?: {
        cursor?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftWorkspace'][];
            nextCursor: string | null;
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
  raftCreateWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          regionId: string;
          requestId: string;
        };
      };
    };
    responses: {
      /** @description Created; resourceReady is false until a usable resource is explicitly created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftWorkspace'];
            resourceReady: boolean;
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
  raftWorkspace: {
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
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftWorkspace'];
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
  raftAuditEvents: {
    parameters: {
      query?: {
        cursor?: string;
      };
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftAuditEvent'][];
            nextCursor: string | null;
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
  raftEnrollments: {
    parameters: {
      query?: {
        cursor?: string;
      };
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            nextCursor: string | null;
            records: {
              value: components['schemas']['RaftEnrollment'];
            }[];
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
  raftRequestEnrollment: {
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
        'application/json': Record<string, never>;
      };
    };
    responses: {
      /** @description Requested */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftEnrollment'];
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
  raftOwnEnrollment: {
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
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftEnrollment'] | null;
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
  raftDecideEnrollment: {
    parameters: {
      query?: never;
      header: {
        /** @description Quoted current Workspace generation, reviewed before this Human mutation. A fresh Human sign-in within ten minutes is required. Immutable retries resolve the original intent. */
        'If-Match': string;
      };
      path: {
        workspaceId: string;
        principalId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          approved: boolean;
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftEnrollment'];
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
  raftInvite: {
    parameters: {
      query?: never;
      header: {
        /** @description Quoted current Workspace generation, reviewed before this Human mutation. A fresh Human sign-in within ten minutes is required. Immutable retries resolve the original intent. */
        'If-Match': string;
      };
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          principalId: string;
          requestId: string;
        };
      };
    };
    responses: {
      /** @description Recorded and applied */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftEnrollment'];
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
  raftInvitation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        requestId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftEnrollment'];
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
  raftRemoveMember: {
    parameters: {
      query?: never;
      header: {
        /** @description Quoted current Workspace generation, reviewed before this Human mutation. A fresh Human sign-in within ten minutes is required. Immutable retries resolve the original intent. */
        'If-Match': string;
      };
      path: {
        workspaceId: string;
        principalId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftWorkspace'];
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
  raftAdmissionCandidate: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        principalId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftPrincipal'];
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
  raftGovernanceResources: {
    parameters: {
      query?: {
        cursor?: string;
      };
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftCatalog'];
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
  raftCreateResource: {
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
          /** @enum {unknown} */
          kind: 'filesystem' | 'postgresql';
          name: string;
          region: string;
          requestId: string;
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftResource'];
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
  raftShareBatch: {
    parameters: {
      query?: never;
      header: {
        /** @description Quoted current Workspace generation, reviewed before this Human mutation. A fresh Human sign-in within ten minutes is required. Immutable retries resolve the original intent. */
        'If-Match': string;
      };
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RaftShareBatchInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftShareBatch'];
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
  raftGetFile: {
    parameters: {
      query: {
        path: string;
      };
      header?: never;
      path: {
        workspaceId: string;
        resourceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RaftFile'];
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
  raftWriteFile: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        resourceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          content: string;
          path: string;
          version?: string;
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': Record<string, never>;
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
  raftResourceGrants: {
    parameters: {
      query?: {
        cursor?: string;
      };
      header?: never;
      path: {
        workspaceId: string;
        resourceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftGrant'][];
            nextCursor: string | null;
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
  raftPutGrant: {
    parameters: {
      query?: never;
      header: {
        /** @description Quoted current Workspace generation, reviewed before this Human mutation. A fresh Human sign-in within ten minutes is required. Immutable retries resolve the original intent. */
        'If-Match': string;
      };
      path: {
        workspaceId: string;
        resourceId: string;
        grantId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RaftGrantInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftGrant'];
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
  raftSetTags: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        resourceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RaftTags'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['RaftTags'];
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
  createLocalGlobalOwnerSession: {
    parameters: {
      query?: never;
      header: {
        /** @description Must equal the Global public origin or an explicitly trusted Console origin for Owner mutations. */
        Origin: string;
      };
      path?: never;
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
            regionId: string;
            workspaceId: string;
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
  createDiscoveredTokenIssuance: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @enum {unknown} */
          audience: 'global' | 'region';
          clientThumbprint?: string;
          scopes?: string[];
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
          'application/json':
            | components['schemas']['DiscoveredToken']
            | components['schemas']['DiscoveredRegionAccessToken']
            | components['schemas']['DiscoveredRegionToken'];
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
  getGlobalRegionRoute: {
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
      /** @description Region API base URL. No data request has been sent to Global. */
      307: {
        headers: {
          'Cache-Control'?: 'no-store';
          Location: string;
          'X-Region-Id': string;
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
          clientThumbprint?: string;
          scopes?: string[];
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
          'application/json':
            | components['schemas']['Token']
            | components['schemas']['RegionAccessToken']
            | components['schemas']['RegionToken'];
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
  raftCallback: {
    parameters: {
      query: {
        code: string;
        state?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Agent session cookie set on this response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            authenticated: boolean;
            nextAction: string;
          };
        };
      };
      /** @description Human session established; redirect to fixed Console URL */
      303: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Flat CLI-compatible failure; expired/consumed code is 409 */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
            hint: string;
          };
        };
      };
    };
  };
  raftLogin: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to trusted Raft issuer; sets flow cookie */
      303: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  raftLogout: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, never>;
      };
    };
    responses: {
      /** @description Signed out; session cookie cleared */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Denied */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
}
