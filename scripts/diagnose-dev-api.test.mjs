import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose } from './diagnose-dev-api.mjs';

test('diagnostics report only safe bounded status and fixed error labels', () => {
  const calls = [];
  const result = diagnose({ namespace: 'dev', deployment: 'api', container: 'api' }, (args) => {
    calls.push(args);
    if (args[1] === 'deployment/api')
      return JSON.stringify({
        spec: { replicas: 1, selector: { matchLabels: { app: 'api' } } },
        status: {},
      });
    if (args[1] === 'pods')
      return JSON.stringify({
        items: [
          {
            metadata: { name: 'api-123' },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'api',
                  ready: false,
                  restartCount: 3,
                  lastState: { terminated: { exitCode: 1 } },
                },
              ],
            },
          },
        ],
      });
    return 'private-synthetic-secret Workspace startup unavailable for region:private';
  });
  assert.deepEqual(result.pods[0].indicators, ['workspace-startup-unavailable']);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!calls.some((args) => ['set', 'delete', 'rollout'].includes(args[0])));
});

test('diagnostics distinguish forbidden logs without exposing private errors', () => {
  const result = diagnose({ namespace: 'dev', deployment: 'api', container: 'api' }, (args) => {
    if (args[1] === 'deployment/api')
      return JSON.stringify({
        spec: { replicas: 1, selector: { matchLabels: { app: 'api' } } },
        status: {},
      });
    if (args[1] === 'pods')
      return JSON.stringify({
        items: [{ metadata: { name: 'api-123' }, status: { phase: 'Running' } }],
      });
    const error = new Error('private value');
    error.stderr = 'Forbidden private value';
    throw error;
  });
  assert.equal(result.pods[0].logReads, 0);
  assert.equal(result.pods[0].logAccessDenied, true);
  assert.ok(!JSON.stringify(result).includes('private value'));
});

test('permission checks expose only booleans and never change cluster state', () => {
  const calls = [];
  const result = diagnose({ namespace: 'dev', deployment: 'api', container: 'api' }, (args) => {
    calls.push(args);
    if (args[1] === 'deployment/api')
      return JSON.stringify({
        spec: { replicas: 1, selector: { matchLabels: { app: 'api' } } },
        status: {},
      });
    if (args[1] === 'pods') return JSON.stringify({ items: [] });
    if (args[0] === 'auth') return args[2] === 'create' ? 'no\n' : 'yes\n';
    throw new Error('unexpected');
  });
  assert.deepEqual(result.permissions, {
    createSecrets: false,
    patchSecrets: true,
    patchDeployments: true,
    listSecrets: true,
  });
  assert.ok(!calls.some((args) => ['delete', 'rollout'].includes(args[0])));
  assert.ok(
    calls
      .filter((args) => ['create', 'patch'].includes(args[0]))
      .every((args) => args.includes('--dry-run=server')),
  );
});

test('server dry-run reports fixed error categories and detects replacement copies without outputting names', () => {
  const calls = [];
  const result = diagnose(
    { namespace: 'dev', deployment: 'api', container: 'api' },
    (args, input) => {
      calls.push({ args, input });
      if (args[0] === 'get' && args[1] === 'deployment/api')
        return JSON.stringify({
          metadata: { resourceVersion: '5' },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: 'api' } },
            template: { spec: { volumes: [{ secret: { secretName: 'private-config' } }] } },
          },
          status: {},
        });
      if (args[0] === 'get' && args[1] === 'pods') return JSON.stringify({ items: [] });
      if (args[0] === 'auth') return 'yes';
      if (args[0] === 'get' && args[1] === 'secrets')
        return 'private-config private-config-execute-123456abcdef';
      if (args[0] === 'create') {
        const error = new Error('private');
        error.stderr = 'Forbidden private';
        throw error;
      }
      if (args[0] === 'patch') return 'deployment/api';
      throw new Error('unexpected');
    },
  );
  assert.deepEqual(result.repairProbe, {
    createDryRun: 'denied',
    patchDryRun: 'accepted',
    replacementCopies: 1,
  });
  assert.ok(!JSON.stringify(result).includes('private-config'));
  assert.ok(
    calls
      .filter(({ args }) => ['create', 'patch'].includes(args[0]))
      .every(({ args }) => args.includes('--dry-run=server')),
  );
});
