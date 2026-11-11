import assert from 'node:assert/strict';
import test from 'node:test';
import { isBoundedApiPath } from './api-path.ts';

test('bounded API paths accept only fixed ASCII segments', () => {
  for (const value of ['/', '/studio', '/studio/', '/studio/api', '/studio/api/', '/a-b_c/9'])
    assert.equal(isBoundedApiPath(value), true, value);
  for (const value of [
    '',
    'studio',
    '//',
    '/studio//api',
    '/studio/../admin',
    '/studio/./api',
    '/studio api',
    '/studio%2fapi',
    '/studio?x=1',
    '/studio#fragment',
    '/studio.api',
    '/studío',
  ])
    assert.equal(isBoundedApiPath(value), false, value);
});

test('hostile path input is rejected without exponential backtracking', { timeout: 1000 }, () => {
  assert.equal(isBoundedApiPath(`/${'-'.repeat(100_000)}!`), false);
  assert.equal(isBoundedApiPath(`/${'-'.repeat(100_000)}`), true);
});
