import type { Resource } from '../../api/client';

const fileSystemAdjectives = [
  'bright',
  'calm',
  'clear',
  'clever',
  'cozy',
  'gentle',
  'golden',
  'happy',
  'little',
  'lively',
  'lucky',
  'quiet',
  'silver',
  'sunny',
  'swift',
  'warm',
];
const fileSystemNouns = [
  'acorn',
  'badger',
  'brook',
  'cloud',
  'comet',
  'forest',
  'garden',
  'harbor',
  'island',
  'meadow',
  'orbit',
  'otter',
  'panda',
  'river',
  'sparrow',
  'willow',
];

export function generateResourceName(
  kind: Resource['kind'],
  resources: readonly Pick<Resource, 'name'>[],
  randomId: () => string = () => crypto.randomUUID(),
): string {
  const usedNames = new Set(resources.map((resource) => resource.name));
  const random = randomId().replaceAll('-', '');
  const base =
    kind === 'filesystem'
      ? `${fileSystemAdjectives[parseInt(random.slice(0, 4), 16) % fileSystemAdjectives.length]}-${fileSystemNouns[parseInt(random.slice(4, 8), 16) % fileSystemNouns.length]}`
      : `tidb_pg-${random.slice(0, 16)}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}
