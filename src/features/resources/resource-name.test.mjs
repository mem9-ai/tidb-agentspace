import assert from 'node:assert/strict';
import test from 'node:test';
import { generateResourceName } from './resource-name.ts';

const fixedId = () => '01234567-89ab-4cde-8f01-23456789abcd';

test('PostgreSQL database names fit the public name contract', () => {
  const name = generateResourceName('postgresql', [], fixedId);
  assert.ok(name.startsWith('tidb_pg-'));
  assert.match(name, /^[a-z][a-z0-9_-]{2,39}$/);
});

test('file system suggestions use readable words and fit the public name contract', () => {
  const first = generateResourceName('filesystem', [], fixedId);
  const another = generateResourceName(
    'filesystem',
    [],
    () => 'ffffaaaa-89ab-4cde-8f01-23456789abcd',
  );
  assert.match(first, /^[a-z]+-[a-z]+$/);
  assert.match(another, /^[a-z]+-[a-z]+$/);
  assert.match(first, /^[a-z][a-z0-9-]{2,39}$/);
  assert.notEqual(first, another);
});

test('all occupied workspace names are avoided even when entropy repeats', () => {
  const root = generateResourceName('postgresql', [], fixedId);
  const resources = Object.freeze(
    [root, `${root}-2`, `${root}-3`, 'another-resource'].map((name) => Object.freeze({ name })),
  );
  const name = generateResourceName('postgresql', resources, fixedId);
  assert.ok(!resources.some((resource) => resource.name === name));
  assert.match(name, /^[a-z][a-z0-9_-]{2,39}$/);
  assert.equal(resources.length, 4);
});

test('a refreshed resource snapshot prevents reusing an earlier generated name', () => {
  const first = generateResourceName('filesystem', [], fixedId);
  const second = generateResourceName('filesystem', [{ name: first }], fixedId);
  assert.equal(second, `${first}-2`);
  const third = generateResourceName('filesystem', [{ name: first }, { name: second }], fixedId);
  assert.equal(third, `${first}-3`);
});
