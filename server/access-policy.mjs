export function canAccessResource(resourceIds, resourceId) {
  return (
    Array.isArray(resourceIds) && (resourceIds.includes('*') || resourceIds.includes(resourceId))
  );
}

export function normalizeResourceGrant(resourceIds, resources) {
  const invalid = () => {
    throw Object.assign(
      new Error('Select existing resources, or use ["*"] for all current and future resources.'),
      {
        status: 400,
        code: 'INVALID_RESOURCE_GRANT',
      },
    );
  };
  if (
    !Array.isArray(resourceIds) ||
    !resourceIds.length ||
    resourceIds.some((id) => typeof id !== 'string')
  )
    invalid();
  if (resourceIds.includes('*')) {
    if (resourceIds.length !== 1) invalid();
    return ['*'];
  }
  const known = new Set(resources.map((resource) => resource.id));
  if (resourceIds.some((id) => !known.has(id))) invalid();
  return [...new Set(resourceIds)];
}
