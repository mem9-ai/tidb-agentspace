import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createMetaClient, privateJson } from './client.mjs';
import {
  legacyDocuments,
  documentScope,
  encodeDocument,
  decodeDocument,
} from './document-store.mjs';

const suffixes = ['', '.providers.json', '.databases.json', '.duckdb.json', '.db9.json'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const systemScope = (authorityId, family, partitionId) => ({
  authorityId,
  ownerKind: 'system',
  ownerId: 'migration',
  family,
  partitionId,
});
async function durableFile(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function sourceBytes(path, optional) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error('Source state and credentials require owner-only ordinary files.');
    const bytes = await readFile(path);
    JSON.parse(bytes);
    return bytes;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function inventory(bytes) {
  const state = JSON.parse(bytes[0]);
  if (
    !state.workspace?.id ||
    !Array.isArray(state.resources) ||
    !Array.isArray(state.keys) ||
    !Array.isArray(state.files)
  )
    throw new Error('Invalid legacy Workspace state.');
  const vaults = bytes.slice(1).map((b) => (b ? JSON.parse(b) : { bindings: {} }));
  const index = new Map([
    ['drive9-anonymous', 0],
    ['tidb-cloud-zero', 1],
    ['duckdb-drive9', 2],
    ['db9-anonymous', 3],
  ]);
  const ids = new Set();
  for (const resource of state.resources) {
    if (ids.has(resource.id) || typeof resource.id !== 'string')
      throw new Error('Duplicate or invalid legacy resource identity.');
    ids.add(resource.id);
    if (
      index.has(resource.provider) &&
      !vaults[index.get(resource.provider)]?.bindings?.[resource.id]
    )
      throw new Error('A public live resource has no recoverable binding; migration stopped.');
  }
  for (const binding of Object.values(vaults[2].bindings || {}))
    if (!binding.storageId || !vaults[0].bindings?.[binding.storageId])
      throw new Error('DuckDB private storage is missing; migration stopped.');
  return { state, vaults };
}

export async function migrateLegacy({
  sourceFile,
  backupDirectory,
  configFile,
  sourceFrozen = false,
  runtimeFiles = [],
}) {
  if (!sourceFrozen)
    throw new Error('Stop and drain every legacy writer before importing (--source-frozen).');
  sourceFile = resolve(sourceFile);
  backupDirectory = resolve(backupDirectory);
  const config = await privateJson(configFile);
  if (
    config.format !== 1 ||
    !config.importId ||
    config.global?.authorityId !== 'global' ||
    !config.region?.authorityId?.startsWith('region:') ||
    !config.regionStorage
  )
    throw new Error(
      'Migration needs distinct Global/Region configurations and a private storage descriptor.',
    );
  const bytes = await Promise.all(
    suffixes.map((suffix, i) => sourceBytes(sourceFile + suffix, i > 0)),
  );
  const { state, vaults } = inventory(bytes);
  if (state.workspace.id !== config.workspaceId) throw new Error('Workspace identity mismatch.');
  const sourceTag = hash(Buffer.from(JSON.stringify(bytes.map((b) => (b ? hash(b) : null)))));
  const lock = sourceFile + '.meta-migration-lock';
  try {
    await mkdir(lock, { mode: 0o700 });
    await durableFile(
      resolve(lock, 'owner.json'),
      JSON.stringify({ importId: config.importId, sourceTag }),
    );
    await syncDirectory(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await privateJson(resolve(lock, 'owner.json'));
    if (owner.importId !== config.importId || owner.sourceTag !== sourceTag)
      throw new Error('Migration ownership/source changed.', { cause: error });
  }
  const manifest = {
    format: 1,
    importId: config.importId,
    workspaceId: config.workspaceId,
    sourceTag,
    sources: bytes.map((b, i) => ({
      name: legacyDocuments[i],
      present: !!b,
      digest: b ? hash(b) : null,
    })),
  };
  await mkdir(dirname(backupDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(backupDirectory, { mode: 0o700 });
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i])
        await durableFile(resolve(backupDirectory, legacyDocuments[i] + '.json'), bytes[i]);
    for (let i = 0; i < runtimeFiles.length; i++) {
      const source = resolve(runtimeFiles[i]);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Runtime backup requires ordinary files.');
      await durableFile(resolve(backupDirectory, `runtime-${i}.json`), await readFile(source));
    }
    await durableFile(resolve(backupDirectory, 'manifest.json'), JSON.stringify(manifest));
    await syncDirectory(backupDirectory);
    await syncDirectory(resolve(backupDirectory, '..'));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await privateJson(resolve(backupDirectory, 'manifest.json'));
    if (JSON.stringify(previous) !== JSON.stringify(manifest))
      throw new Error('Backup belongs to a different import/source.', { cause: error });
  }
  for (let i = 0; i < bytes.length; i++) {
    if (
      bytes[i] &&
      hash(await readFile(resolve(backupDirectory, legacyDocuments[i] + '.json'))) !==
        hash(bytes[i])
    )
      throw new Error('Backup verification failed.');
    const now = await sourceBytes(sourceFile + suffixes[i], i > 0);
    if ((now ? hash(now) : null) !== (bytes[i] ? hash(bytes[i]) : null))
      throw new Error('Source changed during freeze; import aborted.');
  }
  const clients = [];
  try {
    const global = await createMetaClient(config.global);
    clients.push(global);
    const region = await createMetaClient(config.region);
    clients.push(region);
    const controlScope = systemScope(config.region.authorityId, 'imports', config.importId);
    let control = await region.call({ op: 'snapshot', scope: controlScope });
    if (control.revision && control.records.sourceTag !== sourceTag)
      throw new Error('Import identity reused with a different source.');
    if (control.records.status === 'verified')
      return { verified: true, replayed: true, importId: config.importId };
    if (!control.revision)
      await region.call({
        op: 'commit',
        scope: controlScope,
        expectedRevision: null,
        mutationId: randomUUID(),
        changes: [
          { key: 'sourceTag', value: sourceTag },
          { key: 'workspaceId', value: config.workspaceId },
          { key: 'status', value: 'importing' },
        ],
      });
    for (let i = 0; i < bytes.length; i++) {
      const scope = documentScope(
        config.region.authorityId,
        config.workspaceId,
        legacyDocuments[i],
      );
      const document = bytes[i] || Buffer.from('{"bindings":{}}');
      let current = await region.call({ op: 'snapshot', scope });
      if (!current.revision) {
        await region.call({
          op: 'commit',
          scope,
          expectedRevision: null,
          mutationId: randomUUID(),
          changes: encodeDocument(document),
        });
        current = await region.call({ op: 'snapshot', scope });
      }
      if (!decodeDocument(current).equals(document))
        throw new Error('Imported state/credential bytes differ; activation blocked.');
    }
    const catalogScope = systemScope('global', 'imports', config.importId);
    const catalog = await global.call({ op: 'snapshot', scope: catalogScope });
    if (catalog.revision && catalog.records.sourceTag !== sourceTag)
      throw new Error('Global import identity conflict.');
    if (!catalog.revision) {
      const resources = state.resources.map((resource) =>
        Object.fromEntries(
          ['id', 'name', 'kind', 'provider', 'region', 'status', 'expiresAt']
            .filter((k) => Object.hasOwn(resource, k))
            .map((k) => [k, resource[k]]),
        ),
      );
      await global.call({
        op: 'commit',
        scope: catalogScope,
        expectedRevision: null,
        mutationId: randomUUID(),
        changes: [
          { key: 'sourceTag', value: sourceTag },
          { key: 'workspaceId', value: config.workspaceId },
          { key: 'resources', value: resources },
          { key: 'regionalInstallationId', value: config.region.installationId },
          { key: 'metadataDeployment', value: config.regionStorage },
          { key: 'status', value: 'verified' },
        ],
      });
    }
    control = await region.call({ op: 'snapshot', scope: controlScope });
    await region.call({
      op: 'commit',
      scope: controlScope,
      expectedRevision: control.revision,
      mutationId: randomUUID(),
      changes: [{ key: 'status', value: 'verified' }],
    });
    return {
      verified: true,
      importId: config.importId,
      resources: state.resources.length,
      keys: state.keys.length,
      files: state.files.length,
      bindings: vaults.map((v) => Object.keys(v.bindings || {}).length),
    };
  } finally {
    clients.forEach((c) => c.close());
  }
}

export async function inspectLegacy({ sourceFile, configFile }) {
  const config = await privateJson(configFile);
  const bytes = await Promise.all(
    suffixes.map((suffix, i) => sourceBytes(resolve(sourceFile) + suffix, i > 0)),
  );
  const { state, vaults } = inventory(bytes);
  if (config.workspaceId !== state.workspace.id) throw new Error('Workspace identity mismatch.');
  return {
    dryRun: true,
    resources: state.resources.length,
    keys: state.keys.length,
    files: state.files.length,
    bindings: vaults.map((v) => Object.keys(v.bindings || {}).length),
    executionAuthority: config.region.authorityId,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      backup: { type: 'string' },
      config: { type: 'string' },
      'source-frozen': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'runtime-file': { type: 'string', multiple: true, default: [] },
    },
  });
  try {
    const result = values['dry-run']
      ? await inspectLegacy({ sourceFile: values.source, configFile: values.config })
      : await migrateLegacy({
          sourceFile: values.source,
          backupDirectory: values.backup,
          configFile: values.config,
          sourceFrozen: values['source-frozen'],
          runtimeFiles: values['runtime-file'],
        });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      'Migration did not activate: inspect the private backup/source and retry with the same import identity.',
    );
    process.exitCode = 1;
  }
}
