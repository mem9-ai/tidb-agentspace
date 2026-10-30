import assert from 'node:assert/strict';
import test from 'node:test';
import { generateResourceName } from './resource-name.ts';

const fixedId = () => '01234567-89ab-4cde-8f01-23456789abcd';

test('automatic names identify each resource kind and fit the public name contract', () => {
  for (const kind of ['mysql', 'postgresql', 'duckdb', 'filesystem']) {
    const name = generateResourceName(kind, [], fixedId);
    assert.ok(name.startsWith(kind + '-'));
    assert.match(name, /^[a-z][a-z0-9-]{2,39}$/);
  }
});

test('all occupied workspace names are avoided even when entropy repeats', () => {
  const root = generateResourceName('duckdb', [], fixedId);
  const resources = Object.freeze(
    [root, `${root}-2`, `${root}-3`, 'another-resource'].map((name) => Object.freeze({ name })),
  );
  const name = generateResourceName('duckdb', resources, fixedId);
  assert.ok(!resources.some((resource) => resource.name === name));
  assert.match(name, /^[a-z][a-z0-9-]{2,39}$/);
  assert.equal(resources.length, 4);
});

test('a refreshed resource snapshot prevents reusing an earlier generated name', () => {
  const first = generateResourceName('filesystem', [], fixedId);
  const second = generateResourceName('filesystem', [{ name: first }], fixedId);
  assert.notEqual(second, first);
  const third = generateResourceName('filesystem', [{ name: first }, { name: second }], fixedId);
  assert.notEqual(third, first);
  assert.notEqual(third, second);
});
