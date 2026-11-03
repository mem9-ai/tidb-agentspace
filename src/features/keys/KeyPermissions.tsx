import { Checkbox, Stack, Text } from '@tidbcloud/uikit';

type SelectableResource = { id: string; kind: string };
type Permission = { scope: string; label: string; description?: string };

export function permitsSalesTask(
  key: { resourceIds: string[]; scopes: string[] },
  resourceId: string,
) {
  const required = ['resources:read', 'files:read', 'files:analyze', 'files:write'];
  return (
    (key.resourceIds.includes(resourceId) || key.resourceIds.includes('*')) &&
    required.every((scope) => key.scopes.includes(scope))
  );
}

const workspacePermissions: Permission[] = [
  {
    scope: 'resources:read',
    label: 'Discover resources',
  },
  {
    scope: 'usage:read',
    label: 'View usage',
  },
];
const createResourcePermission: Permission = {
  scope: 'resources:write',
  label: 'Create resources',
  description: 'Create new file systems and databases in this workspace.',
};
const filePermissions: Permission[] = [
  { scope: 'files:read', label: 'Read files' },
  {
    scope: 'files:analyze',
    label: 'Analyze files',
    description: 'Read-only SQL or Bash on files.',
  },
  {
    scope: 'files:write',
    label: 'Write files',
    description: 'Create, edit, and delete files.',
  },
];
const databasePermissions: Permission[] = [
  {
    scope: 'queries:read',
    label: 'Read database data',
  },
  {
    scope: 'queries:execute',
    label: 'Read and change database data',
    description: 'Run SQL that can read or change permitted databases.',
  },
];

function availablePermissions(resourceIds: string[], resources: SelectableResource[]) {
  const all = resourceIds.includes('*');
  const visible = new Set(resources.map((resource) => resource.id));
  const hasHiddenSelection = resourceIds.some((id) => id !== '*' && !visible.has(id));
  const selected = resources.filter((resource) => resourceIds.includes(resource.id));
  return {
    all,
    hasHiddenSelection,
    files: all || hasHiddenSelection || selected.some((resource) => resource.kind === 'filesystem'),
    databases:
      all || hasHiddenSelection || selected.some((resource) => resource.kind !== 'filesystem'),
  };
}

export function retainApplicablePermissions(
  scopes: string[],
  resourceIds: string[],
  resources: SelectableResource[],
) {
  const available = availablePermissions(resourceIds, resources);
  return scopes.filter(
    (scope) =>
      (scope !== 'resources:write' || available.all) &&
      (!scope.startsWith('files:') || available.files) &&
      (!scope.startsWith('queries:') || available.databases),
  );
}

export function KeyPermissions({
  resources,
  resourceIds,
  scopes,
  notice,
  onChange,
}: {
  resources: SelectableResource[];
  resourceIds: string[];
  scopes: string[];
  notice: string;
  onChange: (scopes: string[]) => void;
}) {
  const available = availablePermissions(resourceIds, resources);
  const workspace = available.all
    ? [...workspacePermissions, createResourcePermission]
    : workspacePermissions;
  const selectedWorkspacePermissions = workspace
    .filter((permission) => scopes.includes(permission.scope))
    .map((permission) => permission.label);
  function group(title: string, permissions: Permission[], showHeading = true) {
    return (
      <div role="group" aria-label={title} className="key-permission-group">
        {showHeading && <Text fw={600}>{title}</Text>}
        <Stack gap="sm" mt="sm">
          {permissions.map(({ scope, label, description }) => (
            <Checkbox
              key={scope}
              styles={{ description: { color: 'var(--muted)' } }}
              checked={scopes.includes(scope)}
              label={
                <span>
                  {label} <code className="key-scope">{scope}</code>
                </span>
              }
              description={description}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...scopes, scope]
                    : scopes.filter((item) => item !== scope),
                )
              }
            />
          ))}
        </Stack>
      </div>
    );
  }
  return (
    <section aria-label="Permissions" className="key-access-section">
      <Text fw={600}>Permissions</Text>
      {(available.all || resourceIds.length > 1) && (
        <Text size="sm">Apply to each selected resource of the matching type.</Text>
      )}
      {notice && (
        <Text size="sm" role="status" mt="sm">
          {notice}
        </Text>
      )}
      {available.hasHiddenSelection && (
        <Text size="sm" mt="sm">
          Some selected resources are outside the current view, so file and database permissions
          remain available.
        </Text>
      )}
      {available.files && group('Files', filePermissions, available.databases)}
      {available.databases && group('Databases', databasePermissions, available.files)}
      <details className="key-access-options">
        <summary>
          Workspace ·{' '}
          {selectedWorkspacePermissions.length ? selectedWorkspacePermissions.join(', ') : 'None'}
        </summary>
        {group('Workspace', workspace, false)}
      </details>
    </section>
  );
}
