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
