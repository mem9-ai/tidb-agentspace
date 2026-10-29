import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRustApi } from './start-rust-api.mjs';

test('default API launcher rejects missing or non-API configuration without starting a fallback writer', async () => {
  await assert.rejects(startRustApi(), /WORKSPACE_BACKEND_CONFIG/);
  await assert.rejects(startRustApi({ configFile: 'relative.json' }), /absolute/);
  const directory = await mkdtemp(join(tmpdir(), 'rust-launcher-'));
  try {
    const configFile = join(directory, 'deployment.json');
    await writeFile(configFile, JSON.stringify({ format: 1, services: [] }), { mode: 0o600 });
    await assert.rejects(startRustApi({ configFile }), /Workspace API role/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
