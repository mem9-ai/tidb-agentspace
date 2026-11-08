import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeImageInput } from './ci-image-inputs.mjs';

test('image validation covers native/build/delivery inputs and excludes Console/docs-only changes', () => {
  for (const path of [
    'backend/api/src/lib.rs',
    'meta-service/src/main.rs',
    'specs/gh-150/fixtures/us-sales.csv',
    'Cargo.lock',
    'Cargo.toml',
    'rust-toolchain.toml',
    '.cargo/config.toml',
    'scripts/duckdb-runtime.json',
    'backend/build-tools/src/duckdb.rs',
    'LICENSE',
    '.github/workflows/ci.yml',
    '.github/workflows/dev-cd.yml',
    'Dockerfile',
    'scripts/deploy-dev.mjs',
    'scripts/ci-image-inputs.mjs',
  ])
    assert.equal(nativeImageInput(path), true, path);
  for (const path of [
    'public/openapi.json',
    'public/owner-openapi.json',
    'public/global-openapi.json',
    'public/agent-entry-openapi.json',
    'public/operator-openapi.json',
    'package.json',
    'package-lock.json',
    '.node-version',
    'src/App.tsx',
    'docs/architecture.md',
    'console/public/config.json',
    'scripts/deploy-dev.test.mjs',
  ])
    assert.equal(nativeImageInput(path), false, path);
});
