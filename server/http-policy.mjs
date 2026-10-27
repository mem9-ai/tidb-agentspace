const defaultOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
];
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const headers = ['content-type', 'authorization', 'idempotency-key', 'if-none-match'];

export function consoleOrigins(value = process.env.WORKSPACE_CONSOLE_ORIGINS) {
  const origins =
    value === undefined
      ? defaultOrigins
      : value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.origin !== origin
    )
      throw new Error(
        'Console origins must be exact HTTP loopback origins. Public demo hosting is unsupported.',
      );
  }
  return origins;
}

export function applyHttpPolicy(req, res, origins, fail) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(hostname))
    fail(403, 'LOCAL_ONLY', 'This prototype is available on loopback only.');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin) {
    if (!origins.includes(origin) && origin !== `http://${host}`)
      fail(403, 'ORIGIN_DENIED', 'Untrusted origin.');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Content-Disposition');
  }
  if (req.method !== 'OPTIONS') return false;
  const requestedMethod = req.headers['access-control-request-method'];
  const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    !origin ||
    !methods.includes(requestedMethod) ||
    requestedHeaders.some((header) => !headers.includes(header))
  )
    fail(403, 'PREFLIGHT_DENIED', 'Unsupported cross-origin request.');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
  res.writeHead(204);
  res.end();
  return true;
}
