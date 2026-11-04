import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { port, until } from './meta-fixture.mjs';

// A real separate process/root/key/token; never a Meta engine or in-process API role.
export async function analyticsFixture(metadata, reference, name, tls) {
  const listen = await port();
  const endpoint = `${tls ? 'https' : 'http'}://127.0.0.1:${listen}`;
  const identity = tls
    ? {
        ca: await readFile(tls.client.caFile),
        cert: await readFile(tls.client.certificateFile),
        key: await readFile(tls.client.privateKeyFile),
      }
    : {};
  const call = (path, { body, headers = {}, ...options } = {}) =>
    new Promise((resolveRequest, reject) => {
      const request = (tls ? https : http).request(
        endpoint + path,
        {
          ...identity,
          ...options,
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
        },
        (response) => {
          const parts = [];
          response.on('data', (part) => parts.push(part));
          response.on('end', () => {
            try {
              resolveRequest({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(parts).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('Analytics fixture deadline')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const root = resolve(metadata.directory, `analytics-${name}`);
  const tokenFile = root + '-token';
  const encryptionKeyFile = root + '-encryption';
  const pseudonymKeyFile = root + '-pseudonym';
  await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  await writeFile(encryptionKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  await writeFile(pseudonymKeyFile, randomBytes(32), { mode: 0o600 });
  const config = {
    authorityId: reference.authorityId,
    installationId: `analytics-${name}`,
    bind: `127.0.0.1:${listen}`,
    s3: { ...reference.s3, prefix: `analytics/${name}`, allowLoopbackHttp: Boolean(tls) },
    tokenFile,
    encryptionKeyFile,
    pseudonymKeyFile,
    campaigns: ['launch'],
    insecureLoopback: !tls,
    ...(tls ? { tls: tls.server } : {}),
  };
  const configFile = root + '.json';
  const planFile = root + '-plan.json';
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  let child;
  let log = '';
  async function start(initialize) {
    await writeFile(
      planFile,
      JSON.stringify({ format: 1, services: [{ kind: 'analytics', configFile, initialize }] }),
      { mode: 0o600 },
    );
    child = spawn(
      resolve('meta-service/target/debug/workspace-backend'),
      ['serve', '--config', planFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (bytes) => {
      log += bytes;
    });
    child.stderr.on('data', (bytes) => {
      log += bytes;
    });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(log);
      const response = await call('/health');
      assert.equal(response.status, 200);
    });
  }
  await start(true);
  return {
    config,
    client: { endpoint, tokenFile, insecureLoopback: !tls, ...(tls ? { tls: tls.client } : {}) },
    async stop(signal) {
      await metadata.stop(child, signal);
    },
    async restart() {
      await metadata.stop(child);
      await start(false);
    },
    request(path, body, headers = {}, options = {}) {
      return call('/analytics/v1' + path, { body, headers, ...options });
    },
  };
}
