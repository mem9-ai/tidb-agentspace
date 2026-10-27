import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSignoff } from './check-signoff.mjs';

const author = { name: 'Original Author', email: 'author@example.com' };
const committer = { name: 'Siddon Tang', email: 'siddontang@gmail.com' };
const dependabot = {
  name: 'dependabot[bot]',
  email: '49699333+dependabot[bot]@users.noreply.github.com',
};
const dependabotMessage = `build(deps): update an action

Bumps actions/setup-node to a reviewed version.

---
updated-dependencies:
- dependency-name: actions/setup-node
  update-type: version-update:semver-major
...

Signed-off-by: dependabot[bot] <support@github.com>
`;
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

test('DCO recognizes the GitHub Dependabot sign-off email without rewriting attribution', () => {
  assert.equal(hasSignoff(dependabotMessage, [dependabot]), true);
  assert.equal(
    hasSignoff(
      `build(deps): update an action\n\nSigned-off-by: ${dependabot.name} <${dependabot.email}>\n`,
      [dependabot],
    ),
    true,
  );
});

test('DCO reads a human trailer after body dividers without accepting earlier prose', () => {
  assert.equal(
    hasSignoff(
      dependabotMessage.replace(
        'dependabot[bot] <support@github.com>',
        'Original Author <author@example.com>',
      ),
      [author],
    ),
    true,
  );
  assert.equal(
    hasSignoff(
      'fix(api): validate input\n\nSigned-off-by: Original Author <author@example.com>\n\n---\nBody continues without a final sign-off.\n',
      [author],
    ),
    false,
  );
});

test('DCO does not exempt unsigned bots or accept aliases for other identities', () => {
  assert.equal(hasSignoff('build(deps): update an action\n', [dependabot]), false);
  assert.equal(hasSignoff(dependabotMessage, [author, committer]), false);
  assert.equal(
    hasSignoff(dependabotMessage, [{ name: 'another[bot]', email: dependabot.email }]),
    false,
  );
  assert.equal(
    hasSignoff(dependabotMessage, [{ name: dependabot.name, email: 'other@example.com' }]),
    false,
  );
  assert.equal(
    hasSignoff(dependabotMessage.replace('support@github.com', 'other@example.com'), [dependabot]),
    false,
  );
  assert.equal(
    hasSignoff(`${dependabotMessage}\nThis is prose, not a trailer block.\n`, [dependabot]),
    false,
  );
});
