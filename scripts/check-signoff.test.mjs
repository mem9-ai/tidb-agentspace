import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSignoff } from './check-signoff.mjs';

const author = { name: 'Original Author', email: 'author@example.com' };
const committer = { name: 'Siddon Tang', email: 'siddontang@gmail.com' };
test('DCO accepts an actual author or committer trailer and preserves attribution', () => {
  assert.equal(
    hasSignoff(
      'fix(api): validate input\n\nSigned-off-by: Original Author <author@example.com>\n',
      [author, committer],
    ),
    true,
  );
  assert.equal(
    hasSignoff('fix(api): validate input\n\nSigned-off-by: Siddon Tang <siddontang@gmail.com>\n', [
      author,
      committer,
    ]),
    true,
  );
});
test('DCO rejects another identity, unsigned messages, and sign-off text in prose', () => {
  assert.equal(hasSignoff('fix(api): validate input\n', [author]), false);
  assert.equal(
    hasSignoff('fix(api): validate input\n\nSigned-off-by: Someone Else <else@example.com>\n', [
      author,
    ]),
    false,
  );
  assert.equal(
    hasSignoff(
      'fix(api): validate input\n\nSigned-off-by: Original Author <author@example.com>\n\nThis is prose, not a trailer block.\n',
      [author],
    ),
    false,
  );
});
