// Synthetic native record input. This is never loaded by a product runtime.
export function workspaceFixture() {
  const now = new Date().toISOString();
  return {
    workspace: {
      id: 'ws_agentlab',
      name: 'Fixture workspace',
      description: 'Isolated native integration test',
      plan: 'Free',
      createdAt: now,
    },
    profile: { name: 'Fixture owner', email: '', role: 'Local developer' },
    resources: [
      {
        id: 'db_memory',
        name: 'fixture-mysql',
        kind: 'mysql',
        region: 'aws-us-east-1',
        status: 'active',
        createdAt: now,
      },
      {
        id: 'fs_shared',
        name: 'fixture-files',
        kind: 'filesystem',
        region: 'aws-ap-southeast-1',
        status: 'active',
        createdAt: now,
      },
    ],
    files: [],
    keys: [],
    events: [],
    queryCount: 0,
    resourceQueryCounts: {},
    idempotency: {},
  };
}
