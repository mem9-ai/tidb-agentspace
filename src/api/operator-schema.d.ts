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
    /** @description Untrusted optional browser events only. Exact trusted Origin and application/json required; no account or Workspace authorization is established. 202 acknowledges queued acceptance by the independent analytics service, not object-storage durability. Queued writes may be lost on a crash. Retained event IDs deduplicate retries. GPC suppression returns 204. */
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
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ProductInsights: {
      authorities: {
        activeWorkspaces: number;
        apiWorkspaces: number;
        authority: string;
        cohorts: {
          activated: number;
          actor: string;
          d1Eligible: number;
          d1Returned: number;
          d7Eligible: number;
          d7Returned: number;
          eligible: number;
          ready: number;
        }[];
        counts: {
          campaigns: {
            [key: string]: number;
          };
          events: {
            [key: string]: number;
          };
          failures: number;
          helpful: number;
          journeys: {
            [key: string]: number;
          };
          pageViews: number;
          ready: number;
          signInClicks: number;
          sources: {
            [key: string]: number;
          };
          successes: number;
          tryClicks: number;
          votes: number;
        };
        coverage: string;
        firstUseCampaigns: {
          [key: string]: number;
        };
        firstUseSources: {
          [key: string]: number;
        };
        from: string;
        generatedAt: number;
        sessions: number;
        timeToValueSeconds: {
          [key: string]: number;
        };
        /** @constant */
        timezone: 'UTC';
        to: string;
        trials: number;
        unconfirmedEvents: number;
      }[];
      /** @constant */
      definitionsVersion: 1;
      missingRegions: string[];
      /** @constant */
      monitoring: 'not_included';
      partial: boolean;
      /** @constant */
      timezone: 'UTC';
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
            campaigns: string[];
            enabled: boolean;
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
          events: {
            event:
              | {
                  campaign?: string | null;
                  /** @enum {unknown} */
                  device: 'mobile' | 'desktop';
                  /** @constant */
                  name: 'public_page_view';
                  /** @enum {unknown} */
                  page: 'home' | 'get_started' | 'sales_guide' | 'api_docs' | 'workspace';
                  /** @enum {unknown} */
                  source: 'search' | 'ai_referral' | 'social' | 'other' | 'direct_or_unknown';
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
                  /** @enum {unknown} */
                  journey: 'agent' | 'self_service';
                  /** @constant */
                  name: 'journey_selected';
                }
              | {
                  helpful: boolean;
                  /** @constant */
                  name: 'helpful_vote';
                };
            /** Format: uuid */
            id: string;
          }[];
          /** Format: uuid */
          sessionId: string;
          /** @constant */
          version: 1;
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
            /** @constant */
            durability: 'queued';
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
              activeWorkspaces: number;
              apiWorkspaces: number;
              authority: string;
              cohorts: {
                activated: number;
                actor: string;
                d1Eligible: number;
                d1Returned: number;
                d7Eligible: number;
                d7Returned: number;
                eligible: number;
                ready: number;
              }[];
              counts: {
                campaigns: {
                  [key: string]: number;
                };
                events: {
                  [key: string]: number;
                };
                failures: number;
                helpful: number;
                journeys: {
                  [key: string]: number;
                };
                pageViews: number;
                ready: number;
                signInClicks: number;
                sources: {
                  [key: string]: number;
                };
                successes: number;
                tryClicks: number;
                votes: number;
              };
              coverage: string;
              firstUseCampaigns: {
                [key: string]: number;
              };
              firstUseSources: {
                [key: string]: number;
              };
              from: string;
              generatedAt: number;
              sessions: number;
              timeToValueSeconds: {
                [key: string]: number;
              };
              /** @constant */
              timezone: 'UTC';
              to: string;
              trials: number;
              unconfirmedEvents: number;
            }[];
            /** @constant */
            definitionsVersion: 1;
            missingRegions: string[];
            /** @constant */
            monitoring: 'not_included';
            partial: boolean;
            /** @constant */
            timezone: 'UTC';
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
              activeWorkspaces: number;
              apiWorkspaces: number;
              authority: string;
              cohorts: {
                activated: number;
                actor: string;
                d1Eligible: number;
                d1Returned: number;
                d7Eligible: number;
                d7Returned: number;
                eligible: number;
                ready: number;
              }[];
              counts: {
                campaigns: {
                  [key: string]: number;
                };
                events: {
                  [key: string]: number;
                };
                failures: number;
                helpful: number;
                journeys: {
                  [key: string]: number;
                };
                pageViews: number;
                ready: number;
                signInClicks: number;
                sources: {
                  [key: string]: number;
                };
                successes: number;
                tryClicks: number;
                votes: number;
              };
              coverage: string;
              firstUseCampaigns: {
                [key: string]: number;
              };
              firstUseSources: {
                [key: string]: number;
              };
              from: string;
              generatedAt: number;
              sessions: number;
              timeToValueSeconds: {
                [key: string]: number;
              };
              /** @constant */
              timezone: 'UTC';
              to: string;
              trials: number;
              unconfirmedEvents: number;
            }[];
            /** @constant */
            definitionsVersion: 1;
            missingRegions: string[];
            /** @constant */
            monitoring: 'not_included';
            partial: boolean;
            /** @constant */
            timezone: 'UTC';
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
              activeWorkspaces: number;
              apiWorkspaces: number;
              authority: string;
              cohorts: {
                activated: number;
                actor: string;
                d1Eligible: number;
                d1Returned: number;
                d7Eligible: number;
                d7Returned: number;
                eligible: number;
                ready: number;
              }[];
              counts: {
                campaigns: {
                  [key: string]: number;
                };
                events: {
                  [key: string]: number;
                };
                failures: number;
                helpful: number;
                journeys: {
                  [key: string]: number;
                };
                pageViews: number;
                ready: number;
                signInClicks: number;
                sources: {
                  [key: string]: number;
                };
                successes: number;
                tryClicks: number;
                votes: number;
              };
              coverage: string;
              firstUseCampaigns: {
                [key: string]: number;
              };
              firstUseSources: {
                [key: string]: number;
              };
              from: string;
              generatedAt: number;
              sessions: number;
              timeToValueSeconds: {
                [key: string]: number;
              };
              /** @constant */
              timezone: 'UTC';
              to: string;
              trials: number;
              unconfirmedEvents: number;
            }[];
            /** @constant */
            definitionsVersion: 1;
            missingRegions: string[];
            /** @constant */
            monitoring: 'not_included';
            partial: boolean;
            /** @constant */
            timezone: 'UTC';
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
}
