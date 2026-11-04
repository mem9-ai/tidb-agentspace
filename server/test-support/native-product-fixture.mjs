import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { metaFixture, port, until } from './meta-fixture.mjs';
import { seedRecords } from './record-fixture.mjs';
import { workspaceFixture } from './workspace-fixture.mjs';
import { providerFixture, nativeSecret } from './provider-fixture.mjs';

export async function nativeProductFixture(t) {
  const metadata = await metaFixture();
  let provider, child;
  t.after(async () => {
    if (child) await metadata.stop(child);
    if (provider) await provider.close();
    await metadata.close();
  });
  provider = await providerFixture();
  const region = await metadata.service('contract');
  await seedRecords(region.client, region.server.authorityId, workspaceFixture(), {
    db9: {
      account: {
        state: 'ready',
        anonymousId: 'fixture',
        anonymousSecret: nativeSecret,
        token: 'fixture-token',
        expiresAt: 4070908800000,
      },
      bindings: {
        db_memory: {
          state: 'ready',
          instanceId: 'fixture',
          connection: {
            kind: 'postgresql',
            region: 'automatic',
            host: 'pg.db9.io',
            port: 5432,
            user: 'tenant.wabcdef123456',
            password: nativeSecret,
            database: 'postgres',
          },
        },
      },
    },
  });
  const listen = await port();
  const config = resolve(metadata.directory, 'api.json');
  await writeFile(
    config,
    JSON.stringify({
      bind: `127.0.0.1:${listen}`,
      workspaceId: 'ws_agentlab',
      authorityId: region.server.authorityId,
      insecureLoopback: true,
      consoleOrigins: ['http://127.0.0.1:5173'],
      metadata: { transport: 'remote', client: region.clientConfig },
      product: {
        providers: {
          filesProvider: 'local',
          mysqlProvider: 'tidb-cloud-zero',
          postgresProvider: 'db9-anonymous',
          testMode: true,
          zeroEndpoint: provider.origin + '/zero',
          db9Endpoint: provider.origin + '/customer',
          sqlFixture: provider.origin + '/sql',
        },
      },
    }),
    { mode: 0o600 },
  );
  const plan = resolve(metadata.directory, 'plan.json');
  await writeFile(
    plan,
    JSON.stringify({ format: 1, services: [{ kind: 'workspace', configFile: config }] }),
    { mode: 0o600 },
  );
  const log = createWriteStream(resolve(metadata.directory, 'api.log'), { mode: 0o600 });
  child = spawn(
    resolve('meta-service/target/debug/workspace-backend'),
    ['serve', '--config', plan],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const origin = `http://127.0.0.1:${listen}`;
  await until(async () => {
    const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error('Native fixture is not ready');
    await response.body?.cancel();
  });
  return { origin };
}
