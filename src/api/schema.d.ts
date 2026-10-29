export interface paths {
  '/workspaces': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List available workspaces
     * @description Required workspace key scope: resources:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['listWorkspaces'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Describe a workspace
     * @description Required workspace key scope: resources:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['getWorkspace'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/bootstrap': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Load the local owner Console state
     * @description Requires the local browser owner session. Workspace API keys cannot perform this operation.
     */
    get: operations['getBootstrap'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/resources': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Discover databases and file systems
     * @description Required workspace key scope: resources:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['listResources'];
    put?: never;
    /**
     * Create a resource using the configured provider
     * @description Required workspace key scope: resources:write. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    post: operations['createResource'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/files/tabular-preview': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Read a fixed bounded CSV/Parquet schema and sample
     * @description Required workspace key scope: files:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. Fixed CSV/Parquet schema/sample only: accepts resourceId/path, no custom SQL or engine settings. Requires files:read, not files:analyze. Whole version-verified snapshot up to 16 MiB, 15 seconds and shared two-worker budget; at most 20 rows, 50 columns, 128 KiB. CSV types are inferred and totalRows unknown; Parquet count is metadata. No automatic retry. Download unsupported or over-budget files.
     */
    get: operations['tabularFilePreview'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/file-analyses/capabilities': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Discover read-only analysis for a selected file
     * @description Required workspace key scope: files:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['fileAnalysisCapabilities'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/file-analyses': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Run bounded read-only DuckDB SQL or Just Bash on one selected file
     * @description Required workspace key scope: files:analyze. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. Also requires files:read. Discover engines from capabilities: CSV supports DuckDB SQL over table file or Just Bash over its raw UTF-8 text. Bash exposes the selected absolute Workspace path; discover input.path, input.workingDirectory and compatibility aliases on its engine option. Paths refer only to the virtual selected-file snapshot. Parquet supports only DuckDB, and other recognized text only Just Bash. Only the selected snapshot is available; no provider credentials, network, persistent writes or host paths. Limits: 16 MiB input, 64 KiB script, 15 seconds, 1000 rows / 1 MiB output, two active analyses. Large/unsupported files remain downloadable. No implicit retry.
     */
    post: operations['analyzeFile'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/files': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * List files (Drive9 metadata only; local files include UTF-8 contents)
     * @description Required workspace key scope: files:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['listFiles'];
    /**
     * Create or replace a UTF-8 file or directory
     * @description Required workspace key scope: files:write. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    put: operations['writeFile'];
    post?: never;
    /**
     * Delete a file or empty directory
     * @description Required workspace key scope: files:write. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    delete: operations['deleteFile'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/files/content': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Download original bytes or request a bounded text preview (Drive9)
     * @description Required workspace key scope: files:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['downloadFile'];
    /**
     * Upload original bytes to Drive9 (gateway maximum 1 MiB)
     * @description Required workspace key scope: files:write. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    put: operations['uploadFile'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/resources/{resourceId}/setup': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
        resourceId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Resume managed database setup on the same saved storage/instance; never replace an uncertain request
     * @description Required workspace key scope: resources:write. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    post: operations['retryDatabaseSetup'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/resources/{resourceId}/tables': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
        resourceId: string;
      };
      cookie?: never;
    };
    /**
     * List up to 500 tables and views in the selected database, ordered by name; truncated means more exist
     * @description Required workspace key scope: queries:execute. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['listDatabaseTables'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/resources/{resourceId}/table': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
        resourceId: string;
      };
      cookie?: never;
    };
    /**
     * Read columns and ordered index parts for an exact table name; includes a SELECT for the editor
     * @description Required workspace key scope: queries:execute. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['getDatabaseTable'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/resources/{resourceId}/table/rows': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
        resourceId: string;
      };
      cookie?: never;
    };
    /**
     * Read up to 100 unordered rows, bounded by 1 MiB and 15 seconds per statement; not pagination or a full export
     * @description Required workspace key scope: queries:execute. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['previewDatabaseTable'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/database-imports/prepare': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Parse a Workspace CSV/Parquet for a fixed destination database
     * @description Required workspace key scope: queries:execute on destination; files:read and files:analyze on source. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. CSV/Parquet only. Preparations are principal- and destination-bound, expire after five minutes, and retain at most 1,000 rows/100 columns/1 MiB parsed data. Preview returns at most 20 rows; commit uses all retained rows. Local uploads are ephemeral and never create a File System resource. Workspace inputs retain a 16 MiB snapshot budget. Parsing has a 15-second deadline and two slots. Existing 64 KiB SQL-statement budgets apply. Only server-generated DuckDB import writes have a fixed 30-second worker deadline per statement; ordinary SQL and parsing keep 15 seconds. New tables only; no append, overwrite, DROP or automatic write retry. Inspect the destination after an incomplete or uncertain outcome. Changing the target requires a new preparation. API restart invalidates preparations.
     */
    post: operations['prepareDatabaseImport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/database-imports/prepare-upload': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Upload up to 1 MiB of local CSV/Parquet for private schema review
     * @description Required workspace key scope: queries:execute on destination. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. CSV/Parquet only. Preparations are principal- and destination-bound, expire after five minutes, and retain at most 1,000 rows/100 columns/1 MiB parsed data. Preview returns at most 20 rows; commit uses all retained rows. Local uploads are ephemeral and never create a File System resource. Workspace inputs retain a 16 MiB snapshot budget. Parsing has a 15-second deadline and two slots. Existing 64 KiB SQL-statement budgets apply. Only server-generated DuckDB import writes have a fixed 30-second worker deadline per statement; ordinary SQL and parsing keep 15 seconds. New tables only; no append, overwrite, DROP or automatic write retry. Inspect the destination after an incomplete or uncertain outcome. Changing the target requires a new preparation. API restart invalidates preparations.
     */
    post: operations['prepareDatabaseImportUpload'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/database-imports': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Confirm reviewed server rows and create a new database table
     * @description Required workspace key scope: queries:execute on destination; Workspace files additionally require source files:read and files:analyze. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. CSV/Parquet only. Preparations are principal- and destination-bound, expire after five minutes, and retain at most 1,000 rows/100 columns/1 MiB parsed data. Preview returns at most 20 rows; commit uses all retained rows. Local uploads are ephemeral and never create a File System resource. Workspace inputs retain a 16 MiB snapshot budget. Parsing has a 15-second deadline and two slots. Existing 64 KiB SQL-statement budgets apply. Only server-generated DuckDB import writes have a fixed 30-second worker deadline per statement; ordinary SQL and parsing keep 15 seconds. New tables only; no append, overwrite, DROP or automatic write retry. Inspect the destination after an incomplete or uncertain outcome. Changing the target requires a new preparation. API restart invalidates preparations.
     */
    post: operations['commitDatabaseImport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/file-exports/prepare': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Parse an original file or Bash stream for explicit schema review
     * @description Required workspace key scope: files:analyze. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. Also requires files:read and the source File System grant. Fixed CSV/Parquet/text-line parsing, no scripts. Up to 16 MiB original or 1 MiB output text, 1000 rows/100 columns/1 MiB parsed data and 15 seconds, shared worker admission. Returns 20 sample rows and suggested field types with an actor-bound five-minute preparation. Parsing writes nothing. CSV keeps leading zeros and distinguishes quoted empty strings from NULL. Text lines are explicit one-column records.
     */
    post: operations['prepareFileExport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/file-exports': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Copy original bytes, export Bash text or commit a confirmed database import
     * @description Required workspace key scope: files:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. Original copies require read access; Bash output requires read plus analyze. File targets require files:write and a target grant. Database commits require the exact actor preparation, confirmed=true, reviewed fields, source read/analyze and target queries:execute/grant. Original versions must match; single-use writes, no append/overwrite/retry. Output text is client-supplied authorization context, not attested command lineage. Only these two routes permit an 8 MiB JSON envelope for at most 1 MiB output text. Original downloads retain /files/content (local files use /files).
     */
    post: operations['exportFileContent'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/result-exports': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Export a supplied result snapshot without rerunning its source query
     * @description Required workspace key scope: Source database: queries:execute; source File System: files:read and files:analyze. Destination additionally requires files:write or queries:execute and its resource grant. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint. Client-supplied snapshot, not attested provenance. Up to 100 columns, 1000 rows, 16 nesting levels and 1 MiB request. Downloads: CSV/JSON/JSON Lines, up to 4 MiB encoded output. Files: conditional create, 256 KiB local / 1 MiB live plus provider limits. Database targets: active live resources, CREATE then one INSERT, each up to 64 KiB and 15 seconds; no transaction across both statements. Name collisions never append/replace. EXPORT_INCOMPLETE or a timeout may leave a new table; inspect before retrying. No automatic retry. Precision strings remain text; CSV renders null as empty and prefixes spreadsheet-formula strings. No result values are audited.
     */
    post: operations['exportResult'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/queries': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Execute one statement on a selected database; live SQL can read and write
     * @description Required workspace key scope: queries:execute. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    post: operations['executeQuery'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/usage': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * Get local usage; live trial usage and allowances are unmeasured
     * @description Required workspace key scope: usage:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['getUsage'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/events': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * List the latest 200 successful local mutation events
     * @description Required workspace key scope: resources:read. Resource operations also require the target in resourceIds (or an explicit wildcard). Lists are filtered to permitted resources. The local owner session may also call this endpoint.
     */
    get: operations['listEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/keys': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    /**
     * List key metadata without secrets
     * @description Requires the local browser owner session. Workspace API keys cannot perform this operation.
     */
    get: operations['listKeys'];
    put?: never;
    /**
     * Create an expiring scoped local API key
     * @description Requires the local browser owner session. Workspace API keys cannot perform this operation.
     */
    post: operations['createKey'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/keys/{keyId}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
        keyId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Immediately revoke an API key
     * @description Requires the local browser owner session. Workspace API keys cannot perform this operation.
     */
    delete: operations['revokeKey'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/workspaces/{workspaceId}/settings': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
     * Update local workspace and profile
     * @description Requires the local browser owner session. Workspace API keys cannot perform this operation.
     */
    patch: operations['updateSettings'];
    trace?: never;
  };
  '/api/health': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getHealth'];
    put?: never;
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
    /**
     * Create a loopback-only demo owner session
     * @description Local demonstration only. Sets an HttpOnly SameSite=Strict cookie. Allowed browser origins require credentialed CORS; production identity is not implemented.
     */
    post: operations['createLocalSession'];
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
    Resource: {
      id: string;
      name: string;
      /** @enum {unknown} */
      kind: 'mysql' | 'postgresql' | 'duckdb' | 'filesystem';
      region: string;
      /** @enum {unknown} */
      status:
        'active' | 'provisioning' | 'failed' | 'suspended' | 'deleting' | 'deleted' | 'expired';
      /**
       * @description Missing on legacy local resources. db9-anonymous is PostgreSQL-compatible; its NUMERIC supports 28–29 significant digits. Provider compatibility limits apply.
       * @enum {unknown}
       */
      provider?:
        'local' | 'drive9-anonymous' | 'tidb-cloud-zero' | 'duckdb-drive9' | 'db9-anonymous';
      /** @description Negotiated gateway upload limit; zero means uploads are unavailable. */
      uploadLimitBytes?: number;
      connectionError?: string;
      /**
       * Format: date-time
       * @description Zero expiry reported by the provider. No automatic renewal or replacement.
       */
      expiresAt?: string;
      /** Format: date-time */
      createdAt: string;
    };
    File: {
      id: string;
      resourceId: string;
      path: string;
      /** @enum {unknown} */
      type: 'file' | 'directory';
      content?: string;
      size: number;
      /** Format: date-time */
      updatedAt: string | null;
    };
    Key: {
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      /** @description Explicit allowed resource IDs, or ["*"] for all current and future resources. */
      resourceIds: string[];
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      expiresAt: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    };
    Error: {
      error: {
        code: string;
        message: string;
        requestId: string;
      };
    };
    ResultExportInput: {
      sourceResourceId: string;
      result: {
        columns: string[];
        rows: {
          [key: string]: unknown;
        }[];
      };
      target:
        | {
            /** @constant */
            kind: 'download';
            /** @enum {string} */
            format: 'csv' | 'json' | 'jsonl';
          }
        | {
            /** @constant */
            kind: 'filesystem';
            resourceId: string;
            path: string;
            /** @enum {string} */
            format: 'csv' | 'json' | 'jsonl';
          }
        | {
            /** @constant */
            kind: 'database';
            resourceId: string;
            table: string;
          };
    };
    ResultExportOutput:
      | {
          /** @constant */
          kind: 'download';
          rowCount: number;
          /** @enum {string} */
          format: 'csv' | 'json' | 'jsonl';
          filename: string;
          mimeType: string;
          content: string;
          bytes: number;
        }
      | {
          /** @constant */
          kind: 'filesystem';
          rowCount: number;
          resourceId: string;
          path: string;
          /** @enum {string} */
          format: 'csv' | 'json' | 'jsonl';
          bytes: number;
        }
      | {
          /** @constant */
          kind: 'database';
          rowCount: number;
          resourceId: string;
          table: string;
          columns: {
            name: string;
            type: string;
          }[];
        };
    FileExportSource:
      | {
          /** @constant */
          kind: 'original';
          resourceId: string;
          path: string;
        }
      | {
          /** @constant */
          kind: 'output';
          resourceId: string;
          /** @enum {unknown} */
          stream: 'stdout' | 'stderr';
          text: string;
        };
    FileExportParsing:
      | {
          /** @constant */
          format: 'csv';
          header: boolean;
          /** @enum {unknown} */
          delimiter: ',' | '\t' | ';' | '|';
        }
      | {
          /** @enum {unknown} */
          format: 'parquet' | 'lines';
        };
    FileExportPreparationInput: {
      source: components['schemas']['FileExportSource'];
      parsing: components['schemas']['FileExportParsing'];
    };
    FileExportPreparation: {
      preparationId: string;
      expiresAt: string;
      fields: {
        source: string;
        name: string;
        /** @enum {unknown} */
        type: 'TEXT' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN';
      }[];
      rows: {
        [key: string]: unknown;
      }[];
      rowCount: number;
      sourceVersion: string;
      inputBytes: number;
      /** @enum {unknown} */
      format: 'csv' | 'parquet' | 'lines';
    };
    FileExportInput:
      | {
          source: {
            /** @constant */
            kind: 'original';
            resourceId: string;
            path: string;
          };
          target: {
            /** @constant */
            kind: 'filesystem';
            resourceId: string;
            path: string;
          };
        }
      | {
          source: {
            /** @constant */
            kind: 'output';
            resourceId: string;
            /** @enum {unknown} */
            stream: 'stdout' | 'stderr';
            text: string;
          };
          target:
            | {
                /** @constant */
                kind: 'download';
              }
            | {
                /** @constant */
                kind: 'filesystem';
                resourceId: string;
                path: string;
              };
        }
      | {
          preparationId: string;
          /** @constant */
          confirmed: true;
          fields: {
            source: string;
            name: string;
            /** @enum {unknown} */
            type: 'TEXT' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN';
          }[];
          target: {
            /** @constant */
            kind: 'database';
            resourceId: string;
            table: string;
          };
        };
    FileExportOutput:
      | {
          /** @constant */
          kind: 'download';
          filename: string;
          mimeType: string;
          content: string;
          bytes: number;
        }
      | {
          /** @constant */
          kind: 'filesystem';
          resourceId: string;
          path: string;
          bytes: number;
        }
      | {
          /** @constant */
          kind: 'database';
          resourceId: string;
          table: string;
          rowCount: number;
          columns: {
            name: string;
            type: string;
          }[];
        };
    DatabaseImportParsing:
      | {
          /** @constant */
          format: 'csv';
          header: boolean;
          /** @enum {unknown} */
          delimiter: ',' | '\t' | ';' | '|';
        }
      | {
          /** @constant */
          format: 'parquet';
        };
    DatabaseImportPreparationInput: {
      resourceId: string;
      source: {
        resourceId: string;
        path: string;
      };
      parsing: components['schemas']['DatabaseImportParsing'];
    };
    DatabaseImportInput: {
      resourceId: string;
      preparationId: string;
      /** @constant */
      confirmed: true;
      table: string;
      fields: {
        source: string;
        name: string;
        /** @enum {unknown} */
        type: 'TEXT' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN';
      }[];
    };
    DatabaseImportResult: {
      /** @constant */
      kind: 'database';
      resourceId: string;
      table: string;
      rowCount: number;
      columns: {
        name: string;
        type: string;
      }[];
    };
    QueryResult: {
      columns: string[];
      rows: {
        [key: string]: unknown;
      }[];
      rowCount: number;
      /** @enum {unknown} */
      mode: 'demo' | 'live';
      /** @description Live statement affected-row count; SELECT returns zero. */
      affectedRows?: number;
      durationMs: number;
    };
    DatabaseTable: {
      name: string;
      type: string;
    };
    TableList: {
      data: components['schemas']['DatabaseTable'][];
      truncated: boolean;
      /** @enum {unknown} */
      mode: 'demo' | 'live';
    };
    TableDetail: {
      name: string;
      type: string;
      /** @enum {unknown} */
      mode: 'demo' | 'live';
      query: string;
      columns: {
        name: string;
        type: string;
        nullable: boolean;
        default: string | null;
        key: string;
        extra: string;
      }[];
      indexes: {
        name: string;
        unique: boolean;
        columns: {
          name: string | null;
          position: number;
          prefixLength: number | null;
        }[];
      }[];
    };
    Workspace: {
      id: string;
      name: string;
      description: string;
      plan: string;
      /** Format: date-time */
      createdAt: string;
    };
    Profile: {
      name: string;
      email: string;
      role: string;
    };
    Event: {
      id: string;
      action: string;
      resource: string;
      resourceId?: string | null;
      actor: string;
      at: string;
      outcome: string;
    };
    Usage: {
      resourceId: string;
      name: string;
      /** @enum {unknown} */
      kind: 'mysql' | 'postgresql' | 'duckdb' | 'filesystem';
      storageBytes: number | null;
      storageLimitBytes: number | null;
      monthlyRU: number | null;
      monthlyRULimit: number | null;
      fileCount: number | null;
      measured: boolean;
    };
    Capability: {
      label: string;
      regions: ('aws-us-east-1' | 'aws-us-west-2' | 'automatic' | 'aws-ap-southeast-1')[];
      storageGiB: number | null;
      monthlyRU?: number | null;
      maxFiles?: number | null;
      preview: boolean;
      provider?: string;
      /** @description False when this resource provider is not configured or available. */
      available?: boolean;
    };
    Capabilities: {
      mysql: components['schemas']['Capability'];
      postgresql: components['schemas']['Capability'];
      duckdb: components['schemas']['Capability'];
      filesystem: components['schemas']['Capability'];
    };
    Bootstrap: {
      workspace: components['schemas']['Workspace'];
      profile: components['schemas']['Profile'];
      resources: components['schemas']['Resource'][];
      files: components['schemas']['File'][];
      keys: components['schemas']['Key'][];
      events: components['schemas']['Event'][];
      usage: components['schemas']['Usage'][];
      queryCount: number;
      capabilities: components['schemas']['Capabilities'];
      /** @enum {unknown} */
      mode: 'demo' | 'hybrid';
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
  listWorkspaces: {
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
            data: components['schemas']['Workspace'][];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data: components['schemas']['Workspace'];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getBootstrap: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
          'application/json': components['schemas']['Bootstrap'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listResources: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data: components['schemas']['Resource'][];
            capabilities: components['schemas']['Capabilities'];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  createResource: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional key for retry-safe creation. Reusing it with a different body returns 409. */
        'Idempotency-Key'?: string;
      };
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          /** @enum {unknown} */
          kind: 'mysql' | 'postgresql' | 'duckdb' | 'filesystem';
          /**
           * @description Choose a region supported by the resource kind in capabilities. Zero MySQL uses automatic provider assignment. The first supported region is the Console default.
           * @enum {string}
           */
          region: 'aws-us-east-1' | 'aws-us-west-2' | 'automatic' | 'aws-ap-southeast-1';
        };
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data?: components['schemas']['Resource'];
            /** @enum {unknown} */
            mode?: 'demo' | 'live';
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  tabularFilePreview: {
    parameters: {
      query: {
        resourceId: string;
        path: string;
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            resourceId: string;
            path: string;
            /** @enum {unknown} */
            format: 'csv' | 'parquet';
            /** @constant */
            readOnly: true;
            inputBytes: number;
            durationMs: number;
            fileVersion: string;
            columns: string[];
            columnTypes: string[];
            schema: {
              column_name: string;
              column_type: string;
            }[];
            rows: {
              [key: string]: unknown;
            }[];
            rowCount: number;
            /** @description Exact Parquet metadata row count; null for CSV. Not the sample count. */
            totalRows: string | null;
            typesInferred: boolean;
            truncated: boolean;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  fileAnalysisCapabilities: {
    parameters: {
      query: {
        resourceId: string;
        path: string;
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            /**
             * @description Default engine, retained for compatibility. Select from engines.
             * @enum {string|null}
             */
            engine: 'duckdb' | 'bash' | null;
            /** @description Supported analysis methods with individual availability. CSV offers both engines; Parquet only DuckDB; recognized text only Bash. Availability checks metadata, not successful parsing or UTF-8 decoding. */
            engines: {
              /** @enum {unknown} */
              engine: 'duckdb' | 'bash';
              available: boolean;
              reason: string;
              /** @description Bash only: the selected absolute Workspace path in its read-only virtual snapshot, working directory, and compatible aliases. The legacy alias is omitted when it would shadow the selected path or a parent directory. Not a host path or a mount of other files. */
              input?: {
                path: string;
                /** @constant */
                workingDirectory: '/workspace';
                aliases: string[];
                /**
                 * @description When present, Workspace sets FILE to input.path for each fresh Bash run. Use quoted "$FILE" or "${FILE}"; this is a Workspace convention, not a Bash built-in. Script assignments do not persist.
                 * @constant
                 */
                fileVariable?: 'FILE';
              };
            }[];
            format: string | null;
            /** @description Availability of the default engine. */
            available: boolean;
            /** @description Unavailable reason for the default engine. */
            reason: string;
            size: number;
            /** @constant */
            readOnly: true;
            limits: {
              /** @constant */
              inputBytes: 16777216;
              /** @constant */
              scriptBytes: 65536;
              /** @constant */
              outputBytes: 1048576;
              /** @constant */
              rows: 1000;
              /** @constant */
              timeoutMs: 15000;
              /** @constant */
              concurrency: 2;
              /** @constant */
              workerHeapMiB: 128;
              /** @constant */
              duckdbMemoryMB: 128;
            };
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  analyzeFile: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          resourceId: string;
          path: string;
          /** @enum {unknown} */
          engine: 'duckdb' | 'bash';
          sql?: string;
          command?: string;
        } & (
          | {
              /** @constant */
              engine?: 'duckdb';
            }
          | {
              /** @constant */
              engine?: 'bash';
            }
        );
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
            /** @enum {unknown} */
            engine: 'duckdb' | 'bash';
            resourceId: string;
            path: string;
            /** @constant */
            readOnly: true;
            inputBytes: number;
            durationMs: number;
            columns: string[];
            schema: {
              column_name: string;
              column_type: string;
            }[];
            columnTypes: string[];
            rows: {
              [key: string]: unknown;
            }[];
            rowCount: number;
            stdout: string;
            stderr: string;
            exitCode: number;
            /** @description Saved-byte digest when supported; compare with tabular preview. */
            fileVersion?: string;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listFiles: {
    parameters: {
      query: {
        resourceId: string;
        /** @description Directory to list. Drive9 defaults to root; omit for all local files. */
        path?: string;
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data: components['schemas']['File'][];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  writeFile: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          resourceId: string;
          /** @description Absolute virtual path. Parent directory must exist; traversal is rejected. */
          path: string;
          /** @enum {unknown} */
          type: 'file' | 'directory';
          /** @description Required for files; maximum 256 KiB of UTF-8 text and subject to the provider upload limit. */
          content?: string;
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
            data?: components['schemas']['File'];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  deleteFile: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          resourceId: string;
          path: string;
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
            deleted?: boolean;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  downloadFile: {
    parameters: {
      query: {
        resourceId: string;
        path: string;
        /** @description Returns JSON content or an unavailableReason. Never reads files larger than 128 KiB for preview. */
        preview?: '1';
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Attachment download, or JSON when preview=1. Local resources use /files instead. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/octet-stream': Blob;
          'application/json': {
            content?: string;
            size: number;
            unavailableReason?: string;
          };
        };
      };
      /** @description Request failed */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Request failed */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Request failed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Request failed */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Request failed */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Request failed */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  uploadFile: {
    parameters: {
      query: {
        resourceId: string;
        path: string;
      };
      header?: {
        /** @description Only create a new file; fail if the path exists. */
        'If-None-Match'?: '*';
      };
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/octet-stream': Blob;
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
            saved?: boolean;
            size?: number;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  retryDatabaseSetup: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data?: components['schemas']['Resource'];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listDatabaseTables: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
          'application/json': components['schemas']['TableList'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getDatabaseTable: {
    parameters: {
      query: {
        /** @description Exact table name in the current database; not a schema-qualified SQL expression. */
        name: string;
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
          'application/json': components['schemas']['TableDetail'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  previewDatabaseTable: {
    parameters: {
      query: {
        name: string;
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
          'application/json': components['schemas']['QueryResult'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  prepareDatabaseImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['DatabaseImportPreparationInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileExportPreparation'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  prepareDatabaseImportUpload: {
    parameters: {
      query: {
        resourceId: string;
        /** @description A basename of at most 255 UTF-8 bytes, not a File System path. */
        filename: string;
        format: 'csv' | 'parquet';
        /** @description Required for CSV; forbidden for Parquet. */
        header?: 'true' | 'false';
        /** @description Required for CSV; forbidden for Parquet. */
        delimiter?: ',' | '\t' | ';' | '|';
      };
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/octet-stream': Blob;
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileExportPreparation'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  commitDatabaseImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['DatabaseImportInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DatabaseImportResult'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  prepareFileExport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['FileExportPreparationInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileExportPreparation'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  exportFileContent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['FileExportInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileExportOutput'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  exportResult: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ResultExportInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResultExportOutput'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Export may have completed but its activity record could not be saved */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  executeQuery: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          resourceId: string;
          /** @description DuckDB only: query-scoped CSV/JSON/NDJSON/Parquet snapshots as files.NAME. Nonempty sources require files:read, files:analyze and every source File System grant in addition to database query access. SELECT only; 16 MiB combined input and a shared 15-second deadline. Sources are not persisted. */
          sources?: {
            /** @description Unique source table name in the per-query files catalog. */
            name: string;
            resourceId: string;
            /** @description Exact absolute Workspace file path; no globs, traversal, external URLs or native paths. */
            path: string;
          }[];
          /** @description Live Zero/DuckDB: one statement up to 64 KiB, a 15-second deadline, at most 1000 result rows / 1 MiB. queries:execute allows reads and writes under the internal database role. No persistent session or automatic retry. A timeout or result limit can leave writes committed; check before retrying. Demo resources accept only SELECT 1 [AS connected] or SELECT * FROM agent_events [LIMIT n]. */
          sql: string;
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
          'application/json': components['schemas']['QueryResult'];
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getUsage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data: components['schemas']['Usage'][];
            /** @constant */
            mode: 'demo';
            queryCount: number;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listEvents: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data: components['schemas']['Event'][];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  listKeys: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
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
            data: components['schemas']['Key'][];
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  createKey: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          scopes: (
            | 'resources:read'
            | 'resources:write'
            | 'files:read'
            | 'files:write'
            | 'files:analyze'
            | 'queries:execute'
            | 'usage:read'
          )[];
          /** @description Choose existing workspace resource IDs, or ["*"] for all current and future resources. Mixed wildcard and IDs are rejected. Resource creation additionally requires resources:write and ["*"]. */
          resourceIds: string[];
          /** @enum {unknown} */
          expiresInDays: 7 | 30 | 90;
        };
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            data: components['schemas']['Key'];
            /** @description Returned once. Only a SHA-256 digest is persisted. */
            secret: string;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  revokeKey: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
        keyId: string;
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
            revoked?: boolean;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  updateSettings: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description This local prototype has one workspace. */
        workspaceId: 'ws_agentlab';
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          workspaceName: string;
          name: string;
          description?: string;
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
            saved?: boolean;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  getHealth: {
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
            status: 'ok';
            /** @enum {unknown} */
            mode: 'demo' | 'hybrid';
            filesProvider: string;
          };
        };
      };
      /** @description Configured metadata authority is unavailable; no fallback state is seeded */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
    };
  };
  createLocalSession: {
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
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @constant */
            workspaceId: 'ws_agentlab';
            /** @constant */
            mode: 'demo';
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Missing, invalid, expired, or revoked credential */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Insufficient permission */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Resource or endpoint not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Conflict or free-tier limit */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Temporary database expired */
      410: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Content too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Unsupported content type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL syntax, result limit, or unsupported demo query */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider quota or rate limit */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider unavailable or invalid response */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description Provider binding needs operator recovery */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Error'];
        };
      };
      /** @description SQL timeout; a write outcome may be unknown */
      504: {
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
