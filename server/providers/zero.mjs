import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createStore } from '../store.mjs';
import { executeNativeSql } from './sql-drivers.mjs';
import { sqlError, sqlLimits, validateBinding } from './sql-common.mjs';

export const zeroProvider = 'tidb-cloud-zero';
export const zeroRegion = 'automatic';
const endpoint = 'https://zero.tidbapi.com/v1beta1/instances';

export async function createZero({
  credentialsFile,
  transport = fetch,
  execute = executeNativeSql,
  limits = sqlLimits,
}) {
  try {
    if ((await stat(credentialsFile)).mode & 0o077)
      throw new Error('Zero credentials require owner-only file permissions.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const vault = await createStore(credentialsFile, () => ({ bindings: {} }));
  const pending = new Map();
  let active = 0;
  const get = (id) => vault.read().bindings[id];
  const expired = (binding) =>
    Number.isFinite(Date.parse(binding?.expiresAt)) && Date.parse(binding.expiresAt) <= Date.now();
  function status(id) {
    const binding = get(id);
    if (expired(binding)) return { status: 'expired', expiresAt: binding.expiresAt };
    if (binding?.state === 'ready') return { status: 'active', expiresAt: binding.expiresAt };
    return {
      status: binding?.admin ? 'provisioning' : 'failed',
      ...(binding?.expiresAt ? { expiresAt: binding.expiresAt } : {}),
      connectionError: binding?.admin
        ? 'Database access setup is incomplete. Retry setup to use the same instance.'
        : 'Database creation could not be confirmed. Operator recovery is required; no replacement will be created automatically.',
    };
  }
  async function provision(resource) {
    let binding = get(resource.id);
    if (binding?.state === 'ready' || expired(binding)) return status(resource.id);
    if (!binding) {
      // Zero POST has no documented idempotency guarantee. Persist intent before any request.
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = { state: 'requested' };
      });
      let result;
      try {
        const response = await transport(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: 'tidb-workspace' }),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Creation rejected');
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 64 * 1024) throw new Error('Invalid creation response');
          chunks.push(chunk);
        }
        result = JSON.parse(Buffer.concat(chunks).toString()).instance;
        if (
          typeof result?.id !== 'string' ||
          !Number.isFinite(Date.parse(result.expiresAt)) ||
          Date.parse(result.expiresAt) <= Date.now()
        )
          throw new Error('Invalid instance metadata');
        const admin = validateBinding(
          {
            kind: 'mysql',
            region: zeroRegion,
            host: result.connection?.host,
            port: result.connection?.port,
            user: result.connection?.username,
            password: result.connection?.password,
            database: 'test',
          },
          resource,
        );
        if (!/^[a-zA-Z0-9_.-]+$/.test(admin.user)) throw new Error('Invalid login name');
        const prefix = admin.user.includes('.')
          ? admin.user.slice(0, admin.user.lastIndexOf('.') + 1)
          : '';
        const suffixLength = Math.min(12, 32 - prefix.length - 1);
        if (suffixLength < 8) throw new Error('Unsupported user prefix');
        const user = 'w' + randomBytes(6).toString('hex').slice(0, suffixLength);
        binding = {
          state: 'configuring',
          instanceId: result.id,
          expiresAt: result.expiresAt,
          admin,
          user,
          connection: {
            ...admin,
            database: 'workspace',
            user: prefix + user,
            password: randomBytes(32).toString('hex'),
          },
        };
        // Persist returned credentials and the stable app password before executing setup SQL.
        await vault.mutate((draft) => {
          draft.bindings[resource.id] = binding;
        });
      } catch {
        throw sqlError(
          503,
          'ZERO_CREATION_UNCONFIRMED',
          'Database creation could not be confirmed. No automatic retry will create another instance.',
        );
      }
    }
    if (!binding.admin)
      throw sqlError(503, 'ZERO_CREATION_UNCONFIRMED', status(resource.id).connectionError);
    try {
      const run = (sql) => execute(binding.admin, sql, { limits });
      await run('CREATE DATABASE IF NOT EXISTS `workspace`');
      // Names/passwords are generated hex identifiers, never client-controlled SQL fragments.
      await run(
        `CREATE USER IF NOT EXISTS '${binding.connection.user}'@'%' IDENTIFIED BY '${binding.connection.password}'`,
      );
      await run(
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON \`workspace\`.* TO '${binding.connection.user}'@'%'`,
      );
      await execute(binding.connection, 'SELECT 1 AS connected', { limits });
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = {
          state: 'ready',
          instanceId: binding.instanceId,
          expiresAt: binding.expiresAt,
          connection: binding.connection,
        };
      });
      return status(resource.id);
    } catch {
      throw sqlError(
        503,
        'ZERO_SETUP_INCOMPLETE',
        'Database created, but access setup is incomplete. Retry setup to use the same instance.',
      );
    }
  }
  return {
    status,
    provision(resource) {
      if (!pending.has(resource.id))
        pending.set(
          resource.id,
          provision(resource).finally(() => pending.delete(resource.id)),
        );
      return pending.get(resource.id);
    },
    async execute(resource, sql, signal) {
      if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > limits.sqlBytes)
        throw sqlError(400, 'INVALID_SQL', 'Enter one SQL statement, up to 64 KiB.');
      const binding = get(resource.id);
      if (expired(binding))
        throw sqlError(
          410,
          'DATABASE_EXPIRED',
          'This Zero database has expired. Its data is no longer available.',
        );
      if (binding?.state !== 'ready')
        throw sqlError(503, 'DATABASE_NOT_READY', 'This database is not ready for queries.');
      if (active >= 4)
        throw sqlError(
          429,
          'SQL_BUSY',
          'Four queries are already running. Try again when one completes.',
        );
      active++;
      const started = performance.now();
      try {
        const connection = validateBinding(binding.connection, resource);
        const result = await execute(connection, sql, { limits, signal });
        return { ...result, mode: 'live', durationMs: Math.round(performance.now() - started) };
      } finally {
        active--;
      }
    },
  };
}
