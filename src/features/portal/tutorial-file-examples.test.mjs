import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceApiError } from '../../api/transport.ts';
import { openFileExample } from './tutorial-file-examples.ts';
import { fileExamples } from './tutorial-data.ts';

const id = 'a'.repeat(32);
test('examples use explicit create-only writes and reopen without overwriting edits', async () => {
  const files = new Map();
  const writes = [];
  const api = {
    async previewFile({ path }) {
      if (!files.has(path)) throw new WorkspaceApiError('Not found', 404);
      return { content: files.get(path), size: 0 };
    },
    async createSampleFile(body) {
      assert.equal(files.has(body.path), false);
      files.set(body.path, body.content);
      writes.push(body);
      return {};
    },
    async uploadFile(file, content) {
      assert.equal(files.has(file.path), false);
      files.set(file.path, await content.text());
      writes.push(file);
      return {};
    },
  };
  const notes = await openFileExample(api, 'fs', 'local', id, 'notes');
  assert.equal(files.get(notes), fileExamples.notes.content);
  files.set(notes, 'My edits');
  assert.equal(await openFileExample(api, 'fs', 'local', id, 'notes'), notes);
  assert.equal(files.get(notes), 'My edits');
  const log = await openFileExample(api, 'fs', 'drive9-anonymous', id, 'log');
  assert.equal(files.get(log), fileExamples.log.content);
  assert.equal(writes.length, 2);
});

test('only a missing file permits creation; uncertain writes are never retried automatically', async () => {
  let writes = 0;
  const api = {
    async previewFile() {
      throw new WorkspaceApiError('Unavailable', 403);
    },
    async createSampleFile() {
      writes++;
      throw new Error('unconfirmed');
    },
    async uploadFile() {
      writes++;
      throw new Error('unconfirmed');
    },
  };
  await assert.rejects(openFileExample(api, 'fs', 'local', id, 'notes'), /Unavailable/);
  assert.equal(writes, 0);
  api.previewFile = async () => {
    throw new WorkspaceApiError('Not found', 404);
  };
  await assert.rejects(openFileExample(api, 'fs', 'local', id, 'notes'), /unconfirmed/);
  assert.equal(writes, 1);
});
