import type { Resource } from '../../api/client';

export function generateResourceName(
  kind: Resource['kind'],
  resources: readonly Pick<Resource, 'name'>[],
  randomId: () => string = () => crypto.randomUUID(),
): string {
  const usedNames = new Set(resources.map((resource) => resource.name));
  const base = `${kind}-${randomId().replaceAll('-', '').slice(0, 16)}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}
