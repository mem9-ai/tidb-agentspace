import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fileHash,
  fileSystemHash,
  parseFileLocation,
  parseFileSystemLocation,
} from './file-location.ts';
import { parseWorkspaceRoute } from '../navigation/workspace-route.ts';
test('selected file analysis links preserve exact resource/path/view across reload', () => {
  for (const path of ['/orders.csv', '/a folder/数据?#%&.parquet']) {
    const hash = fileHash('fs:selected', path, 'analyze');
    assert.deepEqual(parseFileLocation(hash), { resourceId: 'fs:selected', path, view: 'analyze' });
    assert.deepEqual(parseFileSystemLocation(hash), {
      resourceId: 'fs:selected',
      file: { resourceId: 'fs:selected', path, view: 'analyze' },
      invalidFile: false,
    });
    assert.deepEqual(parseWorkspaceRoute(hash), { page: 'files', fileLink: hash.slice(1) });
  }
});
test('the File System landing route has no selected resource; resource links retain exact IDs', () => {
  for (const hash of ['#files', '#files?', '#files?resourceId=', '#files?path=/orders.csv'])
    assert.equal(parseFileSystemLocation(hash), null);
  for (const resourceId of ['fs_local', 'fs_live', 'missing', 'file system / %?#&']) {
    const hash = fileSystemHash(resourceId);
    assert.deepEqual(parseFileSystemLocation(hash), { resourceId, file: null, invalidFile: false });
    assert.equal(parseFileLocation(hash), null);
    assert.deepEqual(parseWorkspaceRoute(hash), { page: 'files', fileLink: hash.slice(1) });
  }
});
test('malformed file links preserve the explicit resource without selecting another File System', () => {
  for (const tail of ['path=/../orders.csv', 'path=relative.csv', 'path=/a%00b', 'view=analyze'])
    assert.deepEqual(parseFileSystemLocation('#files?resourceId=fs_local&' + tail), {
      resourceId: 'fs_local',
      file: null,
      invalidFile: true,
    });
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
