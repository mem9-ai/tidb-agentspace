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
