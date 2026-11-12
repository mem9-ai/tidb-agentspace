import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdk = resolve(process.argv[2]);
const { connectWorkspace } = await import(pathToFileURL(resolve(sdk, 'workspace-agent.mjs')));
const config = JSON.parse(readFileSync(0, 'utf8'));
const client = await connectWorkspace({ endpoint: config.endpoint, apiKey: config.sdkKey });
const ids = (await client.listResources()).data.map((item) => item.id).sort();
assert.deepEqual(ids, ['db_pg', 'fs_shared']);
assert.deepEqual((await client.query('db_pg', 'SELECT 1 AS value')).rows, [{ value: 1 }]);
assert.ok((await client.listFiles('fs_shared')).data.some((item) => item.path === '/sdk.txt'));
execFileSync('python3', ['-IB', 'tools/agent-client-tests/workspace_client.py', sdk], {
  input: JSON.stringify(config),
  timeout: 60_000,
  stdio: ['pipe', 'inherit', 'inherit'],
});
