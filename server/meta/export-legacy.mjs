import { mkdir, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createMetaClient, privateJson } from './client.mjs';
import { documentScope, decodeDocument, legacyDocuments } from './document-store.mjs';

export async function exportLegacy({ configFile, directory, targetFrozen = false }) {
  if (!targetFrozen) throw new Error('Stop and drain every target writer before rollback export.');
  const config = await privateJson(configFile);
  const client = await createMetaClient(config.region);
  try {
    const gateScope = {
      authorityId: config.region.authorityId,
      ownerKind: 'system',
      ownerId: 'compatibility',
      family: 'legacy-gateway',
      partitionId: config.workspaceId,
    };
    const ownership = await client.call({ op: 'snapshot', scope: gateScope });
    const gateway = ownership.records.ownerId
      ? { scope: gateScope, ownerId: ownership.records.ownerId }
      : undefined;
    const documents = [];
    for (const name of legacyDocuments) {
      const snapshot = await client.call({
        op: 'snapshot',
        ...(gateway ? { gateway } : {}),
        scope: documentScope(config.region.authorityId, config.workspaceId, name),
      });
      documents.push(decodeDocument(snapshot));
    }
    directory = resolve(directory);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const names = [
      'workspace.json',
      'workspace.json.providers.json',
      'workspace.json.databases.json',
      'workspace.json.duckdb.json',
      'workspace.json.db9.json',
    ];
    for (let i = 0; i < names.length; i++) {
      const file = await open(resolve(directory, names[i]), 'wx', 0o600);
      try {
        await file.writeFile(documents[i]);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const manifest = await open(resolve(directory, 'manifest.json'), 'wx', 0o600);
    try {
      await manifest.writeFile(
        JSON.stringify({
          format: 1,
          workspaceId: config.workspaceId,
          importId: config.importId,
          files: names,
        }),
      );
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    const folder = await open(directory, 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
    const parent = await open(dirname(directory), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return { exported: true, documents: documents.length };
  } finally {
    client.close();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      directory: { type: 'string' },
      'target-frozen': { type: 'boolean' },
    },
  });
  try {
    console.log(
      JSON.stringify(
        await exportLegacy({
          configFile: values.config,
          directory: values.directory,
          targetFrozen: values['target-frozen'],
        }),
      ),
    );
  } catch {
    console.error(
      'Rollback export did not complete; keep the target frozen and preserve all state.',
    );
    process.exitCode = 1;
  }
}
