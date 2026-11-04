export interface paths {
  '/analytics/config': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getProductAnalyticsConfig'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/analytics/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Untrusted optional browser events only. Exact trusted Origin and application/json required; no account or Workspace authorization is established. 202 means durable acceptance; identical event retries are deduplicated for the retained window. GPC suppression returns 204. */
    post: operations['ingestProductEvents'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/analytics/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['enableAnalyticsAttribution'];
    delete: operations['clearAnalyticsAttribution'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/operator/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getOperatorSession'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/operator/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['beginOperatorLogin'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/operator/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['endOperatorSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/operator/analytics/breakdowns/{kind}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        kind: 'acquisition' | 'funnel' | 'retention' | 'outcomes';
      };
      cookie?: never;
    };
    get: operations['getProductInsightBreakdown'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/operator/analytics/summary': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getProductInsights'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/operator/analytics/coverage': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getProductAnalyticsCoverage'];
    put?: never;
    post?: never;
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
    ProductInsights: {
      authorities: {
        firstUseSources: {
          [key: string]: number;
        };
        firstUseCampaigns: {
          [key: string]: number;
        };
        authority: string;
        from: string;
        to: string;
        /** @constant */
        timezone: 'UTC';
        counts: {
          pageViews: number;
          tryClicks: number;
          signInClicks: number;
          ready: number;
          successes: number;
          failures: number;
          helpful: number;
          votes: number;
          events: {
            [key: string]: number;
          };
          sources: {
            [key: string]: number;
          };
          campaigns: {
            [key: string]: number;
          };
          journeys: {
            [key: string]: number;
          };
        };
        sessions: number;
        trials: number;
        activeWorkspaces: number;
        apiWorkspaces: number;
        cohorts: {
          actor: string;
          ready: number;
          eligible: number;
          activated: number;
          d1Eligible: number;
          d1Returned: number;
          d7Eligible: number;
          d7Returned: number;
        }[];
        timeToValueSeconds: {
          [key: string]: number;
        };
        generatedAt: number;
        unconfirmedEvents: number;
        coverage: string;
      }[];
      missingRegions: string[];
      /** @constant */
      definitionsVersion: 1;
      /** @constant */
      timezone: 'UTC';
      partial: boolean;
      /** @constant */
      monitoring: 'not_included';
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
  getProductAnalyticsConfig: {
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
            enabled: boolean;
            campaigns: string[];
            /** @constant */
            policy: 'session_only';
            /** @constant */
            version: 1;
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  ingestProductEvents: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @constant */
          version: 1;
          /** Format: uuid */
          sessionId: string;
          events: {
            /** Format: uuid */
            id: string;
            event:
              | {
                  /** @constant */
                  name: 'public_page_view';
                  /** @enum {unknown} */
                  page: 'home' | 'get_started' | 'sales_guide' | 'api_docs' | 'workspace';
                  /** @enum {unknown} */
                  source: 'search' | 'ai_referral' | 'social' | 'other' | 'direct_or_unknown';
                  /** @enum {unknown} */
                  device: 'mobile' | 'desktop';
                  campaign?: string | null;
                }
              | {
                  /** @constant */
                  name: 'try_clicked';
                  /** @enum {unknown} */
                  page: 'home' | 'get_started' | 'sales_guide' | 'api_docs' | 'workspace';
                }
              | {
                  /** @constant */
                  name: 'sign_in_clicked';
                  /** @enum {unknown} */
                  page: 'home' | 'get_started' | 'sales_guide' | 'api_docs' | 'workspace';
                }
              | {
                  /** @constant */
                  name: 'journey_selected';
                  /** @enum {unknown} */
                  journey: 'agent' | 'self_service';
                }
              | {
                  /** @constant */
                  name: 'helpful_vote';
                  helpful: boolean;
                };
          }[];
        };
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @constant */
            accepted: true;
          };
        };
      };
      /** @description Optional collection suppressed by Global Privacy Control. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Structured service error. No customer content or secrets. */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  enableAnalyticsAttribution: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Clear the server-side optional-analytics opt-out flag; exact trusted Origin required. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  clearAnalyticsAttribution: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Pending attribution cleared. Exact trusted Origin required. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  getOperatorSession: {
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
            /** @constant */
            operator: true;
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  beginOperatorLogin: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to the existing TiDB Cloud code/PKCE login with operator mode. The existing registered callback verifies the flow before issuing a distinct Admin session. No customer Workspace is created. */
      303: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  endOperatorSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Revoked and cleared. Exact trusted Origin required. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  getProductInsightBreakdown: {
    parameters: {
      query?: {
        /** @description Inclusive UTC date. Maximum 31-day range, within the retained window. */
        from?: string;
        /** @description Exclusive UTC date. Maximum 31-day range, within the retained window. */
        to?: string;
      };
      header?: never;
      path: {
        kind: 'acquisition' | 'funnel' | 'retention' | 'outcomes';
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
            authorities: {
              firstUseSources: {
                [key: string]: number;
              };
              firstUseCampaigns: {
                [key: string]: number;
              };
              authority: string;
              from: string;
              to: string;
              /** @constant */
              timezone: 'UTC';
              counts: {
                pageViews: number;
                tryClicks: number;
                signInClicks: number;
                ready: number;
                successes: number;
                failures: number;
                helpful: number;
                votes: number;
                events: {
                  [key: string]: number;
                };
                sources: {
                  [key: string]: number;
                };
                campaigns: {
                  [key: string]: number;
                };
                journeys: {
                  [key: string]: number;
                };
              };
              sessions: number;
              trials: number;
              activeWorkspaces: number;
              apiWorkspaces: number;
              cohorts: {
                actor: string;
                ready: number;
                eligible: number;
                activated: number;
                d1Eligible: number;
                d1Returned: number;
                d7Eligible: number;
                d7Returned: number;
              }[];
              timeToValueSeconds: {
                [key: string]: number;
              };
              generatedAt: number;
              unconfirmedEvents: number;
              coverage: string;
            }[];
            missingRegions: string[];
            /** @constant */
            definitionsVersion: 1;
            /** @constant */
            timezone: 'UTC';
            partial: boolean;
            /** @constant */
            monitoring: 'not_included';
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  getProductInsights: {
    parameters: {
      query?: {
        /** @description Inclusive UTC date. Maximum 31-day range, within the retained window. */
        from?: string;
        /** @description Exclusive UTC date. Maximum 31-day range, within the retained window. */
        to?: string;
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
            authorities: {
              firstUseSources: {
                [key: string]: number;
              };
              firstUseCampaigns: {
                [key: string]: number;
              };
              authority: string;
              from: string;
              to: string;
              /** @constant */
              timezone: 'UTC';
              counts: {
                pageViews: number;
                tryClicks: number;
                signInClicks: number;
                ready: number;
                successes: number;
                failures: number;
                helpful: number;
                votes: number;
                events: {
                  [key: string]: number;
                };
                sources: {
                  [key: string]: number;
                };
                campaigns: {
                  [key: string]: number;
                };
                journeys: {
                  [key: string]: number;
                };
              };
              sessions: number;
              trials: number;
              activeWorkspaces: number;
              apiWorkspaces: number;
              cohorts: {
                actor: string;
                ready: number;
                eligible: number;
                activated: number;
                d1Eligible: number;
                d1Returned: number;
                d7Eligible: number;
                d7Returned: number;
              }[];
              timeToValueSeconds: {
                [key: string]: number;
              };
              generatedAt: number;
              unconfirmedEvents: number;
              coverage: string;
            }[];
            missingRegions: string[];
            /** @constant */
            definitionsVersion: 1;
            /** @constant */
            timezone: 'UTC';
            partial: boolean;
            /** @constant */
            monitoring: 'not_included';
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
  getProductAnalyticsCoverage: {
    parameters: {
      query?: {
        /** @description Inclusive UTC date. Maximum 31-day range, within the retained window. */
        from?: string;
        /** @description Exclusive UTC date. Maximum 31-day range, within the retained window. */
        to?: string;
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
            authorities: {
              firstUseSources: {
                [key: string]: number;
              };
              firstUseCampaigns: {
                [key: string]: number;
              };
              authority: string;
              from: string;
              to: string;
              /** @constant */
              timezone: 'UTC';
              counts: {
                pageViews: number;
                tryClicks: number;
                signInClicks: number;
                ready: number;
                successes: number;
                failures: number;
                helpful: number;
                votes: number;
                events: {
                  [key: string]: number;
                };
                sources: {
                  [key: string]: number;
                };
                campaigns: {
                  [key: string]: number;
                };
                journeys: {
                  [key: string]: number;
                };
              };
              sessions: number;
              trials: number;
              activeWorkspaces: number;
              apiWorkspaces: number;
              cohorts: {
                actor: string;
                ready: number;
                eligible: number;
                activated: number;
                d1Eligible: number;
                d1Returned: number;
                d7Eligible: number;
                d7Returned: number;
              }[];
              timeToValueSeconds: {
                [key: string]: number;
              };
              generatedAt: number;
              unconfirmedEvents: number;
              coverage: string;
            }[];
            missingRegions: string[];
            /** @constant */
            definitionsVersion: 1;
            /** @constant */
            timezone: 'UTC';
            partial: boolean;
            /** @constant */
            monitoring: 'not_included';
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
      /** @description Structured service error. No customer content or secrets. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: {
              code: string;
            };
          };
        };
      };
    };
  };
}
