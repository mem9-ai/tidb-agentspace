import type { Resource } from '../../api/client';

/** Keep recent pages bounded while retaining an explicitly selected resource. */
export function resourceWindow(previous: Resource[], incoming: Resource[], selectedId?: string) {
  const limit = 200;
  const combined = new Map(previous.map((resource) => [resource.id, resource]));
  for (const resource of incoming) combined.set(resource.id, resource);
  const all = [...combined.values()];
  if (all.length <= limit) return { resources: all, dropped: false };
  const recent = all.slice(-limit);
  const selected = selectedId && combined.get(selectedId);
  if (selected && !recent.some((resource) => resource.id === selectedId)) {
    recent.shift();
    recent.unshift(selected);
  }
  return { resources: recent, dropped: true };
}
