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
    <fieldset className="resource-access-picker">
      <legend>Resource access</legend>
      <label className="resource-access-all">
        <input
          type="checkbox"
          checked={allResources}
          onChange={(event) =>
            onChange(event.target.checked ? ['*'] : resources.map((resource) => resource.id))
          }
        />
        <span>
          All current and future resources
          <small>Required to create new resources with this key.</small>
        </span>
      </label>
      <div className="scope-picker">
        {resources.map((resource) => (
          <label key={resource.id}>
            <input
              type="checkbox"
              disabled={allResources}
              checked={allResources || resourceIds.includes(resource.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...resourceIds, resource.id]
                    : resourceIds.filter((id) => id !== resource.id),
                )
              }
            />
            <span>
              {resource.name}
              <small>
                {resource.kind === 'mysql'
                  ? 'MySQL'
                  : resource.kind === 'postgresql'
                    ? 'PostgreSQL'
                    : 'File System'}
              </small>
            </span>
          </label>
        ))}
      </div>
      <p>
        Selected resources only. New resources are excluded unless you enable workspace-wide access.
      </p>
    </fieldset>
  );
}
