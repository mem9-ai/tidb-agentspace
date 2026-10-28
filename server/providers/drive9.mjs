import { createStore } from '../store.mjs';

export const drive9Provider = 'drive9-anonymous';
export const drive9Region = 'aws-ap-southeast-1';
export const gatewayUploadLimit = 1024 * 1024;
export const previewLimit = 128 * 1024;
export function fileError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Deliberately no user-supplied URL or credential. Test transports are injected in-process.
const endpoint = 'https://api.drive9.ai';
export async function boundedBytes(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit)
      throw fileError(413, 'CONTENT_TOO_LARGE', 'Content exceeds the permitted size.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createDrive9({ credentialsFile, transport = fetch }) {
  const vault = await createStore(credentialsFile, () => ({ bindings: {} }));
  const provisioning = new Map();
  async function request(resourceId, path, options = {}) {
    const binding = vault.read().bindings[resourceId];
    if (resourceId && !binding?.apiKey)
      throw fileError(
        503,
        'PROVIDER_BINDING_MISSING',
        'File System provisioning requires operator recovery. No replacement tenant will be created automatically.',
      );
    let response;
    try {
      response = await transport(endpoint + path, {
        ...options,
        headers: {
          ...options.headers,
          ...(binding ? { Authorization: `Bearer ${binding.apiKey}` } : {}),
        },
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw fileError(
        502,
        'PROVIDER_UNAVAILABLE',
        'File System service is unavailable. Retry reading its status before repeating a write.',
      );
    }
    if (response.status === 412) {
      await response.body?.cancel();
      throw fileError(409, 'FILE_CHANGED', 'The file changed. Refresh it before trying again.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages = {
        404: ['NOT_FOUND', 'File or directory not found.'],
        409: [
          'FILE_CONFLICT',
          'The path conflicts with an existing item or the directory is not empty.',
        ],
        413: ['FILE_TOO_LARGE', 'This file exceeds the service upload limit.'],
        429: [
          'PROVIDER_LIMIT',
          'File System trial quota or request limit reached. Try again later.',
        ],
      };
      const [code, message] = messages[response.status] ?? [
        'PROVIDER_UNAVAILABLE',
        'File System service could not complete this request.',
      ];
      throw fileError(messages[response.status] ? response.status : 502, code, message);
    }
    return response;
  }
  async function json(resourceId, path, options) {
    const response = await request(resourceId, path, options);
    try {
      const value = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString());
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid object');
      return value;
    } catch {
      throw fileError(
        502,
        'INVALID_PROVIDER_RESPONSE',
        'File System returned an invalid response.',
      );
    }
  }
  const fsPath = (path) => '/v1/fs' + path.split('/').map(encodeURIComponent).join('/');
  async function status(resourceId) {
    const result = await json(resourceId, '/v1/status');
    if (
      !['active', 'provisioning', 'failed', 'suspended', 'deleting', 'deleted'].includes(
        result.status,
      )
    )
      throw fileError(502, 'INVALID_PROVIDER_RESPONSE', 'File System returned an unknown status.');
    // Only implement the simple PUT transport. Never guess a multipart/extent contract.
    const limits = [result.max_upload_bytes, result.inline_threshold];
    const uploadLimitBytes = limits.every((n) => Number.isSafeInteger(n) && n > 0)
      ? Math.min(gatewayUploadLimit, ...limits)
      : 0;
    return { status: result.status, uploadLimitBytes };
  }
  async function provisionOnce(resourceId) {
    const prior = vault.read().bindings[resourceId];
    if (prior?.apiKey) return status(resourceId);
    if (prior)
      throw fileError(
        503,
        'PROVISION_OUTCOME_UNKNOWN',
        'Provisioning outcome is unknown. Operator recovery is required; no duplicate trial will be created.',
      );
    // Persist intent before the non-idempotent upstream POST. A lost response is never retried.
    await vault.mutate((draft) => {
      draft.bindings[resourceId] = { state: 'requested' };
    });
    const result = await json(null, '/v1/provision', { method: 'POST' });
    if (
      typeof result.api_key !== 'string' ||
      !result.api_key ||
      typeof result.tenant_id !== 'string'
    )
      throw fileError(
        502,
        'INVALID_PROVIDER_RESPONSE',
        'Provisioning returned no usable credential. Operator recovery is required.',
      );
    await vault.mutate((draft) => {
      draft.bindings[resourceId] = {
        state: 'bound',
        apiKey: result.api_key,
        tenantId: result.tenant_id,
      };
    });
    return status(resourceId);
  }
  return {
    // Backend-only binding for private database workers; never serialize through the product API.
    internalConnection(resourceId) {
      const binding = vault.read().bindings[resourceId];
      if (!binding?.apiKey)
        throw fileError(
          503,
          'PROVIDER_BINDING_MISSING',
          'Database storage needs operator recovery.',
        );
      return { endpoint, apiKey: binding.apiKey };
    },
    status,
    provision(resourceId) {
      if (!provisioning.has(resourceId)) {
        const pending = provisionOnce(resourceId).finally(() => provisioning.delete(resourceId));
        provisioning.set(resourceId, pending);
      }
      return provisioning.get(resourceId);
    },
    async list(resourceId, path) {
      const result = await json(resourceId, fsPath(path) + '?list=1');
      if (!Array.isArray(result.entries))
        throw fileError(502, 'INVALID_PROVIDER_RESPONSE', 'Invalid directory listing.');
      return result.entries.map((entry) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.name !== 'string' ||
          !entry.name ||
          [...entry.name].some(
            (char) => char.charCodeAt(0) < 32 || char === '/' || char === '\\',
          ) ||
          ['.', '..'].includes(entry.name) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          typeof entry.isDir !== 'boolean'
        )
          throw fileError(502, 'INVALID_PROVIDER_RESPONSE', 'Invalid file metadata.');
        const filePath = (path === '/' ? '' : path) + '/' + entry.name;
        return {
          id: `${resourceId}:${filePath}`,
          resourceId,
          path: filePath,
          type: entry.isDir ? 'directory' : 'file',
          size: entry.size,
          updatedAt:
            Number.isFinite(entry.mtime) && entry.mtime > 0 && entry.mtime <= 8.64e12
              ? new Date(entry.mtime * 1000).toISOString()
              : null,
        };
      });
    },
    async stat(resourceId, path, options = {}) {
      const response = await request(resourceId, fsPath(path), { ...options, method: 'HEAD' });
      const raw = response.headers.get('content-length');
      const size = raw === null ? NaN : Number(raw);
      if (!Number.isSafeInteger(size) || size < 0)
        throw fileError(502, 'INVALID_PROVIDER_RESPONSE', 'File size is unavailable.');
      const revision = response.headers.get('etag');
      return {
        size,
        directory: response.headers.get('x-dat9-isdir') === 'true',
        ...(revision ? { revision } : {}),
        ...(response.headers.get('x-dat9-revision')
          ? { dataRevision: response.headers.get('x-dat9-revision') }
          : {}),
        ...(response.headers.get('x-dat9-resource-id')
          ? { resourceIdentity: response.headers.get('x-dat9-resource-id') }
          : {}),
      };
    },
    read(resourceId, path, options = {}) {
      return request(resourceId, fsPath(path), options);
    },
    async write(resourceId, path, bytes, createOnly = false, beforeWrite = () => {}) {
      const info = await status(resourceId);
      if (info.status !== 'active')
        throw fileError(409, 'PROVIDER_NOT_READY', 'Wait until this File System is active.');
      if (!info.uploadLimitBytes || bytes.length > info.uploadLimitBytes)
        throw fileError(
          413,
          'FILE_TOO_LARGE',
          `This File System currently accepts uploads up to ${info.uploadLimitBytes} bytes.`,
        );
      beforeWrite();
      const response = await request(resourceId, fsPath(path), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(createOnly ? { 'X-Dat9-Expected-Revision': '0' } : {}),
        },
        body: bytes,
      });
      await response.body?.cancel();
    },
    async mkdir(resourceId, path) {
      const response = await request(resourceId, fsPath(path) + '?mkdir=1', { method: 'POST' });
      await response.body?.cancel();
    },
    async remove(resourceId, path) {
      // No recursive option: non-empty directories must remain protected.
      const response = await request(resourceId, fsPath(path), { method: 'DELETE' });
      await response.body?.cancel();
    },
  };
}
