import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { completedSuite, groupedCases } from './run-classic-integration.mjs';

test('classic profile verifies every parent and nested test actually passed', () => {
  const cases = [
    { name: 'journey', count: 3 },
    { name: 'boundary', count: 1 },
  ];
  const good = {
    status: 0,
    stdout:
      '    ok 1 - child a\n    ok 2 - child b\nok 1 - journey\nok 2 - boundary\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
  };
  assert.equal(completedSuite(cases, good), true);
  assert.equal(completedSuite(cases, { ...good, status: 1 }), false);
  assert.equal(completedSuite(cases, { ...good, status: null }), false);
  assert.equal(
    completedSuite(cases, {
      ...good,
      stdout: good.stdout.replace('ok 2 - boundary', 'ok 2 - boundary # SKIP'),
    }),
    false,
  );
  assert.equal(
    completedSuite(cases, { ...good, stdout: good.stdout.replace('# skipped 0', '# skipped 1') }),
    false,
  );
  assert.equal(
    completedSuite(cases, { ...good, stdout: good.stdout.replace('# pass 4', '# pass 3') }),
    false,
  );
  assert.equal(
    completedSuite(cases, {
      ...good,
      stdout: good.stdout.replace('ok 1 - journey', 'not ok 1 - journey'),
    }),
    false,
  );
  assert.equal(
    completedSuite(cases, {
      ...good,
      stdout: good.stdout.replace('# cancelled 0', '# cancelled 1'),
    }),
    false,
  );
  assert.equal(
    completedSuite(cases, { ...good, stdout: good.stdout.replace('# todo 0', '# todo 1') }),
    false,
  );
  assert.throws(() => groupedCases('unknown'));
  for (const profile of ['classic', 'tutorial', 'database', 'files'])
    assert.ok(groupedCases(profile).size > 0);
});

test('CI loads both the policy and selected manifest from the trusted merge base', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /fetch-depth: 2/);
  assert.match(workflow, /git show 'HEAD\^1:scripts\/ci-classic-scope\.mjs'/);
  assert.match(workflow, /git show 'HEAD\^1:scripts\/run-classic-integration\.mjs'/);
  assert.match(workflow, /classic_profile=full/);
  assert.match(workflow, /needs\.scope\.outputs\.history_only != 'true' && !contains\(fromJSON/);
  assert.match(workflow, /node "\$runner" "\$CLASSIC_PROFILE"/);
});
