import { Checkbox, Fieldset, Text } from '@tidbcloud/uikit';

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
  return (
    <Fieldset legend="Resource access" className="resource-access-picker">
      <Checkbox
        className="permission-choice"
        label="All current and future resources"
        description="Required to create new resources with this key."
        checked={allResources}
        onChange={(event) =>
          onChange(event.currentTarget.checked ? ['*'] : resources.map((resource) => resource.id))
        }
      />
      <div className="scope-picker">
        {resources.map((resource) => (
          <Checkbox
            key={resource.id}
            className="permission-choice"
            disabled={allResources}
            checked={allResources || resourceIds.includes(resource.id)}
            label={resource.name}
            description={
              resource.kind === 'mysql'
                ? 'MySQL'
                : resource.kind === 'postgresql'
                  ? 'PostgreSQL'
                  : resource.kind === 'duckdb'
                    ? 'DuckDB'
                    : 'File System'
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
      </div>
      <Text size="sm" mt={16}>
        Selected resources only. New resources are excluded unless you enable workspace-wide access.
      </Text>
    </Fieldset>
  );
}
