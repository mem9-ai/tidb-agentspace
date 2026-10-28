export type QueryDraft = { sql: string; generatedSql: string; pendingSql: string | null };
export type QueryDraftAction =
  | { type: 'edit'; sql: string }
  | { type: 'queryTable'; sql: string }
  | { type: 'replace' }
  | { type: 'cancel' };
export function createQueryDraft(sql: string): QueryDraft {
  return { sql, generatedSql: sql, pendingSql: null };
}
export function queryDraftReducer(state: QueryDraft, action: QueryDraftAction): QueryDraft {
  switch (action.type) {
    case 'edit':
      return { ...state, sql: action.sql };
    case 'queryTable':
      if (action.sql === state.sql) return state;
      return state.sql.trim() && state.sql !== state.generatedSql
        ? { ...state, pendingSql: action.sql }
        : createQueryDraft(action.sql);
    case 'replace':
      return state.pendingSql === null ? state : createQueryDraft(state.pendingSql);
    case 'cancel':
      return { ...state, pendingSql: null };
  }
}
