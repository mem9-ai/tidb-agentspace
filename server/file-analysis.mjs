import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analysisError,
  analysisFormat,
  analysisLimits,
  validateAnalysis,
} from './file-analysis-contract.mjs';

function abortError(signal) {
  return signal.reason?.code === 'ANALYSIS_TIMEOUT'
    ? signal.reason
    : analysisError(499, 'ANALYSIS_CANCELED', 'Analysis canceled.');
}
export function runAnalysisWorker(input, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const child = fork(fileURLToPath(new URL('./file-analysis-worker.mjs', import.meta.url)), [], {
      cwd: input.directory,
      env: { HOME: input.directory, TMPDIR: input.directory },
      execArgv: [`--max-old-space-size=${input.limits.workerHeapMiB}`, '--disable-proto=throw'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    let result, error;
    const abort = () => {
      error = abortError(signal);
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', abort, { once: true });
    child.on('message', (message) => {
      if (message?.error)
        error = analysisError(message.error.status, message.error.code, message.error.message);
      else result = message?.result;
    });
    child.on('error', () => {
      error = analysisError(
        503,
        'ANALYSIS_UNAVAILABLE',
        'The analysis worker is unavailable. Try again later.',
      );
    });
    child.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (!result)
        reject(
          analysisError(
            422,
            'ANALYSIS_RESOURCE_LIMIT',
            'Analysis stopped before completion. Reduce its memory use or workload.',
          ),
        );
      else resolve(result);
    });
    child.send(input, (cause) => {
      if (cause) {
        error = analysisError(503, 'ANALYSIS_UNAVAILABLE', 'The analysis worker is unavailable.');
        child.kill('SIGKILL');
      }
    });
  });
}
export function createFileAnalysis({
  snapshot,
  runner = runAnalysisWorker,
  limits = analysisLimits,
}) {
  let active = 0;
  return {
    limits,
    async capabilities(resource, path, signal) {
      const info = await snapshot(resource, path, signal, true);
      const format = analysisFormat(path);
      const reason = !format
        ? 'This file type is not supported for analysis. Download it to use another tool.'
        : info.size > limits.inputBytes
          ? 'This file exceeds the 16 MiB analysis limit. Download it to analyze locally.'
          : info.versionAvailable === false
            ? 'The file version cannot be verified. Download it to analyze locally.'
            : '';
      const engines = (format?.engines || []).map((engine) => {
        const engineReason =
          reason ||
          (info.size === 0 && engine === 'duckdb'
            ? 'This file is empty. Add tabular data before running a query.'
            : '');
        return { engine, available: !engineReason, reason: engineReason };
      });
      const preferred = engines.find((option) => option.engine === format?.defaultEngine);
      return {
        // Retain the original fields as the default engine's status for older clients.
        engine: format?.defaultEngine || null,
        engines,
        format: format?.format || null,
        size: info.size,
        available: preferred?.available || false,
        reason: preferred?.reason ?? reason,
        readOnly: true,
        limits,
      };
    },
    async execute(resource, input, externalSignal) {
      const { format, script } = validateAnalysis(input);
      if (active >= limits.concurrency)
        throw analysisError(
          429,
          'ANALYSIS_BUSY',
          'Two analyses are already running. Wait for one to finish.',
        );
      active++;
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            analysisError(
              504,
              'ANALYSIS_TIMEOUT',
              'Analysis exceeded 15 seconds. Narrow the query or command.',
            ),
          ),
        limits.timeoutMs,
      );
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, controller.signal])
        : controller.signal;
      let directory;
      try {
        if (signal.aborted) throw abortError(signal);
        const source = await snapshot(resource, input.path, signal, false, limits.inputBytes);
        if (signal.aborted) throw abortError(signal);
        if (source.bytes.length > limits.inputBytes)
          throw analysisError(
            413,
            'ANALYSIS_INPUT_LIMIT',
            'This file exceeds the 16 MiB analysis limit. Download it instead.',
          );
        directory = await mkdtemp(join(tmpdir(), 'workspace-analysis-'));
        const sourcePath = join(directory, 'input.' + format);
        await writeFile(sourcePath, source.bytes, { mode: 0o600 });
        const result = await runner(
          { engine: input.engine, format, script, sourcePath, directory, limits },
          signal,
        );
        if (signal.aborted) throw abortError(signal);
        const output = {
          ...result,
          engine: input.engine,
          resourceId: resource.id,
          path: input.path,
          readOnly: true,
          inputBytes: source.bytes.length,
          durationMs: Math.round(performance.now() - started),
        };
        if (Buffer.byteLength(JSON.stringify(output)) > limits.outputBytes)
          throw analysisError(
            422,
            'ANALYSIS_OUTPUT_LIMIT',
            'Analysis output exceeds 1 MiB. Reduce the result size.',
          );
        return output;
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        throw error;
      } finally {
        clearTimeout(timer);
        if (directory) await rm(directory, { recursive: true, force: true });
        active--;
      }
    },
  };
}
