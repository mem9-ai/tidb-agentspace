import assert from 'node:assert/strict';
import test from 'node:test';
import { fileHash, parseFileLocation } from './file-location.ts';
import { parseWorkspaceRoute } from '../navigation/workspace-route.ts';
test('selected file analysis links preserve exact resource/path/view across reload', () => {
  for (const path of ['/orders.csv', '/a folder/数据?#%&.parquet']) {
    const hash = fileHash('fs:selected', path, 'analyze');
    assert.deepEqual(parseFileLocation(hash), { resourceId: 'fs:selected', path, view: 'analyze' });
    assert.deepEqual(parseWorkspaceRoute(hash), { page: 'files', fileLink: hash.slice(1) });
  }
});
test('file context rejects incomplete, traversal and unsupported views', () => {
  for (const hash of [
    '#files',
    '#files?resourceId=fs&path=/',
    '#files?resourceId=fs&path=/../x',
    '#files?resourceId=fs&path=/x&view=terminal',
    '#files?resourceId=fs&path=/a%00b',
  ])
    assert.equal(parseFileLocation(hash), null);
});
