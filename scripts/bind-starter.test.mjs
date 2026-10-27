import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../server/store.mjs';
import { bindStarter } from './bind-starter.mjs';

test('operator binding verifies the connection and privilege boundary before changing public metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'workspace.json');
  const connectionFile = join(directory, 'connection.json');
  const initial = seed();
  await writeFile(dataFile, JSON.stringify(initial));
  const binding = {
    kind: 'mysql',
    region: 'aws-us-east-1',
    host: 'gateway.test.tidbcloud.com',
    port: 4000,
    user: 'app',
    password: 'test-private-password',
    database: 'app',
  };
  await writeFile(connectionFile, JSON.stringify(binding), { mode: 0o600 });
  const params = { dataFile, resourceId: 'db_memory', connectionFile };
  await assert.rejects(
    bindStarter({
      ...params,
      execute: async () => {
        throw new Error('offline');
      },
    }),
  );
  assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')), initial);
  await assert.rejects(
    bindStarter({
      ...params,
      execute: async () => ({ rows: [{ grant: 'GRANT ALL PRIVILEGES ON *.* TO app' }] }),
    }),
  );
  assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')), initial);
  await bindStarter({
    ...params,
    execute: async () => ({
      rows: [
        { grant: 'GRANT USAGE ON *.* TO app' },
        { grant: 'GRANT SELECT, INSERT ON `app`.* TO app' },
      ],
    }),
  });
  const current = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(current.resources[0].provider, 'tidb-cloud-starter');
  assert.deepEqual(current.resources.slice(1), initial.resources.slice(1));
  assert.deepEqual(current.files, initial.files);
  assert.deepEqual(current.keys, initial.keys);
  assert.ok(!JSON.stringify(current).includes(binding.password));
  assert.equal(
    JSON.parse(await readFile(dataFile + '.databases.json', 'utf8')).bindings.db_memory.password,
    binding.password,
  );
});

test('PG binding rejects privileged role membership before persisting any credential', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-pg-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'workspace.json');
  const connectionFile = join(directory, 'connection.json');
  const initial = seed();
  await writeFile(dataFile, JSON.stringify(initial));
  await writeFile(
    connectionFile,
    JSON.stringify({
      kind: 'postgresql',
      region: 'aws-us-east-1',
      host: 'gateway.test.tidbcloud.com',
      port: 5432,
      user: 'app',
      password: 'private-pg-test',
      database: 'app',
    }),
    { mode: 0o600 },
  );
  let unsafe = true;
  const options = {
    dataFile,
    resourceId: 'db_vectors',
    connectionFile,
    execute: async (_binding, sql) => {
      if (sql === 'SELECT 1 AS connected') return { rows: [{ connected: 1 }] };
      assert.ok(sql.includes('pg_execute_server_program'));
      assert.ok(sql.includes('pg_read_all_data'));
      assert.ok(sql.includes("pg_has_role(current_user, oid, 'MEMBER')"));
      return { rows: [{ unsafe_roles: unsafe ? '1' : '0' }] };
    },
  };
  await assert.rejects(bindStarter(options));
  assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')), initial);
  await assert.rejects(readFile(dataFile + '.databases.json'), { code: 'ENOENT' });
  unsafe = false;
  await bindStarter(options);
  assert.equal(
    JSON.parse(await readFile(dataFile, 'utf8')).resources[1].provider,
    'tidb-cloud-starter',
  );
});
