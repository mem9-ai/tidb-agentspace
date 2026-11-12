import type { components, operations } from './schema';

type Capability = components['schemas']['Capability'];
type Creation = operations['createResource']['requestBody']['content']['application/json'];
export type KnownKind = Creation['kind'];

const locations: readonly Creation['region'][] = [
  'automatic',
  'aws-us-east-1',
  'aws-us-west-2',
  'aws-ap-southeast-1',
];

function supportsProvider(kind: string, provider?: string) {
  return (
    (kind === 'filesystem' || kind === 'postgresql') &&
    (!provider ||
      provider === 'local' ||
      (kind === 'filesystem' ? provider === 'drive9-anonymous' : provider === 'db9-anonymous'))
  );
}

export function supportsResource(resource: components['schemas']['Resource']) {
  return supportsProvider(resource.kind, resource.provider);
}

function creationCapability(kind: KnownKind, capability: Capability) {
  const regions = capability.regions.filter((region): region is Creation['region'] =>
    locations.some((known) => known === region),
  );
  return { ...capability, regions: supportsProvider(kind, capability.provider) ? regions : [] };
}

export function consoleCapabilities(capabilities: components['schemas']['Capabilities']) {
  return {
    postgresql: creationCapability('postgresql', capabilities.postgresql),
    filesystem: creationCapability('filesystem', capabilities.filesystem),
  };
}
