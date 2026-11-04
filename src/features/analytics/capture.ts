import { globalApiSettings, type SsoAuthConfig } from '../../api/client';

type Page = 'home' | 'get_started' | 'sales_guide' | 'api_docs' | 'workspace';
type Event =
  | {
      name: 'public_page_view';
      page: Page;
      source: string;
      device: 'mobile' | 'desktop';
      campaign: string | null;
    }
  | { name: 'try_clicked' | 'sign_in_clicked'; page: Page }
  | { name: 'journey_selected'; journey: 'agent' | 'self_service' }
  | { name: 'helpful_vote'; helpful: boolean };
const preference = 'product-analytics-disabled';
const sessionKey = 'product-analytics-session';
let endpoint = '';
let campaigns: string[] = [];
let enabled = false;
let pending: { id: string; event: Event }[] = [];
let flushing = false;
const gpc = () => 'globalPrivacyControl' in navigator && navigator.globalPrivacyControl === true;
export function analyticsDisabled() {
  try {
    return gpc() || localStorage.getItem(preference) === 'true';
  } catch {
    return true;
  }
}
export async function setAnalyticsDisabled(disabled: boolean) {
  try {
    localStorage.setItem(preference, String(disabled));
    sessionStorage.removeItem(sessionKey);
  } catch {
    /* Storage may be unavailable. */
  }
  pending = [];
  if (endpoint)
    await fetch(endpoint + '/analytics/session', {
      method: disabled ? 'DELETE' : 'POST',
      credentials: 'include',
    }).catch(() => undefined);
}
function session() {
  const now = Date.now();
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    const id =
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'at' in value &&
      typeof value.at === 'number' &&
      now - value.at < 30 * 60 * 1000
        ? value.id
        : crypto.randomUUID();
    sessionStorage.setItem(sessionKey, JSON.stringify({ id, at: now }));
    return id;
  } catch {
    return undefined;
  }
}
export async function startAnalytics(auth?: SsoAuthConfig) {
  try {
    endpoint = (await globalApiSettings(auth)).baseUrl;
    const response = await fetch(endpoint + '/analytics/config', { credentials: 'include' });
    if (!response.ok) return;
    const config: unknown = await response.json();
    if (!config || typeof config !== 'object' || !('enabled' in config) || config.enabled !== true)
      return;
    campaigns =
      'campaigns' in config && Array.isArray(config.campaigns)
        ? config.campaigns.filter((v): v is string => typeof v === 'string')
        : [];
    enabled = true;
  } catch {
    /* Optional capture never prevents product use. */
  }
}
export function capture(event: Event) {
  if (!enabled || analyticsDisabled() || pending.length >= 100) return;
  pending.push({ id: crypto.randomUUID(), event });
  void flush();
}
async function flush() {
  if (flushing || !pending.length || analyticsDisabled()) return;
  const id = session();
  if (!id) {
    pending = [];
    return;
  }
  flushing = true;
  const events = pending.splice(0, 20);
  const body = JSON.stringify({ version: 1, sessionId: id, events });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (analyticsDisabled()) break;
      const response = await fetch(endpoint + '/analytics/events', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
      if (response?.ok || (response && response.status < 500 && response.status !== 429)) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  } finally {
    flushing = false;
    if (pending.length) void flush();
  }
}
export function capturePage(page: Page) {
  let source = 'direct_or_unknown';
  try {
    const host = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : '';
    const belongs = (domains: string[]) =>
      domains.some((d) => host === d || host.endsWith('.' + d));
    if (belongs(['chatgpt.com', 'perplexity.ai', 'claude.ai', 'copilot.microsoft.com']))
      source = 'ai_referral';
    else if (belongs(['google.com', 'bing.com', 'duckduckgo.com', 'baidu.com'])) source = 'search';
    else if (
      belongs(['x.com', 'twitter.com', 'linkedin.com', 'reddit.com', 'news.ycombinator.com'])
    )
      source = 'social';
    else if (host && host !== location.hostname) source = 'other';
  } catch {
    /* No raw referrer is retained. */
  }
  const campaign = new URL(location.href).searchParams.get('utm_campaign');
  capture({
    name: 'public_page_view',
    page,
    source,
    device: matchMedia('(max-width: 640px)').matches ? 'mobile' : 'desktop',
    campaign: campaign && campaigns.includes(campaign) ? campaign : null,
  });
}
