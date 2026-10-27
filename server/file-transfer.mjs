import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { boundedBytes, fileError, previewLimit, gatewayUploadLimit } from './providers/drive9.mjs';

export async function readUpload(req) {
  if (req.headers['content-type'] !== 'application/octet-stream')
    throw fileError(415, 'BINARY_REQUIRED', 'Send Content-Type: application/octet-stream.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > gatewayUploadLimit)
      throw fileError(413, 'FILE_TOO_LARGE', 'Uploads are limited to 1 MiB in this trial gateway.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function previewFile(provider, resourceId, path) {
  const { size, directory } = await provider.stat(resourceId, path);
  if (directory) throw fileError(400, 'NOT_A_FILE', 'Select a file to preview.');
  if (size > previewLimit)
    return {
      size,
      unavailableReason:
        'This file exceeds the 128 KiB preview limit. Download it to view locally.',
    };
  let bytes;
  try {
    bytes = await boundedBytes(await provider.read(resourceId, path), previewLimit);
  } catch (error) {
    if (error.code === 'CONTENT_TOO_LARGE')
      return {
        size,
        unavailableReason: 'The file grew beyond the preview limit. Download it to view locally.',
      };
    throw fileError(
      error.status || 502,
      error.code || 'PROVIDER_UNAVAILABLE',
      error.status ? error.message : 'File content could not be loaded. Try opening it again.',
    );
  }
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.some((byte) => byte < 9 || (byte > 13 && byte < 32)))
      throw new TypeError('Binary content');
    return { size: bytes.length, content };
  } catch {
    return {
      size,
      unavailableReason:
        'This binary file cannot be previewed. Download it to open in another application.',
    };
  }
}
export async function downloadFile(provider, resourceId, path, res) {
  const { size, directory } = await provider.stat(resourceId, path);
  if (directory) throw fileError(400, 'NOT_A_FILE', 'Select a file to download.');
  const response = await provider.read(resourceId, path);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
  });
  // Stream with backpressure; do not buffer downloads or forward provider headers/URLs.
  let received = 0;
  const bound = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      callback(received > size ? new Error('File changed while downloading') : null, chunk);
    },
    flush(callback) {
      callback(received === size ? null : new Error('Incomplete file download'));
    },
  });
  await pipeline(Readable.fromWeb(response.body), bound, res);
}
