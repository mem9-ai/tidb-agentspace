import test from 'node:test';
import assert from 'node:assert/strict';
import { regionLabel } from './regions.ts';

test('region labels distinguish Singapore and preserve unknown IDs instead of calling them Oregon', () => {
  assert.equal(regionLabel('aws-ap-southeast-1'), 'AWS · Singapore');
  assert.equal(regionLabel('aws-us-west-2'), 'AWS · Oregon');
  assert.equal(regionLabel('aws-us-east-1'), 'AWS · N. Virginia');
  assert.equal(regionLabel('future-provider-region'), 'future-provider-region');
});
