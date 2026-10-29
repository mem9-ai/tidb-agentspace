import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { privateJson } from './client.mjs';
import { startServer } from '../index.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    source: { type: 'string' },
    'provider-config': { type: 'string' },
    port: { type: 'string' },
  },
});
const allowed = new Set([
  'WORKSPACE_FILES_PROVIDER',
  'WORKSPACE_MYSQL_PROVIDER',
  'WORKSPACE_POSTGRES_PROVIDER',
  'WORKSPACE_DUCKDB_EXTENSION',
  'WORKSPACE_DUCKDB_EXTENSION_SHA256',
]);
if (values['provider-config']) {
  const configuration = await privateJson(resolve(values['provider-config']));
  for (const [key, value] of Object.entries(configuration)) {
    if (!allowed.has(key) || typeof value !== 'string')
      throw new Error('Unsupported provider runtime setting.');
    process.env[key] = value;
  }
}
const server = await startServer({
  metaConfig: resolve(values.config),
  dataFile: resolve(values.source),
  port: Number(values.port || 4318),
});
const stop = () => {
  server.close(() => {});
  server.closeIdleConnections();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
