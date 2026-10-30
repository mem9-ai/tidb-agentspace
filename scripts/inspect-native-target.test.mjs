import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectNativeTarget } from './inspect-native-target.mjs';
test('deployment inspection reads only referenced configuration and never reports values', () => {
  const calls = [];
  const secret = 'private-never-log-credential';
  const result = inspectNativeTarget(
    { namespace: 'dev', deployment: 'api', container: 'api' },
    (args) => {
      calls.push(args);
      if (args[1] === 'deployment')
        return JSON.stringify({
          spec: {
            replicas: 1,
            strategy: { type: 'Recreate' },
            template: {
              spec: {
                containers: [
                  {
                    name: 'api',
                    env: [{ name: 'SSO_CLIENT_ID', value: 'public-client' }],
                    envFrom: [{ secretRef: { name: 'runtime' } }],
                  },
                ],
              },
            },
          },
        });
      return JSON.stringify({
        data: {
          'config.json': Buffer.from(
            JSON.stringify({ s3: { bucket: 'existing-private-bucket', secretAccessKey: secret } }),
          ).toString('base64'),
        },
      });
    },
  );
  assert.ok(result.configurationObjects[0].fields.includes('config.json.s3.bucket'));
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('existing-private-bucket'));
  assert.ok(calls.every((c) => c[0] === 'get'));
  assert.equal(calls.length, 2);
});

test('S3 discovery reports only bounded project hints, region and project tags without reading objects', async () => {
  const { discoverProjectStorage } = await import('./inspect-native-target.mjs');
  const calls = [];
  const report = discoverProjectStorage((args) => {
    calls.push(args);
    if (args[1] === 'list-buckets')
      return JSON.stringify({
        Buckets: [{ Name: 'unrelated-customer-bucket' }, { Name: 'drive9-dev-storage' }],
        Owner: { ID: 'private-account-identity' },
        NextToken: 'private-pagination-token',
      });
    if (args[1] === 'head-bucket') return JSON.stringify({ BucketRegion: 'us-west-2' });
    if (args[1] === 'get-bucket-tagging')
      return JSON.stringify({
        TagSet: [
          { Key: 'project', Value: 'drive9' },
          { Key: 'private-note', Value: 'never-print-this' },
        ],
      });
    assert.fail('Unexpected AWS operation');
  });
  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0].region, 'us-west-2');
  assert.deepEqual(report.buckets[0].projectTags, { project: 'drive9' });
  assert.equal(report.truncated, true);
  const text = JSON.stringify(report);
  for (const value of [
    'unrelated-customer',
    'private-account',
    'private-pagination',
    'never-print-this',
  ])
    assert.ok(!text.includes(value));
  assert.deepEqual(
    calls.map((c) => c[1]),
    ['list-buckets', 'head-bucket', 'get-bucket-tagging'],
  );
});

test('S3 discovery distinguishes missing authorization without printing provider error details', async () => {
  const { discoverProjectStorage } = await import('./inspect-native-target.mjs');
  const report = discoverProjectStorage(() => {
    throw Object.assign(new Error('sensitive-provider-detail'), {
      stderr: Buffer.from('AccessDenied private-role-id'),
    });
  });
  assert.equal(report.status, 'permission-denied');
  assert.deepEqual(report.buckets, []);
  assert.ok(!JSON.stringify(report).includes('private-role-id'));
});

test('S3 discovery bounds metadata requests and preserves known regions when tag access is denied', async () => {
  const { discoverProjectStorage } = await import('./inspect-native-target.mjs');
  let requests = 0;
  const report = discoverProjectStorage((args) => {
    requests++;
    if (args[1] === 'list-buckets')
      return JSON.stringify({
        Buckets: Array.from({ length: 12 }, (_, i) => ({
          Name: `mem9-storage-${i}`,
          BucketRegion: 'us-east-1',
        })),
      });
    if (args[1] === 'get-bucket-tagging') throw { stderr: 'AccessDenied' };
    assert.fail('Known region should avoid a second request');
  });
  assert.equal(requests, 9);
  assert.equal(report.buckets.length, 8);
  assert.equal(report.buckets[0].tagStatus, 'permission-denied');
  assert.equal(report.truncated, true);
});
