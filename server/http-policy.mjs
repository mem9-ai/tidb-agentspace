import { isIP } from 'node:net';
const defaultOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
];
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const headers = ['content-type', 'authorization', 'idempotency-key', 'if-none-match'];
const loopbackHosts = ['localhost', '127.0.0.1'];

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
    if (url.protocol !== 'http:' || !loopbackHosts.includes(url.hostname) || url.origin !== origin)
      throw new Error(
        'Console origins must be exact HTTP loopback origins. Public demo hosting is unsupported.',
      );
  }
  return origins;
}

// Trusted PUBLIC origins for a real deployment behind a reverse proxy (e.g. https://tidb.ai).
// Opt-in via TIDB_PUBLIC_ORIGIN (single) and/or WORKSPACE_TRUSTED_ORIGINS (comma-separated).
// Each must be an exact https origin (no path/credentials). When unset the server stays
// loopback-only — the public contract is never enabled implicitly.
export function trustedOrigins(
  value = process.env.WORKSPACE_TRUSTED_ORIGINS,
  single = process.env.TIDB_PUBLIC_ORIGIN,
) {
  const raw = [single, value]
    .filter((entry) => entry !== undefined && entry !== null)
    .join(',')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = [];
  for (const origin of raw) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Trusted origin "${origin}" must be an absolute https origin.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== origin)
      throw new Error(
        `Trusted origin "${origin}" must be an exact https origin without a path or credentials.`,
      );
    origins.push(url.origin);
  }
  return origins;
}

// A request's Host matches a configured trusted PUBLIC origin. Used ONLY by the
// origin/Host CORS policy (applyHttpPolicy) — never for rate-limit source trust,
// which must use the unspoofable socket peer (see clientSource).
function hostMatchesTrusted(host, trusted) {
  if (!host) return false;
  return trusted.some((origin) => new URL(origin).host === host);
}

// Normalize an address for comparison: strip an IPv6 zone id and unwrap an
// IPv4-mapped IPv6 address (::ffff:1.2.3.4 -> 1.2.3.4) so a v4 CIDR matches a
// v4-mapped peer. Returns '' for anything unparseable.
function normalizeAddress(address) {
  if (!address) return '';
  let a = String(address).trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  return mapped ? mapped[1] : a;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

// Parse TIDB_TRUSTED_PROXY_IPS into matchers. FAIL-FAST on any malformed entry
// rather than silently dropping it (a dropped trusted-proxy entry would make a
// real proxy untrusted, or a malformed-but-ignored entry could hide a typo that
// weakens the contract). Supports exact IPs and IPv4 CIDRs.
export function trustedProxies(value = process.env.TIDB_TRUSTED_PROXY_IPS) {
  const raw = (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const matchers = [];
  for (const entry of raw) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      const ip = normalizeAddress(entry);
      // Validate ALL exact IPs (v4 and v6) through Node's canonical parser. This
      // rejects both colon junk ("not:an:ip", "::::") AND non-canonical IPv4 like
      // "01.2.3.4" / "001.002.003.004" that our arithmetic parser would accept but
      // that never equals a real socket peer (a silent accepted-but-dead config).
      if (isIP(ip) === 0)
        throw new Error(`TIDB_TRUSTED_PROXY_IPS entry "${entry}" is not a valid IP or CIDR.`);
      matchers.push({ exact: ip });
      continue;
    }
    const base = normalizeAddress(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    const baseInt = ipv4ToInt(base);
    if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
      throw new Error(`TIDB_TRUSTED_PROXY_IPS entry "${entry}" is not a valid IPv4 CIDR.`);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    matchers.push({ network: (baseInt & mask) >>> 0, mask });
  }
  return matchers;
}

function isTrustedProxy(address, matchers) {
  const ip = normalizeAddress(address);
  if (!ip) return false;
  const asInt = ipv4ToInt(ip);
  for (const m of matchers) {
    if (m.exact !== undefined && m.exact === ip) return true;
    if (m.mask !== undefined && asInt !== null && (asInt & m.mask) >>> 0 === m.network) return true;
  }
  return false;
}

// Resolve the client source address for rate limiting. "Behind a trusted proxy"
// is proven ONLY by the unspoofable socket peer being in the configured
// TIDB_TRUSTED_PROXY_IPS allowlist — never by a client-controllable Host header.
// If the socket peer is not a trusted proxy, X-Forwarded-For is attacker-
// controlled and is ignored entirely (source = socket peer). When the peer IS
// trusted, walk [socket peer, ...reversed XFF] from the right and strip
// configured trusted proxies; the first non-trusted address is the real client.
// (nginx's proxy_add_x_forwarded_for preserves a client-forged leftmost entry,
// so a fixed "first XFF hop" is attacker-controlled — the right-to-left strip is
// the only safe resolution across multi-layer proxies.)
export function clientSource(req, proxies = []) {
  const peer = normalizeAddress(req.socket?.remoteAddress) || 'unknown';
  if (!proxies.length || !isTrustedProxy(peer, proxies)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => normalizeAddress(value))
    .filter(Boolean);
  const chain = [...forwarded, peer]; // left=client-claimed ... right=socket peer
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i], proxies)) return chain[i];
  }
  return peer;
}

export function applyHttpPolicy(req, res, origins, fail, trusted = []) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  // Loopback is always allowed (local dev). A configured trusted public Host is also allowed,
  // so a real reverse proxy (e.g. https://tidb.ai) can serve the app. Everything else is rejected,
  // keeping the loopback-only default when no trusted origin is configured.
  if (!loopbackHosts.includes(hostname) && !hostMatchesTrusted(host, trusted))
    fail(403, 'LOCAL_ONLY', 'This host is not an approved loopback or trusted public origin.');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin) {
    // The permissive `http://<host>` same-origin exception is for loopback dev ONLY. A configured
    // public trusted origin is https and must match scheme exactly, so e.g. `https://tidb.ai`
    // configured never accepts a spoofable `http://tidb.ai` origin.
    const loopbackSameOrigin = loopbackHosts.includes(hostname) && origin === `http://${host}`;
    if (!origins.includes(origin) && !trusted.includes(origin) && !loopbackSameOrigin)
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
