import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { files, fullCommand, partition } from './ci-full-integration.mjs';

test('only the documented native gate and recognized GitHub events may run the separate partitions', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts['backend:test:integration'], fullCommand);
  assert.equal(new Set(files).size, files.length);
  for (const event of ['pull_request', 'push'])
    assert.equal(await partition(fullCommand, event), true);
  for (const event of ['workflow_dispatch', 'merge_group', 'unknown', ''])
    assert.equal(await partition(fullCommand, event), false);
  for (const command of [
    undefined,
    '',
    'cargo test',
    'cargo acceptance product',
    fullCommand + ' && true',
  ])
    assert.equal(await partition(command, 'pull_request'), false);
});
