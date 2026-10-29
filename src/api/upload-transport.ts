export type UploadProgress =
  { phase: 'uploading'; loaded: number; total?: number } | { phase: 'saving' };

// Keep generated paths, serialization and error handling; replace only the upload transport.
export function createUploadFetch(
  onProgress: (progress: UploadProgress) => void,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = await request.blob();
    request.signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const xhr = createRequest();
      const cleanup = () => request.signal.removeEventListener('abort', abort);
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const abort = () => {
        xhr.abort();
        fail(request.signal.reason ?? new DOMException('Upload canceled.', 'AbortError'));
      };
      xhr.upload.onprogress = (event) =>
        onProgress({
          phase: 'uploading',
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : undefined,
        });
      xhr.upload.onload = () => onProgress({ phase: 'saving' });
      xhr.onload = () => {
        cleanup();
        const headers = new Headers();
        for (const line of xhr
          .getAllResponseHeaders()
          .trim()
          .split(/[\r\n]+/)) {
          const separator = line.indexOf(':');
          if (separator > 0)
            headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
        }
        resolve(
          new Response(xhr.status === 204 ? null : xhr.response, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers,
          }),
        );
      };
      xhr.onerror = () =>
        fail(
          new Error(
            'Connection lost before upload confirmation. Refresh the folder before trying again.',
          ),
        );
      xhr.ontimeout = () =>
        fail(new Error('Upload confirmation timed out. Refresh the folder before trying again.'));
      xhr.onabort = () =>
        fail(
          new DOMException(
            'Upload canceled. Refresh the folder to check its status.',
            'AbortError',
          ),
        );
      xhr.open(request.method, request.url, true);
      xhr.withCredentials = request.credentials === 'include';
      xhr.timeout = 120_000;
      xhr.responseType = 'arraybuffer';
      request.headers.forEach((value, key) => xhr.setRequestHeader(key, value));
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      else xhr.send(body);
    });
  };
}
