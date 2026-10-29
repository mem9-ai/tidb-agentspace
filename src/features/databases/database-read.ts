export const databaseReadTimeoutMs = 20_000;

// Bound the complete read, including body decoding. Cleanup cancellation stays distinct
// from a deadline so consumers can show a retryable failure instead of a permanent spinner.
export function readDatabase<T>(
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = databaseReadTimeoutMs,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: { data: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if ('error' in result) reject(result.error);
      else resolve(result.data);
    };
    const cancel = () => {
      finish({ error: signal.reason ?? new DOMException('Read canceled.', 'AbortError') });
      controller.abort(signal.reason);
    };
    const timer = setTimeout(() => {
      const error = new Error('Database read timed out. Try again or use SQL Editor.');
      finish({ error });
      controller.abort(error);
    }, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return load(controller.signal);
      })
      .then(
        (data) => finish({ data }),
        (error: unknown) => finish({ error }),
      );
  });
}
