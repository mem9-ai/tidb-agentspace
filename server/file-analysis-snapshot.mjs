import { createHash } from 'node:crypto';
import { analysisError, analysisLimits } from './file-analysis-contract.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function check(info, limit) {
  if (info.directory) throw analysisError(400, 'NOT_A_FILE', 'Select a file to analyze.');
  if (info.size > limit)
    throw analysisError(
      413,
      'ANALYSIS_INPUT_LIMIT',
      'This file exceeds the 16 MiB analysis limit. Download it to analyze locally.',
    );
}
export function createAnalysisSnapshot({ store, drive9 }) {
  return async (
    resource,
    path,
    signal,
    metadataOnly = false,
    limit = analysisLimits.inputBytes,
  ) => {
    signal?.throwIfAborted();
    if (!resource.provider || resource.provider === 'local') {
      const read = () =>
        store.read().files.find((f) => f.resourceId === resource.id && f.path === path);
      const file = read();
      if (!file) throw analysisError(404, 'NOT_FOUND', 'File not found.');
      const bytes = Buffer.from(file.content || '');
      const info = { size: bytes.length, directory: file.type === 'directory' };
      if (metadataOnly) {
        if (info.directory) throw analysisError(400, 'NOT_A_FILE', 'Select a file to analyze.');
        return info;
      }
      check(info, limit);
      if (digest(bytes) !== digest(Buffer.from(read()?.content || '')))
        throw analysisError(409, 'FILE_CHANGED', 'The file changed. Refresh it before analyzing.');
      return { ...info, bytes };
    }
    if (resource.provider !== 'drive9-anonymous')
      throw analysisError(
        422,
        'ANALYSIS_UNAVAILABLE',
        'This File System provider does not support file snapshots.',
      );
    const before = await drive9.stat(resource.id, path, { signal });
    if (metadataOnly) {
      if (before.directory) throw analysisError(400, 'NOT_A_FILE', 'Select a file to analyze.');
      return { ...before, versionAvailable: !!before.revision };
    }
    check(before, limit);
    if (!before.revision)
      throw analysisError(
        409,
        'FILE_VERSION_UNAVAILABLE',
        'The file version cannot be verified. Download it to analyze locally.',
      );
    const response = await drive9.read(resource.id, path, {
      signal,
      headers: { 'If-Match': before.revision },
    });
    const reader = response.body?.getReader();
    if (!reader) throw analysisError(502, 'FILE_READ_FAILED', 'File content is unavailable.');
    const cancel = () => void reader.cancel().catch(() => {});
    signal?.addEventListener('abort', cancel, { once: true });
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit || size > before.size)
          throw analysisError(
            413,
            'ANALYSIS_INPUT_LIMIT',
            'The file grew beyond its analysis budget. Refresh or download it.',
          );
        chunks.push(value);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
    }
    signal?.throwIfAborted();
    const after = await drive9.stat(resource.id, path, { signal });
    if (size !== before.size || after.size !== before.size || after.revision !== before.revision)
      throw analysisError(
        409,
        'FILE_CHANGED',
        'The file changed while reading. Refresh it before analyzing.',
      );
    return { size, bytes: Buffer.concat(chunks) };
  };
}
