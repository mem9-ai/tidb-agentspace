export const analysisLimits = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  scriptBytes: 64 * 1024,
  outputBytes: 1024 * 1024,
  rows: 1000,
  timeoutMs: 15_000,
  concurrency: 2,
  workerHeapMiB: 128,
  duckdbMemoryMB: 128,
});
