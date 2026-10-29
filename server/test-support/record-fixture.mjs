import { createHash, randomUUID } from 'node:crypto';
export const workspaceScope = (authorityId, workspaceId = 'ws_agentlab') => ({
  authorityId,
  ownerKind: 'workspace',
  ownerId: workspaceId,
  family: 'workspace',
  partitionId: 'primary',
});
export async function seedRecords(client, authorityId, state, providers = {}) {
  const records = [];
  const put = (key, value) => records.push({ key, value, expectedVersion: null });
  for (const [family, value] of Object.entries(state)) {
    if (['resources', 'keys', 'files', 'events'].includes(family))
      value.forEach((record, index) =>
        put(`state/${family}/${record.id}`, {
          position: family === 'events' ? value.length - index : index,
          record,
        }),
      );
    else if (['idempotency', 'resourceQueryCounts'].includes(family))
      for (const [key, row] of Object.entries(value))
        put(`state/${family}/${createHash('sha256').update(key).digest('hex')}`, {
          mapKey: key,
          record: row,
        });
    else put('state/' + family, value);
  }
  for (const key of state.keys) put('indexes/key-digest/' + key.digest, key.id);
  for (const [provider, stored] of Object.entries(providers)) {
    for (const [id, value] of Object.entries(stored.bindings || {})) {
      const metadata = {},
        credentials = {};
      for (const [key, row] of Object.entries(value))
        (['state', 'storageId', 'instanceId', 'expiresAt', 'name', 'role', 'user'].includes(key)
          ? metadata
          : credentials)[key] = row;
      if (Object.keys(credentials).length) {
        metadata.credentialRef = `credentials/${provider}/${id}`;
        put(metadata.credentialRef, credentials);
      }
      put(`bindings/${provider}/${id}`, metadata);
    }
    if (stored.account) put(`credentials/accounts/${provider}`, stored.account);
  }
  const scope = workspaceScope(authorityId, state.workspace.id);
  for (let i = 0; i < records.length; i += 100)
    await client.call({
      op: 'commit',
      scope,
      mutationId: randomUUID(),
      changes: records.slice(i, i + 100),
    });
}
export async function readState(client, authorityId, workspaceId = 'ws_agentlab', guard) {
  const state = {
    resources: [],
    keys: [],
    files: [],
    events: [],
    idempotency: {},
    resourceQueryCounts: {},
  };
  let after = null;
  do {
    const page = await client.call({
      op: 'list',
      scope: workspaceScope(authorityId, workspaceId),
      prefix: 'state/',
      after,
      limit: 100,
      ...(guard ? { guard } : {}),
    });
    for (const { key, value } of page.records) {
      const [family, ...parts] = key.slice(6).split('/');
      if (!parts.length) state[family] = value;
      else if (Array.isArray(state[family])) state[family].push(value);
      else state[family][value.mapKey] = value.record;
    }
    after = page.nextCursor;
  } while (after);
  for (const family of ['resources', 'keys', 'files', 'events']) {
    state[family].sort((a, b) => a.position - b.position);
    if (family === 'events') state[family].reverse();
    state[family] = state[family].map((r) => r.record);
  }
  return state;
}
export async function readBinding(client, authorityId, provider, id) {
  const paths = [`bindings/${provider}/${id}`, `credentials/${provider}/${id}`];
  const { records } = await client.call({
    op: 'get',
    scope: workspaceScope(authorityId),
    keys: paths,
  });
  const value = { ...records[paths[0]]?.value, ...records[paths[1]]?.value };
  delete value.credentialRef;
  return value;
}
