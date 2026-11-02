import assert from 'node:assert/strict';
import test from 'node:test';
import { completedSuite } from './run-history-integration.mjs';

test('history integration gate rejects skipped, missing and failed cases', () => {
  const names = ['one', 'two'];
  const success = { status: 0, stdout: 'ok 1 - one\nok 2 - two\n# pass 2\n' };
  assert.equal(completedSuite(names, success), true);
  assert.equal(completedSuite(names, { ...success, status: 1 }), false);
  assert.equal(
    completedSuite(names, { status: 0, stdout: 'ok 1 - one\nok 2 - two # SKIP\n# pass 1\n' }),
    false,
  );
  assert.equal(completedSuite(names, { status: 0, stdout: 'ok 1 - one\n# pass 2\n' }), false);
  assert.equal(
    completedSuite(names, { status: 0, stdout: 'ok 1 - one\nok 2 - two\n# pass 1\n' }),
    false,
  );
  assert.equal(completedSuite(names, { status: null, stdout: '' }), false);
});
