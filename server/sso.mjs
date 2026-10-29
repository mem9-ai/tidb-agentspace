import { publicPathPrefix } from './http-policy.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// TiDB Cloud SSO ("Continue with TiDB Account") via OIDC public-client authorization-code + S256 PKCE.
//
// Everything here is driven by environment variables. No real credentials, client ids,
// or provider endpoints are hard-coded. When SSO is not configured the feature is a no-op:
// `loadSsoConfig()` returns null, the routes report "not configured", and the button is hidden.
//
// Env vars (see .env.example):
//   TIDB_SSO_ISSUER           Required. OIDC issuer URL. The expected ID-token issuer; discovery
//                             (when no explicit endpoints) resolves authorize/token/jwks/userinfo.
//   TIDB_SSO_AUTHORIZE_URL    Optional explicit authorize endpoint (overrides discovery).
//   TIDB_SSO_TOKEN_URL        Optional explicit token endpoint (overrides discovery).
//   TIDB_SSO_USERINFO_URL     Optional explicit userinfo endpoint (overrides discovery).
//   TIDB_SSO_JWKS_URL         Optional explicit JWKS endpoint (overrides discovery).
//   TIDB_SSO_CLIENT_ID        Required. OAuth client id.
//   TIDB_SSO_REDIRECT_URI     Required. Absolute callback URL registered with the provider.
//   TIDB_SSO_SCOPES           Optional. Space-separated scopes (default "openid profile email").
//   TIDB_SSO_OWNER_SUBJECTS   Owner allowlist. Comma-separated IMMUTABLE provider subject ids
//                             (the OIDC `sub` claim, NOT email) that MAY become the workspace owner.
//   TIDB_SSO_OWNER_EMAIL_RULES Optional. Comma-separated email or *@domain rules for verified ID-token emails.
//                             Every match grants shared workspace owner access (no user isolation).
//   (Owner authorization subject is HARD-PINNED to the OIDC `sub` claim in code; not configurable.)
//                             Must resolve to a non-empty scalar string; arrays/objects fail closed.
//   TIDB_SSO_DISPLAY_CLAIM    Optional. ID-token claim for a human-readable display/audit label
//                             (e.g. "email" or "name"). NEVER participates in the owner decision.
//   TIDB_SSO_ALLOWED_ORGS     Optional. Comma-separated org ids/names. Additional FILTER only —
//                             org membership is never, by itself, an owner grant.
//   TIDB_SSO_ORG_CLAIM        Optional. ID-token claim holding the org (default "org_id").
//   TIDB_SSO_POST_LOGIN_URL   Optional. App URL to land on after login (must be same-origin as redirect).
//
// AUTHORIZATION MODEL (shared workspace, DEFAULT-DENY):
//   A verified login needs an exact OWNER_SUBJECTS match OR an explicitly configured verified-email
//   rule. The optional org filter applies to both. With neither grant, login is denied.
//   Identity always remains issuer + immutable sub; a matching email is eligibility, not identity.
//   Every admitted account is an owner of the same workspace, not a separate customer tenant.

const DEFAULT_SCOPES = 'openid profile email';
const DEFAULT_SUBJECT_CLAIM = 'sub';
const DEFAULT_ORG_CLAIM = 'org_id';

function requireHttpsUrl(name, value, { allowLoopbackHttp = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && loopback))
    return url;
  throw new Error(`${name} must use https (http is allowed only for loopback redirect URIs).`);
}

function validEmailDomain(domain) {
  const validLabel = (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
  const labels = domain.split('.');
  return domain.length <= 253 && labels.length >= 2 && labels.every(validLabel);
}

function normalizedEmail(value) {
  if (typeof value !== 'string') return null;
  // ASCII dot-atom only; no controls, whitespace, quoted forms, multiple @ or wildcard local parts.
  const match =
    /^([a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*)@([a-z0-9.-]+)$/i.exec(value);
  return match && match[0] === value && validEmailDomain(match[2]) ? value.toLowerCase() : null;
}

// Exact email or *@domain only. Operators explicitly accept case-insensitive mailbox matching.
function parseOwnerEmailRules(value) {
  if (value === undefined || value === '') return [];
  const invalid = () =>
    new Error('TIDB_SSO_OWNER_EMAIL_RULES must contain only email or *@domain rules.');
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw invalid();
  if (!value.trim()) return [];
  const rules = value.split(',').map((entry) => {
    const rule = entry.trim();
    if (rule.startsWith('*@') && validEmailDomain(rule.slice(2))) return rule.toLowerCase();
    const email = normalizedEmail(rule);
    if (!email) throw invalid();
    return email;
  });
  return [...new Set(rules)];
}

function hasVerifiedOwnerEmail(rules, claims) {
  if (!rules?.length || claims.email_verified !== true) return false;
  const email = normalizedEmail(claims.email);
  return (
    !!email && (rules.includes(email) || rules.includes('*' + email.slice(email.indexOf('@'))))
  );
}

// Parse SSO configuration from the environment. Returns null when SSO is disabled
// (no issuer AND no explicit endpoints). Throws a clear error on a partial/invalid config
// so a misconfiguration fails fast at startup rather than silently disabling login.
export function loadSsoConfig(env = process.env) {
  const get = (name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const issuer = get('TIDB_SSO_ISSUER');
  const clientId = get('TIDB_SSO_CLIENT_ID');
  const explicitEndpoints = [
    'TIDB_SSO_AUTHORIZE_URL',
    'TIDB_SSO_TOKEN_URL',
    'TIDB_SSO_JWKS_URL',
  ].some((name) => get(name));

  // Nothing configured at all -> feature cleanly disabled.
  if (!issuer && !clientId && !explicitEndpoints) return null;

  if (!clientId) throw new Error('TIDB_SSO_CLIENT_ID is required to enable TiDB SSO.');
  if (!get('TIDB_SSO_REDIRECT_URI'))
    throw new Error('TIDB_SSO_REDIRECT_URI is required to enable TiDB SSO.');
  // The expected ID-token issuer is ALWAYS required, so jwtVerify always checks a concrete
  // issuer — including explicit-endpoint mode (where discovery does not supply one).
  if (!issuer)
    throw new Error(
      'TIDB_SSO_ISSUER is required (the expected ID-token issuer). Set it even when ' +
        'TIDB_SSO_AUTHORIZE_URL/TOKEN_URL/JWKS_URL are provided explicitly.',
    );

  const authorizeUrl = get('TIDB_SSO_AUTHORIZE_URL');
  const tokenUrl = get('TIDB_SSO_TOKEN_URL');
  const jwksUrl = get('TIDB_SSO_JWKS_URL');

  const redirect = requireHttpsUrl('TIDB_SSO_REDIRECT_URI', get('TIDB_SSO_REDIRECT_URI'), {
    allowLoopbackHttp: true,
  });
  if (authorizeUrl) requireHttpsUrl('TIDB_SSO_AUTHORIZE_URL', authorizeUrl);
  if (tokenUrl) requireHttpsUrl('TIDB_SSO_TOKEN_URL', tokenUrl);
  if (jwksUrl) requireHttpsUrl('TIDB_SSO_JWKS_URL', jwksUrl);
  const userinfoUrl = get('TIDB_SSO_USERINFO_URL');
  if (userinfoUrl) requireHttpsUrl('TIDB_SSO_USERINFO_URL', userinfoUrl);
  requireHttpsUrl('TIDB_SSO_ISSUER', issuer);

  const publicPath = publicPathPrefix(get('WORKSPACE_PUBLIC_PATH') || '');
  if (publicPath && redirect.pathname !== publicPath + '/api/auth/tidbcloud/callback')
    throw new Error(
      'TIDB_SSO_REDIRECT_URI must match WORKSPACE_PUBLIC_PATH and the callback route.',
    );
  const postLoginUrl = get('TIDB_SSO_POST_LOGIN_URL');
  if (postLoginUrl) {
    const target = requireHttpsUrl('TIDB_SSO_POST_LOGIN_URL', postLoginUrl, {
      allowLoopbackHttp: true,
    });
    if (target.origin !== redirect.origin)
      throw new Error('TIDB_SSO_POST_LOGIN_URL must share the origin of TIDB_SSO_REDIRECT_URI.');
    if (
      publicPath &&
      target.pathname !== publicPath &&
      !target.pathname.startsWith(publicPath + '/')
    )
      throw new Error('TIDB_SSO_POST_LOGIN_URL must stay inside WORKSPACE_PUBLIC_PATH.');
  }

  const csv = (name) =>
    (get(name) || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

  // http-only loopback redirect URIs cannot carry Secure cookies; https deployments always do.
  const cookieSecure = redirect.protocol === 'https:';

  return {
    issuer,
    authorizeUrl,
    tokenUrl,
    jwksUrl,
    userinfoUrl,
    clientId,
    redirectUri: redirect.href,
    redirectOrigin: redirect.origin,
    scopes: get('TIDB_SSO_SCOPES') || DEFAULT_SCOPES,
    // Identity remains the immutable OIDC subject, even when a verified-email rule grants access.
    subjectClaim: DEFAULT_SUBJECT_CLAIM,
    // Display/audit only; never used for the owner decision.
    displayClaim: get('TIDB_SSO_DISPLAY_CLAIM'),
    orgClaim: get('TIDB_SSO_ORG_CLAIM') || DEFAULT_ORG_CLAIM,
    allowedOrgs: csv('TIDB_SSO_ALLOWED_ORGS'),
    ownerSubjects: csv('TIDB_SSO_OWNER_SUBJECTS'),
    ownerEmailRules: parseOwnerEmailRules(env.TIDB_SSO_OWNER_EMAIL_RULES),
    cookieSecure,
    publicPath,
    postLoginUrl: postLoginUrl || redirect.origin + publicPath + '/',
  };
}

const base64url = (buffer) => buffer.toString('base64url');

export function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export const randomToken = () => base64url(randomBytes(32));

// Resolve the provider endpoints, preferring explicit config and falling back to OIDC discovery.
// `fetchImpl` is injectable for tests. Discovery results are cached on the config object.
export async function resolveEndpoints(config, fetchImpl = fetch) {
  if (config._endpoints) return config._endpoints;
  let discovered = {};
  if (config.issuer && !(config.authorizeUrl && config.tokenUrl && config.jwksUrl)) {
    const response = await fetchImpl(
      config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration',
    );
    if (!response.ok) throw new Error(`OIDC discovery failed (${response.status}).`);
    const doc = await response.json();
    if (doc.issuer !== config.issuer)
      throw new Error('OIDC discovery issuer does not match the configured issuer.');
    discovered = {
      authorizeUrl: doc.authorization_endpoint,
      tokenUrl: doc.token_endpoint,
      jwksUrl: doc.jwks_uri,
      userinfoUrl: doc.userinfo_endpoint,
    };
  }
  const endpoints = {
    authorizeUrl: config.authorizeUrl || discovered.authorizeUrl,
    tokenUrl: config.tokenUrl || discovered.tokenUrl,
    jwksUrl: config.jwksUrl || discovered.jwksUrl,
    userinfoUrl: config.userinfoUrl || discovered.userinfoUrl,
  };
  if (!endpoints.authorizeUrl || !endpoints.tokenUrl || !endpoints.jwksUrl)
    throw new Error('The provider did not supply authorize, token, and JWKS endpoints.');
  config._endpoints = endpoints;
  return endpoints;
}

export function buildAuthorizeUrl(config, endpoints, { state, nonce, codeChallenge }) {
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

// Public-client token exchange: PKCE binds the token request to its authorization flow.
// The provider registration must allow token endpoint authentication method "none".
export async function exchangeCode(config, endpoints, { code, codeVerifier }, fetchImpl = fetch) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  const response = await fetchImpl(endpoints.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload) {
    const code = payload?.error || `http_${response.status}`;
    throw Object.assign(new Error('The identity provider rejected the token request.'), {
      ssoError: code,
    });
  }
  if (!payload.id_token)
    throw Object.assign(new Error('The identity provider did not return an ID token.'), {
      ssoError: 'missing_id_token',
    });
  return payload;
}

// Build (and cache) the JWKS resolver for ID-token signature verification.
export function jwksResolver(config, endpoints) {
  if (!config._jwks) config._jwks = createRemoteJWKSet(new URL(endpoints.jwksUrl));
  return config._jwks;
}

// Verify the ID token: signature (via JWKS), issuer, audience, and nonce. Returns claims.
// `config.issuer` is always a concrete value (required by loadSsoConfig), so the issuer is
// always checked — including explicit-endpoint mode.
export async function verifyIdToken(config, endpoints, idToken, expectedNonce) {
  if (!config.issuer)
    throw Object.assign(new Error('No expected issuer is configured.'), {
      ssoError: 'issuer_unconfigured',
    });
  const resolver = jwksResolver(config, endpoints);
  const { payload } = await jwtVerify(idToken, resolver, {
    issuer: config.issuer,
    audience: config.clientId,
  });
  if (!payload.nonce || payload.nonce !== expectedNonce)
    throw Object.assign(new Error('ID token nonce mismatch.'), { ssoError: 'nonce_mismatch' });
  return payload;
}

// Derive the immutable subject + auditable identity and decide owner authorization (DEFAULT-DENY).
//
// Returns { subject, principalId, principal, display }:
//   - `subject`     the provider's IMMUTABLE subject (OIDC `sub` by default), a non-empty string.
//   - `principalId` a distinct, auditable id per SSO user ("sso:<issuer>:<subject>"); never the
//                   generic "local-owner". Always present, independent of the authz outcome.
//   - `principal`   a human-readable actor label for the event log.
//   - `display`     optional display/audit label (e.g. email/name); NEVER part of authorization.
//
// Fails closed (no owner session) when: the immutable subject claim is missing or not a non-empty
// scalar string (arrays/objects/numbers rejected so distinct accounts can never coerce/collide
// into one identity); an org filter misses; or neither subject nor verified-email rule grants access.
// An org match alone never grants owner. Call only after ID-token verification.
export function resolveIdentity(config, claims) {
  const raw = claims[config.subjectClaim];
  // The authorization subject MUST be an immutable scalar string. Reject anything else outright
  // rather than String()-coercing it (which would let arrays/objects collapse into one identity).
  if (typeof raw !== 'string' || raw.trim() === '')
    throw Object.assign(
      new Error(
        `ID token subject claim "${config.subjectClaim}" must be a non-empty string (the immutable provider subject).`,
      ),
      { ssoError: 'invalid_subject' },
    );
  const subject = raw;
  const principalId = `sso:${config.issuer}:${subject}`;
  // Display/audit metadata only — captured for logs, never consulted for authorization.
  const displayRaw = config.displayClaim ? claims[config.displayClaim] : undefined;
  const display = typeof displayRaw === 'string' && displayRaw.trim() ? displayRaw : undefined;
  const identity = { subject, principalId, principal: `tidb:${subject}`, display };

  // Org allowlist, when configured, is an additional FILTER applied first. It is not an owner grant.
  if (config.allowedOrgs.length) {
    const org = claims[config.orgClaim];
    const values = Array.isArray(org) ? org.map(String) : [String(org)];
    if (!values.some((value) => config.allowedOrgs.includes(value)))
      throw Object.assign(new Error('Your TiDB organization is not allowed to sign in here.'), {
        ssoError: 'org_not_allowed',
        identity,
      });
  }

  // Owner authorization: exact immutable subject OR an explicitly enabled verified-email rule.
  if (
    !config.ownerSubjects.includes(subject) &&
    !hasVerifiedOwnerEmail(config.ownerEmailRules, claims)
  )
    throw Object.assign(
      new Error('This account is not authorized as an owner for this workspace.'),
      { ssoError: 'not_authorized', identity },
    );

  return identity;
}

// Only public display information is exposed to the frontend.
export function publicSsoInfo(config) {
  if (!config) return { enabled: false };
  return {
    enabled: true,
    provider: 'tidbcloud',
    label: 'Continue with TiDB Account',
    loginPath: '/api/auth/tidbcloud/login',
    logoutPath: '/api/auth/tidbcloud/logout',
  };
}
