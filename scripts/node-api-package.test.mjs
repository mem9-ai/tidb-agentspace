import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildApi } from './build-api.mjs';
import { seed } from '../server/store.mjs';

test(
  'hosted Node closure boots independently with SSO and preserves its existing JSON state',
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'workspace-hosted-package-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const destination = resolve(directory, 'api');
    await buildApi({ root: resolve('.'), destination });
    await assert.rejects(access(resolve(destination, 'src')));
    await assert.rejects(access(resolve(destination, '.data')));
    const original = JSON.stringify({ ...seed(), profile: { name: 'Persisted operator' } });
    const dataFile = resolve(directory, 'existing.json');
    await writeFile(dataFile, original, { mode: 0o600 });
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: destination,
      env: {
        PATH: process.env.PATH,
        WORKSPACE_API_PORT: '0',
        WORKSPACE_DATA_FILE: dataFile,
        TIDB_SSO_ISSUER: 'https://identity.example.invalid/',
        TIDB_SSO_CLIENT_ID: 'fixture-public-client',
        TIDB_SSO_REDIRECT_URI: 'http://127.0.0.1:4318/studio/api/auth/tidbcloud/callback',
        WORKSPACE_PUBLIC_PATH: '/studio',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((done) => {
        child.once('exit', done);
        child.kill('SIGTERM');
      });
    });
    const origin = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Packaged Node API did not become ready.')),
        15000,
      );
      let output = '',
        errors = '';
      child.stderr.on('data', (chunk) => (errors += chunk));
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Workspace API: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Packaged API exited ${code}: ${errors}`));
      });
      child.once('error', reject);
    });
    assert.equal((await fetch(origin + '/api/health')).status, 200);
    const config = await fetch(origin + '/api/auth/config');
    assert.equal((await config.json()).enabled, true);
    const anonymous = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(anonymous.status, 403);
    assert.equal((await anonymous.json()).error.code, 'SSO_REQUIRED');
    const imported = await fetch(
      origin + '/api/v1/workspaces/ws_agentlab/database-imports/prepare-upload?resourceId=x',
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'id\n1\n' },
    );
    assert.equal(imported.status, 401);
    assert.equal(await readFile(dataFile, 'utf8'), original);
  },
);
