import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contract = JSON.parse(
  await readFile(new URL('../../public/openapi.json', import.meta.url), 'utf8'),
);
const ownerOnly = new Set(['getBootstrap', 'listKeys', 'createKey', 'revokeKey', 'updateSettings']);

// Called with cookies actually issued by the native local, account and Guest hosts.
// Every owner-capable business route must document that credential as an alternative,
// while documenting a session must never grant administrative access to a Workspace Key.
export function assertSessionContract(cookie) {
  const name = cookie.split('=')[0];
  const declared = Object.entries(contract.components.securitySchemes).filter(
    ([, scheme]) => scheme.type === 'apiKey' && scheme.in === 'cookie' && scheme.name === name,
  );
  assert.equal(declared.length, 1, `Native cookie ${name} must have one OpenAPI security scheme`);
  const [scheme] = declared[0];
  for (const [path, methods] of Object.entries(contract.paths)) {
    if (!path.startsWith('/workspaces')) continue;
    for (const operation of Object.values(methods).filter((value) => value.operationId)) {
      if (operation['x-authentication-profile'] === 'regional-token') {
        assert.ok(
          [
            'enrollRegionalRefreshFamily',
            'issueRegionalToken',
            'getRegionalRefreshFamily',
            'revokeRegionalRefreshFamily',
            'getRegionalTokenIssuance',
            'revokeRegionalAccessToken',
          ].includes(operation.operationId),
          'Explicit regional credential operation required',
        );
        assert.equal(
          operation.security.some((requirement) =>
            ['localOwner', 'accountOwner', 'guestOwner', 'workspaceKey'].some((key) =>
              Object.hasOwn(requirement, key),
            ),
          ),
          false,
          'Owner cookies and Workspace Keys must not impersonate enrolled regional credentials',
        );
        assert.ok(
          (operation.operationId === 'enrollRegionalRefreshFamily' &&
            operation.security.length === 0) ||
            operation.security.some(
              (requirement) =>
                Object.hasOwn(requirement, 'regionalAccess') ||
                Object.hasOwn(requirement, 'regionalRefresh'),
            ),
          'Regional credential boundary must be documented',
        );
        continue;
      }
      assert.ok(
        operation.security.some(
          (requirement) =>
            Object.hasOwn(requirement, scheme) && Object.keys(requirement).length === 1,
        ),
        `${operation.operationId} must document native ${name} authentication`,
      );
      if (ownerOnly.has(operation.operationId))
        assert.equal(
          operation.security.some((requirement) => Object.hasOwn(requirement, 'workspaceKey')),
          false,
          `${operation.operationId} must remain Owner-only`,
        );
    }
  }
}
