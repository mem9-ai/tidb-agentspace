/**
 * Whether the value is an origin-relative API path made of ASCII word segments, such as
 * `/studio/api` or `/studio/api/`. Empty interior segments, `.`/`..`, percent-encoding,
 * queries and fragments are rejected.
 *
 * The single forward scan replaces a nested-quantifier regular expression that could
 * backtrack exponentially on hostile input such as a long run of dashes.
 */
export function isBoundedApiPath(value: string): boolean {
  if (!value.startsWith('/')) return false;
  let segmentEmpty = true;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x2f) {
      if (segmentEmpty) return false;
      segmentEmpty = true;
    } else if (isPathWordCharacter(code)) {
      segmentEmpty = false;
    } else {
      return false;
    }
  }
  // A trailing slash is allowed, and `/` alone is the origin root.
  return true;
}

function isPathWordCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    code === 0x2d // -
  );
}
