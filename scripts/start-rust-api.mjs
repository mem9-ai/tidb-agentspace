import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateJson } from '../server/meta/client.mjs';

// Optional npm/development launcher. Serving and internal Execute tasks use only the native artifact.
export async function startRustApi({ configFile, binary } = {}) {
  if (!configFile || !isAbsolute(configFile))
    throw new Error(
      'Set WORKSPACE_BACKEND_CONFIG to the absolute private Rust deployment file. See docs/rust-backend.md; no Node or demo-state fallback is started.',
    );
  const plan = await privateJson(configFile);
  if (plan.format !== 1 || !plan.services?.some((service) => service.kind === 'workspace'))
    throw new Error('The configured deployment must include a regional Workspace API role.');
  binary ||= fileURLToPath(
    new URL('../meta-service/target/debug/workspace-backend', import.meta.url),
  );
  if (!isAbsolute(binary)) throw new Error('WORKSPACE_BACKEND_BINARY must be absolute.');
  await access(binary, constants.X_OK).catch(() => {
    throw new Error(
      'Build the Rust backend with npm run backend:build, or set WORKSPACE_BACKEND_BINARY to the reviewed artifact.',
    );
  });
  const child = spawn(binary, ['serve', '--config', configFile], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  let stopping = false;
  const stop = (signal = 'SIGTERM') => {
    if (!stopping && child.exitCode === null && !child.signalCode) {
      stopping = true;
      child.kill(signal);
    }
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const exited = new Promise((resolve, reject) => {
    const cleanup = () => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          'Rust API startup did not become ready. Inspect configuration, metadata and Workspace writer ownership.',
        ),
      );
    }, 30000);
    child.stdout.on('data', (bytes) => {
      process.stdout.write(bytes);
      output = (output + bytes.toString()).slice(-8192);
      if (/Rust (?:full regional API|workspace-keys-only profile) listening on /.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    });
    exited.then(
      () => {
        clearTimeout(timer);
        reject(new Error('Rust API exited before becoming ready.'));
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  await ready;
  return {
    child,
    exited,
    async close() {
      stop();
      await exited;
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const api = await startRustApi({
      configFile: process.env.WORKSPACE_BACKEND_CONFIG,
      binary: process.env.WORKSPACE_BACKEND_BINARY,
    });

    const { code, signal } = await api.exited;
    if (code) process.exitCode = code;
    else if (signal && !['SIGINT', 'SIGTERM'].includes(signal)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
