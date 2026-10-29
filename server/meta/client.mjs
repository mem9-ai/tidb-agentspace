import http from 'node:http';
import https from 'node:https';
import { lstat, readFile } from 'node:fs/promises';

export function metaError(code, status = 503) {
  return Object.assign(new Error('Metadata service could not complete this operation.'), {
    code,
    status,
  });
}

export async function privateJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error('Metadata configuration requires an owner-only ordinary file.');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Invalid private metadata configuration.');
  }
}

export async function createMetaClient(config) {
  const origin = new URL(config.origin);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Use an explicit metadata service origin.');
  const insecure = config.insecureLoopback === true;
  if (
    origin.protocol !== 'https:' &&
    !(
      insecure &&
      origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    )
  )
    throw new Error('Metadata clients require HTTPS outside explicit loopback tests.');
  const secret = async (path) => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error('Metadata credentials require owner-only ordinary files.');
    return readFile(path);
  };
  const token = (await secret(config.tokenFile)).toString().trim();
  if (token.length < 32 || !config.authorityId || !config.installationId)
    throw new Error('Metadata client identity is incomplete.');
  const agent =
    origin.protocol === 'https:'
      ? new https.Agent({
          ca: await readFile(config.tls.caFile),
          cert: await readFile(config.tls.certificateFile),
          key: await secret(config.tls.privateKeyFile),
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          keepAlive: true,
        })
      : new http.Agent({ keepAlive: true });
  const call = (path, input) =>
    new Promise((resolve, reject) => {
      const payload = input === undefined ? undefined : JSON.stringify(input);
      const request = (origin.protocol === 'https:' ? https : http).request(
        new URL(path, origin),
        {
          method: payload === undefined ? 'GET' : 'POST',
          agent,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Meta-Authority': config.authorityId,
            'X-Meta-Installation': config.installationId,
            ...(payload === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          let length = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            length += chunk.length;
            if (length > 25 * 1024 * 1024) response.destroy(metaError('META_RESPONSE_TOO_LARGE'));
            else chunks.push(chunk);
          });
          response.on('error', () => reject(metaError('META_UNAVAILABLE')));
          response.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks));
              if (response.statusCode !== 200)
                return reject(
                  metaError(value.error?.code || 'META_UNAVAILABLE', response.statusCode),
                );
              resolve(value);
            } catch {
              reject(metaError('META_INVALID_RESPONSE'));
            }
          });
        },
      );
      request.setTimeout(30_000, () => request.destroy(metaError('META_COMMIT_UNKNOWN')));
      request.on('error', () =>
        reject(metaError(payload ? 'META_COMMIT_UNKNOWN' : 'META_UNAVAILABLE')),
      );
      request.end(payload);
    });
  const health = await call('/health');
  if (
    health.authorityId !== config.authorityId ||
    health.installationId !== config.installationId
  ) {
    agent.destroy();
    throw metaError('META_INSTALLATION_MISMATCH');
  }
  return {
    config,
    capabilities: health.capabilities || [],
    call: (input) => call('/v1/meta', input),
    health: () => call('/health'),
    close: () => agent.destroy(),
  };
}
