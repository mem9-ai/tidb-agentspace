import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCutover } from './cutover-diagnostics.mjs';

test('cutover diagnosis distinguishes unbound storage and container errors without exposing logs or configuration', () => {
  const calls = [];
  const name = 'workspace-global-12345678-abc';
  const jobUid = '11111111-1111-4111-8111-111111111111';
  const objectUid = '22222222-2222-4222-8222-222222222222';
  const secret = 'never-print-private-token';
  const result = inspectCutover({ namespace: 'dev', deployment: 'workspace' }, (args) => {
    calls.push(args);
    const data = (value) => JSON.stringify(value);
    if (args[1] === 'jobs')
      return data({
        items: [
          {
            metadata: { name, uid: jobUid },
            status: {
              failed: 1,
              conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
            },
          },
          { metadata: { name: 'another-team-job', uid: jobUid } },
        ],
      });
    if (args[1] === 'storageclasses')
      return data({
        items: [
          {
            metadata: { name: 'gp3' },
            provisioner: 'ebs.csi.aws.com',
            volumeBindingMode: 'WaitForFirstConsumer',
          },
        ],
      });
    if (args[1] === 'csidrivers')
      return data({ items: [{ metadata: { name: 'ebs.csi.aws.com' } }] });
    if (args[1] === 'pvc' && args[2] === '-n')
      return data({ items: [{ spec: { storageClassName: 'gp3' }, status: { phase: 'Bound' } }] });
    if (args[1] === 'pvc')
      return data({ metadata: { uid: objectUid }, spec: {}, status: { phase: 'Pending' } });
    if (args[1] === 'events')
      return data({
        items: [{ reason: 'FailedBinding', message: `no storage class is set ${secret}` }],
      });
    if (args[1] === 'pods')
      return data({
        items: [
          {
            metadata: { name: name + '-pod', uid: objectUid, ownerReferences: [{ uid: jobUid }] },
            spec: { env: secret },
            status: {
              phase: 'Failed',
              containerStatuses: [
                {
                  name: 'api',
                  ready: false,
                  state: { terminated: { reason: 'Error', exitCode: 1 } },
                },
              ],
            },
          },
        ],
      });
    if (args[0] === 'logs') return `Error: AccessDenied ${secret}`;
    assert.fail('Unexpected read');
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.storageClasses[0].default, false);
  assert.equal(result.candidates[0].volume.phase, 'Pending');
  assert.deepEqual(result.candidates[0].volume.events[0].indicators, ['storage-class-missing']);
  assert.deepEqual(result.candidates[0].pods[0].containers[0].indicators, [
    'storage-authorization-denied',
    'process-error',
  ]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(calls.every((args) => ['get', 'logs'].includes(args[0])));
  assert.ok(!calls.some((args) => args.includes('another-team-job')));
});

test('unavailable storage inventory and logs remain explicit without echoing provider errors', () => {
  const result = inspectCutover({ namespace: 'dev', deployment: 'workspace' }, () => {
    throw new Error('private-provider-detail');
  });
  assert.equal(result.jobsReadable, false);
  assert.equal(result.storageClasses, null);
  assert.ok(!JSON.stringify(result).includes('private-provider-detail'));
  assert.throws(
    () => inspectCutover({ namespace: '../dev', deployment: 'workspace' }, () => assert.fail()),
    /Invalid diagnostic target/,
  );
});
