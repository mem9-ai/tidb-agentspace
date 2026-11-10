import { useEffect, useRef, useState } from 'react';
import { Checkbox, SegmentedControl, Stack, Text, TextInput } from '@tidbcloud/uikit';

import { workspaceApi, type KeyResourceType, type Resource } from '../../api/client';
type ResourceAccessPickerProps = {
  resources: Resource[];
  resourceTypes?: KeyResourceType[];
  hasUnloaded: boolean;
  remember: (r: Resource) => void;
  resourceIds: string[];
  onChange: (resourceIds: string[], types?: KeyResourceType[]) => void;
};
export function ResourceAccessPicker({
  resources,
  resourceTypes,
  hasUnloaded,
  remember,
  resourceIds,
  onChange,
}: ResourceAccessPickerProps) {
  const allResources = resourceIds.includes('*');
  const previousSelection = useRef(resourceIds.filter((id) => id !== '*'));
  const [search, setSearch] = useState('');
  const [lookup, setLookup] = useState<{ term: string; rows: Resource[]; error?: boolean }>();
  const term = search.trim().toLowerCase();
  const remote = hasUnloaded && !allResources && !resourceTypes && Boolean(term);
  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      workspaceApi.resourcesNamed(term, controller.signal).then(
        (page) => {
          if (!controller.signal.aborted) setLookup({ term, rows: page.data });
        },
        () => {
          if (!controller.signal.aborted) setLookup({ term, rows: [], error: true });
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [term, remote]);
  const matching = resources.filter(
    (r) => r.name.toLowerCase().includes(term) || r.id.toLowerCase().includes(term),
  );
  if (remote && lookup?.term === term) {
    for (const row of lookup.rows) if (!matching.some((r) => r.id === row.id)) matching.push(row);
  }
  return (
    <section aria-label="Resource access" className="key-access-section">
      <Text fw={600}>Resources</Text>
      {!allResources && (
        <SegmentedControl
          mt="sm"
          aria-label="Resource scope"
          value={resourceTypes ? 'types' : 'specific'}
          data={[
            { value: 'specific', label: 'Specific resources' },
            { value: 'types', label: 'By resource type' },
          ]}
          onChange={(mode) => {
            if (mode === 'types') {
              previousSelection.current = resourceIds.filter((id) => id !== '*');
              onChange([], []);
            } else onChange(previousSelection.current);
          }}
        />
      )}
      {resourceTypes ? (
        <Stack mt="sm" gap="sm">
          {(['database', 'filesystem'] as const).map((type) => (
            <Checkbox
              key={type}
              label={type === 'database' ? 'All databases' : 'All file systems'}
              checked={resourceTypes.includes(type)}
              onChange={(e) =>
                onChange(
                  [],
                  e.currentTarget.checked
                    ? [...resourceTypes, type]
                    : resourceTypes.filter((t) => t !== type),
                )
              }
            />
          ))}
          <Text size="sm">
            Includes current and future resources of the selected types in this workspace.
          </Text>
        </Stack>
      ) : (
        <>
          {!allResources && (
            <Stack gap="sm" mt="sm">
              <TextInput
                label="Search resources"
                placeholder={
                  hasUnloaded
                    ? 'Search loaded resources or enter a full name'
                    : 'Search by name or ID'
                }
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
              {lookup?.term === term && remote && lookup.error && (
                <Text role="alert">Workspace search failed. Try again or load more resources.</Text>
              )}
              {!matching.length && (
                <Text size="sm">
                  {remote && lookup?.term !== term ? 'Searching…' : 'No matching resources.'}
                </Text>
              )}
              {resourceIds.length >= 1024 && (
                <Text size="sm">
                  You can select up to 1,024 resources per key. To include a whole type, choose By
                  resource type.
                </Text>
              )}
              {matching.map((resource, index) => (
                <Checkbox
                  key={resource.id}
                  disabled={resourceIds.length >= 1024 && !resourceIds.includes(resource.id)}
                  checked={resourceIds.includes(resource.id)}
                  aria-label={resource.name}
                  aria-describedby={`key-resource-kind-${index}`}
                  label={
                    <span>
                      {resource.name}{' '}
                      <span id={`key-resource-kind-${index}`} className="key-resource-kind">
                        {resource.kind === 'postgresql' ? 'PostgreSQL database' : 'File System'}
                      </span>
                    </span>
                  }
                  onChange={(event) => {
                    if (event.currentTarget.checked && !resources.some((r) => r.id === resource.id))
                      remember(resource);
                    onChange(
                      event.currentTarget.checked
                        ? [...resourceIds, resource.id]
                        : resourceIds.filter((id) => id !== resource.id),
                    );
                  }}
                />
              ))}
            </Stack>
          )}
          <Text size="sm" mt="sm">
            {allResources
              ? 'All current and future resources, subject to the permissions below.'
              : resourceIds.length
                ? `${resourceIds.length} selected. Future resources are excluded.`
                : 'Select at least one resource.'}
          </Text>
          <details className="key-access-options">
            <summary>Advanced resource access</summary>
            <Checkbox
              mt="sm"
              styles={{ description: { color: 'var(--muted)' } }}
              label="All current and future resources"
              description="Includes resources added later. This access is required to allow resource creation."
              checked={allResources}
              onChange={(event) => {
                if (event.currentTarget.checked) {
                  previousSelection.current = resourceIds;
                  onChange(['*']);
                } else {
                  onChange(previousSelection.current);
                }
              }}
            />
          </details>
        </>
      )}
    </section>
  );
}
