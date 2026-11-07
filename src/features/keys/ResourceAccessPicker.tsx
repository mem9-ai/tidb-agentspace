import { useRef } from 'react';
import { Checkbox, Stack, Text } from '@tidbcloud/uikit';

type SelectableResource = { id: string; name: string; kind: string };
type ResourceAccessPickerProps = {
  resources: SelectableResource[];
  resourceIds: string[];
  onChange: (resourceIds: string[]) => void;
};
export function ResourceAccessPicker({
  resources,
  resourceIds,
  onChange,
}: ResourceAccessPickerProps) {
  const allResources = resourceIds.includes('*');
  const previousSelection = useRef(resourceIds.filter((id) => id !== '*'));
  return (
    <section aria-label="Resource access" className="key-access-section">
      <Text fw={600}>Resources</Text>
      {!allResources && (
        <Stack gap="sm" mt="sm">
          {resources.map((resource, index) => (
            <Checkbox
              key={resource.id}
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
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...resourceIds, resource.id]
                    : resourceIds.filter((id) => id !== resource.id),
                )
              }
            />
          ))}
        </Stack>
      )}
      <Text size="sm" mt="sm">
        {allResources
          ? 'All current and future resources, subject to the permissions below.'
          : resourceIds.length
            ? 'Only selected resources; future resources are excluded.'
            : 'Select at least one resource, or choose advanced access, to create a key.'}
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
    </section>
  );
}
