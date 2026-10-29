import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { privateJson, createMetaClient } from './client.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
const config = await privateJson(resolve(values.config));
const client = await createMetaClient(config.region);
try {
  const scope = {
    authorityId: config.region.authorityId,
    ownerKind: 'system',
    ownerId: 'compatibility',
    family: 'legacy-gateway',
    partitionId: config.workspaceId,
  };
  const result = await client.call({ op: 'snapshot', scope });
  console.log(
    JSON.stringify({
      authorityId: config.region.authorityId,
      gatewayOwnerId: result.records.ownerId || null,
    }),
  );
} finally {
  client.close();
}
