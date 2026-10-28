import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createStore } from '../store.mjs';
import { sqlError, sqlLimits } from './sql-common.mjs';
import { executePostgres } from './postgres-driver.mjs';

export const db9Provider = 'db9-anonymous';
export const db9Region = 'automatic';
const endpoint = 'https://api.db9.ai/customer';
const nonempty = (value) => typeof value === 'string' && value.length > 0 && value.length <= 16384;
const unconfirmed = () =>
  sqlError(
    503,
    'DB9_CREATION_UNCONFIRMED',
    'Database creation could not be confirmed. Setup can recover the saved instance; no replacement is created automatically.',
  );

export function validatePgBinding(binding, resource, { admin = false } = {}) {
  if (
    !binding ||
    binding.kind !== 'postgresql' ||
    resource.kind !== 'postgresql' ||
    binding.region !== resource.region ||
    resource.region !== db9Region ||
    !['pg.db9.io', 'pg.d0000.db9.io'].includes(binding.host) ||
    ![5432, 5433].includes(binding.port) ||
    !(admin ? /^[a-zA-Z0-9_-]+\.admin$/ : /^[a-zA-Z0-9_-]+\.w[a-f0-9]{12}$/).test(binding.user) ||
    !nonempty(binding.password) ||
    binding.database !== 'postgres'
  )
    throw sqlError(
      503,
      'DATABASE_NOT_CONFIGURED',
      'This database needs a valid internal db9 connection.',
    );
  return Object.fromEntries(
    ['kind', 'region', 'host', 'port', 'user', 'password', 'database'].map((key) => [
      key,
      binding[key],
    ]),
  );
}
function connection(response, binding, resource) {
  const url = new URL(response.connection_string);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !nonempty(response.id))
    throw unconfirmed();
  const admin = validatePgBinding(
    {
      kind: 'postgresql',
      region: db9Region,
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      database: decodeURIComponent(url.pathname.slice(1)),
      password: nonempty(response.admin_password) ? response.admin_password : binding.adminPassword,
    },
    resource,
    { admin: true },
  );
  if (admin.user !== `${response.id}.admin`) throw unconfirmed();
  return admin;
}
function tokenExpiry(data) {
  const supplied = Date.parse(data.expires_at);
  if (Number.isFinite(supplied)) return supplied;
  try {
    const exp = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString()).exp;
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export async function createDb9({
  credentialsFile,
  transport = fetch,
  execute = executePostgres,
  limits = sqlLimits,
}) {
  try {
    if ((await stat(credentialsFile)).mode & 0o077)
      throw new Error('db9 credentials require owner-only file permissions.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const vault = await createStore(credentialsFile, () => ({ bindings: {} }));
  const get = (id) => vault.read().bindings[id];
  const pending = new Map();
  let accountPending,
    active = 0;
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await transport(endpoint + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw sqlError(
        response.status === 429 ? 429 : 503,
        response.status === 429 ? 'DB9_RATE_LIMIT' : 'DB9_REQUEST_REJECTED',
        'db9 could not accept this request. Check service availability and anonymous quotas.',
      );
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error('Invalid db9 response');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function account() {
    let saved = vault.read().account;
    if (!saved) {
      await vault.mutate((draft) => {
        draft.account = { state: 'requested' };
      });
      const data = await request('/anonymous-register', { method: 'POST' });
      await vault.mutate((draft) => {
        draft.account = { state: 'received', response: data };
      });
      saved = vault.read().account;
    }
    if (saved.state === 'received') {
      const data = saved.response;
      if (![data.anonymous_id, data.anonymous_secret, data.token].every(nonempty))
        throw new Error('Invalid anonymous registration response');
      saved = {
        state: 'ready',
        anonymousId: data.anonymous_id,
        anonymousSecret: data.anonymous_secret,
        token: data.token,
        expiresAt: tokenExpiry(data),
      };
      await vault.mutate((draft) => {
        draft.account = saved;
      });
    }
    if (saved.state !== 'ready')
      throw sqlError(
        503,
        'DB9_REGISTRATION_UNCONFIRMED',
        'Anonymous registration needs operator recovery. No new account is registered automatically.',
      );
    if (saved.expiresAt <= Date.now() + 60000) {
      const data = await request('/anonymous-refresh', {
        method: 'POST',
        body: { anonymous_id: saved.anonymousId, anonymous_secret: saved.anonymousSecret },
      });
      if (!nonempty(data.token)) throw new Error('Invalid anonymous refresh response');
      saved = { ...saved, token: data.token, expiresAt: tokenExpiry(data) };
      await vault.mutate((draft) => {
        draft.account = saved;
      });
    }
    return saved;
  }
  function ensureAccount() {
    if (!accountPending)
      accountPending = account().finally(() => {
        accountPending = undefined;
      });
    return accountPending;
  }
  function status(id) {
    const binding = get(id);
    if (binding?.state === 'ready') return { status: 'active' };
    return {
      status: binding?.admin ? 'provisioning' : 'failed',
      connectionError: binding?.admin
        ? 'PostgreSQL access setup is incomplete. Retry setup on this database.'
        : 'Database creation needs recovery. No replacement will be created automatically.',
    };
  }
  async function provision(resource) {
    let binding = get(resource.id);
    if (binding?.state === 'ready') return status(resource.id);
    if (!binding) {
      binding = {
        state: 'requested',
        name: `workspace-${resource.id.replaceAll('_', '-')}`,
        adminPassword: randomBytes(32).toString('hex'),
        role: `w${randomBytes(6).toString('hex')}`,
        password: randomBytes(32).toString('hex'),
      };
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = binding;
      });
      try {
        const { token } = await ensureAccount();
        const data = await request('/databases', {
          method: 'POST',
          token,
          body: { name: binding.name, admin_password: binding.adminPassword },
        });
        binding = { ...binding, state: 'received', response: data };
        await vault.mutate((draft) => {
          draft.bindings[resource.id] = binding;
        });
      } catch (error) {
        if (error.status) throw error;
        throw unconfirmed();
      }
    } else if (binding.state === 'requested') {
      // A confirmed name lookup can recover an unknown POST outcome; never send another create.
      const { token } = await ensureAccount();
      const entries = await request('/databases', { token });
      if (!Array.isArray(entries)) throw unconfirmed();
      const existing = entries.filter((entry) => entry.name === binding.name);
      if (existing.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(existing[0].id)) throw unconfirmed();
      const data = await request(`/databases/${existing[0].id}`, { token });
      binding = { ...binding, state: 'received', response: data };
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = binding;
      });
    }
    if (binding.state === 'received') {
      const admin = connection(binding.response, binding, resource);
      binding = {
        state: 'configuring',
        name: binding.name,
        instanceId: binding.response.id,
        role: binding.role,
        admin,
        connection: {
          ...admin,
          user: `${binding.response.id}.${binding.role}`,
          password: binding.password,
        },
      };
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = binding;
      });
    }
    if (!binding.admin) throw unconfirmed();
    try {
      const run = (sql) =>
        execute(validatePgBinding(binding.admin, resource, { admin: true }), sql, {
          limits,
          setup: true,
        });
      const roles = await run(
        `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '${binding.role}'`,
      );
      if (!roles.rows.length)
        await run(
          `CREATE ROLE "${binding.role}" LOGIN PASSWORD '${binding.connection.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
        );
      await run(`CREATE SCHEMA IF NOT EXISTS workspace AUTHORIZATION "${binding.role}"`);
      const check = await run(
        `SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '${binding.role}'`,
      );
      if (
        check.rows.length !== 1 ||
        ['rolsuper', 'rolcreatedb', 'rolcreaterole'].some((key) => check.rows[0][key] !== false)
      )
        throw new Error('Unsafe database role');
      const access = await execute(
        validatePgBinding(binding.connection, resource),
        "SELECT n.nspowner = r.oid AS owned FROM pg_namespace n JOIN pg_roles r ON r.rolname = current_user WHERE n.nspname = 'workspace'",
        { limits },
      );
      if (access.rows.length !== 1 || access.rows[0].owned !== true)
        throw new Error('Unsafe workspace schema ownership');
      await vault.mutate((draft) => {
        draft.bindings[resource.id] = {
          state: 'ready',
          name: binding.name,
          instanceId: binding.instanceId,
          connection: binding.connection,
        };
      });
      return status(resource.id);
    } catch {
      throw sqlError(
        503,
        'DB9_SETUP_INCOMPLETE',
        'Database access setup is incomplete. Retry setup to use the same db9 instance.',
      );
    }
  }
  return {
    status,
    provision(resource) {
      if (!pending.has(resource.id))
        pending.set(
          resource.id,
          provision(resource)
            .catch((error) => {
              if (
                [
                  'DB9_CREATION_UNCONFIRMED',
                  'DB9_REGISTRATION_UNCONFIRMED',
                  'DB9_SETUP_INCOMPLETE',
                  'DB9_REQUEST_REJECTED',
                  'DB9_RATE_LIMIT',
                  'DATABASE_NOT_CONFIGURED',
                ].includes(error?.code)
              )
                throw error;
              throw unconfirmed();
            })
            .finally(() => pending.delete(resource.id)),
        );
      return pending.get(resource.id);
    },
    async execute(resource, sql, signal) {
      if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > limits.sqlBytes)
        throw sqlError(400, 'INVALID_SQL', 'Enter one PostgreSQL statement, up to 64 KiB.');
      const binding = get(resource.id);
      if (binding?.state !== 'ready')
        throw sqlError(503, 'DATABASE_NOT_READY', 'This PostgreSQL database is not ready.');
      if (active >= 4)
        throw sqlError(429, 'SQL_BUSY', 'Four PostgreSQL queries are already running.');
      active++;
      const start = performance.now();
      try {
        return {
          ...(await execute(validatePgBinding(binding.connection, resource), sql, {
            limits,
            signal,
          })),
          mode: 'live',
          durationMs: Math.round(performance.now() - start),
        };
      } finally {
        active--;
      }
    },
  };
}
