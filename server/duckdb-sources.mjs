import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sqlError } from './providers/sql-common.mjs';

export const sourceLimits = { count: 4, bytes: 16 * 1024 * 1024 };
const invalid = () =>
  sqlError(
    400,
    'INVALID_SOURCES',
    'Select up to four named CSV, JSON or Parquet files with exact absolute paths.',
  );
export function parseSources(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > sourceLimits.count) throw invalid();
  const names = new Set();
  return value.map((source) => {
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.keys(source).some((key) => !['name', 'resourceId', 'path'].includes(key)) ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(source.name || '') ||
      names.has(source.name) ||
      typeof source.resourceId !== 'string' ||
      !source.resourceId ||
      typeof source.path !== 'string' ||
      !source.path.startsWith('/') ||
      source.path.length > 512 ||
      [...source.path].some((char) => char.charCodeAt(0) < 32 || '\\*?[]{}'.includes(char)) ||
      source.path.split('/').some((part) => part === '.' || part === '..')
    )
      throw invalid();
    const format = /\.([a-z]+)$/i.exec(source.path)?.[1].toLowerCase();
    if (!['csv', 'json', 'jsonl', 'ndjson', 'parquet'].includes(format))
      throw sqlError(
        415,
        'SOURCE_FORMAT_UNSUPPORTED',
        'Choose CSV, JSON, NDJSON/JSONL or Parquet. Download other formats to analyze locally.',
      );
    names.add(source.name);
    return {
      name: source.name,
      resourceId: source.resourceId,
      path: source.path.replace(/\/{2,}/g, '/'),
      format,
    };
  });
}
async function readBounded(response, limit, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw sqlError(502, 'SOURCE_READ_FAILED', 'File content is unavailable.');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) {
        cancel();
        throw sqlError(
          413,
          'SOURCE_TOO_LARGE',
          'Selected files exceed the 16 MiB query input limit. Download or reduce the input.',
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    if (signal?.aborted) cancel();
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
// Input resources have already all been authorized. No provider credential leaves this adapter.
export async function stageSources(
  sources,
  { drive9, readState, authorize, signal, directory = tmpdir() },
) {
  let root;
  const cleanup = async () => {
    if (root) await rm(root, { recursive: true, force: true });
  };
  const localFile = (source) => {
    const file = readState().files.find(
      (file) => file.resourceId === source.resourceId && file.path === source.path,
    );
    if (!file) throw sqlError(404, 'SOURCE_NOT_FOUND', 'A selected file no longer exists.');
    return file;
  };
  const stat = async (source) => {
    authorize();
    signal?.throwIfAborted();
    if (
      source.resource.provider &&
      !['local', 'drive9-anonymous'].includes(source.resource.provider)
    )
      throw sqlError(
        503,
        'SOURCE_PROVIDER_UNSUPPORTED',
        'This File System provider does not support query sources.',
      );
    if (source.resource.provider === 'drive9-anonymous')
      return drive9.stat(source.resourceId, source.path, { signal });
    const file = localFile(source);
    return {
      size: Buffer.byteLength(file.content || ''),
      directory: file.type === 'directory',
      revision: file.updatedAt,
    };
  };
  try {
    let total = 0;
    const metadata = [];
    for (const source of sources) {
      const info = await stat(source);
      if (info.directory)
        throw sqlError(400, 'SOURCE_NOT_A_FILE', 'Select a file, not a directory.');
      if (!Number.isSafeInteger(info.size) || info.size < 0)
        throw sqlError(502, 'SOURCE_READ_FAILED', 'File size is unavailable.');
      if (info.size === 0)
        throw sqlError(422, 'SOURCE_EMPTY', 'A selected file is empty. Choose a file with data.');
      total += info.size;
      if (total > sourceLimits.bytes)
        throw sqlError(
          413,
          'SOURCE_TOO_LARGE',
          'Selected files exceed the 16 MiB query input limit. Download or reduce the input.',
        );
      metadata.push(info);
    }
    root = await mkdtemp(join(directory, 'workspace-query-'));
    const staged = [];
    let received = 0;
    for (const [index, source] of sources.entries()) {
      authorize();
      signal?.throwIfAborted();
      const bytes =
        source.resource.provider === 'drive9-anonymous'
          ? await readBounded(
              await drive9.read(source.resourceId, source.path, {
                signal,
                ...(metadata[index].revision
                  ? { headers: { 'If-Match': metadata[index].revision } }
                  : {}),
              }),
              sourceLimits.bytes - received,
              signal,
            )
          : Buffer.from(localFile(source).content || '');
      const after = await stat(source),
        before = metadata[index];
      if (
        bytes.length !== before.size ||
        after.size !== before.size ||
        after.directory ||
        after.revision !== before.revision ||
        after.dataRevision !== before.dataRevision ||
        after.resourceIdentity !== before.resourceIdentity
      )
        throw sqlError(
          409,
          'SOURCE_CHANGED',
          'A selected file changed while loading. Review it and run again.',
        );
      received += bytes.length;
      if (received > sourceLimits.bytes)
        throw sqlError(
          413,
          'SOURCE_TOO_LARGE',
          'Selected files exceed the 16 MiB query input limit.',
        );
      const path = join(root, `${index}.${source.format}`);
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      staged.push({ name: source.name, format: source.format, path });
    }
    authorize();
    signal?.throwIfAborted();
    return { sources: staged, cleanup };
  } catch (error) {
    await cleanup();
    if (error.status || signal?.aborted) throw error;
    throw sqlError(
      502,
      'SOURCE_READ_FAILED',
      'Selected files could not be loaded. No query was executed.',
    );
  }
}
