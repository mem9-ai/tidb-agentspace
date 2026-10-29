import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySqlDependencies } from './sql-runtime-dependencies.mjs';

export const runtimeFiles = [
  'server/index.mjs',
  'server/result-exports.mjs',
  'server/export-authorization.mjs',
  'server/file-exports.mjs',
  'server/file-export-contract.mjs',
  'server/import-fields.mjs',
  'server/file-import-reader.mjs',
  'server/database-browser.mjs',
  'server/database-identifiers.mjs',
  'server/duckdb-browser.mjs',
  'server/postgres-browser.mjs',
  'server/providers/db9.mjs',
  'server/providers/postgres-driver.mjs',
  'server/duckdb-sources.mjs',
  'server/file-analysis-contract.mjs',
  'server/file-analysis-snapshot.mjs',
  'server/file-analysis.mjs',
  'server/file-analysis-worker.mjs',
  'server/store.mjs',
  'server/access-policy.mjs',
  'server/file-transfer.mjs',
  'server/http-policy.mjs',
  'server/providers/drive9.mjs',
  'server/providers/zero.mjs',
  'server/providers/duckdb.mjs',
  'server/providers/duckdb-engine.mjs',
  'server/providers/duckdb-worker.mjs',
  'server/providers/duckdb-catalog.mjs',
  'server/providers/sql-common.mjs',
  'server/providers/sql-drivers.mjs',
  'public/openapi.json',
];

export async function buildApi({ root, destination = resolve(root, 'dist/api') }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const path of runtimeFiles) {
    const target = resolve(destination, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(resolve(root, path), target);
  }
  await copySqlDependencies(root, destination);
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  await writeFile(
    resolve(destination, 'package.json'),
    JSON.stringify(
      {
        name: 'tidb-workspace-api',
        version: pkg.version,
        private: true,
        type: 'module',
        engines: pkg.engines,
        scripts: { start: 'node server/index.mjs' },
      },
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildApi({ root: fileURLToPath(new URL('../', import.meta.url)) });
  console.log('Standalone API built in dist/api (Node only; no frontend dependencies).');
}
