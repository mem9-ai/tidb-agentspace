import { createHash, randomUUID } from 'node:crypto';
import { createMetaClient, privateJson, metaError } from './client.mjs';

export const legacyDocuments = ['workspace', 'drive9', 'zero', 'duckdb', 'db9'];
export function documentScope(authorityId, workspaceId, name) {
  if (!legacyDocuments.includes(name)) throw metaError('META_INVALID_DOCUMENT', 400);
  return {
    authorityId,
    ownerKind: 'workspace',
    ownerId: workspaceId,
    family: 'legacy-document',
    partitionId: name,
  };
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function encodeDocument(bytes, previous = {}) {
  if (bytes.length > 12 * 1024 * 1024) throw metaError('META_LEGACY_DOCUMENT_TOO_LARGE', 413);
  const records = { descriptor: { format: 1, size: bytes.length, digest: digest(bytes) } };
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
    records[`chunk-${String(offset / (64 * 1024)).padStart(5, '0')}`] = bytes
      .subarray(offset, offset + 64 * 1024)
      .toString('base64');
  return [
    ...Object.entries(records).map(([key, value]) => ({ key, value })),
    ...Object.keys(previous)
      .filter((key) => !Object.hasOwn(records, key))
      .map((key) => ({ key, delete: true })),
  ];
}
export function decodeDocument(snapshot) {
  if (!snapshot.revision || snapshot.records.descriptor?.format !== 1)
    throw metaError('META_DOCUMENT_MISSING');
  const { descriptor, ...chunks } = snapshot.records;
  const keys = Object.keys(chunks).sort();
  for (let i = 0; i < keys.length; i++)
    if (keys[i] !== `chunk-${String(i).padStart(5, '0')}` || typeof chunks[keys[i]] !== 'string')
      throw metaError('META_DOCUMENT_CORRUPT');
  const bytes = Buffer.concat(keys.map((key) => Buffer.from(chunks[key], 'base64')));
  if (bytes.length !== descriptor.size || digest(bytes) !== descriptor.digest)
    throw metaError('META_DOCUMENT_CORRUPT');
  JSON.parse(bytes);
  return bytes;
}
export async function createDocumentStore(client, scope) {
  let state;
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };
  const load = async () => {
    const snapshot = await client.call({ op: 'snapshot', scope });
    state = JSON.parse(decodeDocument(snapshot));
    return snapshot;
  };
  await load();
  return {
    read: () => structuredClone(state),
    refresh: () => enqueue(load),
    mutate: (fn) =>
      enqueue(async () => {
        const current = await load();
        const draft = structuredClone(state);
        const result = await fn(draft);
        // Do not replay business callbacks after conflict or an indeterminate commit.
        await client.call({
          op: 'commit',
          scope,
          expectedRevision: current.revision,
          mutationId: randomUUID(),
          changes: encodeDocument(Buffer.from(JSON.stringify(draft)), current.records),
        });
        state = draft;
        return result;
      }),
  };
}
export async function createMetaStoreFactory(path, dataFile) {
  const config = await privateJson(path);
  if (
    config.format !== 1 ||
    config.workspaceId !== 'ws_agentlab' ||
    !config.region.authorityId.startsWith('region:') ||
    config.region.authorityId === config.global?.authorityId
  )
    throw new Error('Configure distinct global and regional metadata authorities.');
  const client = await createMetaClient(config.region);
  const controlScope = {
    authorityId: config.region.authorityId,
    ownerKind: 'system',
    ownerId: 'migration',
    family: 'imports',
    partitionId: config.importId,
  };
  const control = await client.call({ op: 'snapshot', scope: controlScope });
  if (control.records.status !== 'verified' || control.records.workspaceId !== config.workspaceId) {
    client.close();
    throw metaError('META_IMPORT_NOT_VERIFIED');
  }
  if (!client.capabilities.includes('legacyGatewayFencing')) {
    client.close();
    throw metaError('META_PROTOCOL_UNSUPPORTED');
  }
  const gatewayScope = {
    authorityId: config.region.authorityId,
    ownerKind: 'system',
    ownerId: 'compatibility',
    family: 'legacy-gateway',
    partitionId: config.workspaceId,
  };
  const prior = await client.call({ op: 'snapshot', scope: gatewayScope });
  if (prior.records.ownerId && config.recoverGatewayOwner !== prior.records.ownerId) {
    client.close();
    throw metaError('META_GATEWAY_ACTIVE');
  }
  const ownerId = randomUUID();
  await client.call({
    op: 'commit',
    scope: gatewayScope,
    expectedRevision: prior.revision,
    mutationId: randomUUID(),
    changes: [{ key: 'ownerId', value: ownerId }],
  });
  const guarded = {
    ...client,
    call: (input) => client.call({ ...input, gateway: { scope: gatewayScope, ownerId } }),
  };
  let closing;
  const close = () =>
    (closing ||= (async () => {
      try {
        const current = await client.call({ op: 'snapshot', scope: gatewayScope });
        if (current.records.ownerId === ownerId)
          await client.call({
            op: 'commit',
            scope: gatewayScope,
            expectedRevision: current.revision,
            mutationId: randomUUID(),
            changes: [{ key: 'ownerId', value: null }],
          });
      } finally {
        client.close();
      }
    })());
  const names = new Map([
    [dataFile, 'workspace'],
    [dataFile + '.providers.json', 'drive9'],
    [dataFile + '.databases.json', 'zero'],
    [dataFile + '.duckdb.json', 'duckdb'],
    [dataFile + '.db9.json', 'db9'],
  ]);
  const factory = async (file) => {
    const name = names.get(file);
    if (!name) throw metaError('META_DOCUMENT_UNREGISTERED');
    try {
      return await createDocumentStore(
        guarded,
        documentScope(config.region.authorityId, config.workspaceId, name),
      );
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  };
  factory.close = close;
  return factory;
}
