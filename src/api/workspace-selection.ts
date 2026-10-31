/** Select only a Workspace returned by the authenticated API, never a URL-supplied ID. */
export function firstWorkspaceId(input: unknown): string {
  if (!input || typeof input !== 'object' || !('data' in input) || !Array.isArray(input.data))
    throw new Error('The API returned an invalid Workspace list.');
  const first: unknown = input.data[0];
  if (!first || typeof first !== 'object' || !('id' in first) || typeof first.id !== 'string')
    throw new Error('No Workspace is available for this account.');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(first.id) || first.id === '.' || first.id === '..')
    throw new Error('The API returned an invalid Workspace ID.');
  return first.id;
}
