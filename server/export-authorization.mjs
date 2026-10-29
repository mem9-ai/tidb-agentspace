import { canAccessResource } from './access-policy.mjs';

// Current principal/grants are read again at every write, never captured from preparation.
export function createExportAuthorizer({
  readState,
  sessions,
  sessionToken,
  isOwner,
  principalId,
  providers,
  fail,
}) {
  return ({ sourceResourceId, target }, { readOnlySource = false, fileSource = false } = {}) => {
    const state = readState();
    const key = isOwner ? undefined : state.keys.find((item) => item.id === principalId);
    if (
      isOwner
        ? (sessions.get(sessionToken) || 0) <= Date.now()
        : !key || key.revokedAt || Date.parse(key.expiresAt) <= Date.now()
    )
      fail(401, 'INVALID_KEY', 'The session or key is invalid, expired, or revoked.');
    const resource = (id) => {
      if (!isOwner && !canAccessResource(key.resourceIds, id))
        fail(403, 'RESOURCE_ACCESS_DENIED', 'This key cannot access a selected export resource.');
      const selected = state.resources.find((item) => item.id === id);
      if (!selected) fail(404, 'NOT_FOUND', 'Export resource not found.');
      return selected;
    };
    const scope = (action) => {
      if (!isOwner && !key.scopes.includes(action))
        fail(403, 'INSUFFICIENT_SCOPE', `This action requires ${action}.`);
    };
    const source = resource(sourceResourceId);
    if (
      fileSource &&
      (source.kind !== 'filesystem' ||
        ![undefined, 'local', providers.filesystem].includes(source.provider))
    )
      fail(400, 'INVALID_EXPORT_SOURCE', 'Select a public File System.');
    for (const action of source.kind === 'filesystem'
      ? readOnlySource
        ? ['files:read']
        : ['files:read', 'files:analyze']
      : ['queries:execute'])
      scope(action);
    if (fileSource && source.status !== 'active')
      fail(409, 'FILESYSTEM_UNAVAILABLE', 'This File System is not active.');
    if (target.kind === 'download') return source;
    const destination = resource(target.resourceId);
    if (target.kind === 'filesystem') {
      scope('files:write');
      if (
        destination.kind !== 'filesystem' ||
        ![undefined, 'local', providers.filesystem].includes(destination.provider)
      )
        fail(400, 'INVALID_EXPORT_TARGET', 'Select a public File System.');
    } else {
      scope('queries:execute');
      const provider = providers[destination.kind];
      if (destination.kind === 'filesystem' || !provider || destination.provider !== provider)
        fail(
          400,
          'INVALID_EXPORT_TARGET',
          'Select a live database. Demo databases do not accept exports.',
        );
    }
    if (destination.status !== 'active')
      fail(409, 'EXPORT_TARGET_UNAVAILABLE', 'Wait until the export destination is active.');
    return destination;
  };
}
