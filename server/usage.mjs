// Usage source: Claude Code's own cached usage response first, the network endpoint only when that cache is stale.
import { PollError } from './poller.mjs';
import { normalizeLimits } from './limits.mjs';

export const FALLBACK_CC_VERSION = '2.1.283';
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.max(1000, parseInt(s, 10) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(1000, t - now) : null;
}

export function userAgentFor(config, version) {
  if (config.userAgent) return config.userAgent;
  return `claude-cli/${version || FALLBACK_CC_VERSION} (external, icue-claude-monitor)`;
}

export function createUsageSource({ config, files, state, history, log, fetchImpl = globalThis.fetch, now = Date.now }) {
  async function fetchNetwork(creds) {
    const version = state.localVersion() || FALLBACK_CC_VERSION;
    let res;
    try {
      res = await fetchImpl(USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgentFor(config, version)
        },
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      throw new PollError(`network: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`, { code: 'network' });
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? 5 * 60000;
      throw new PollError('HTTP 429 rate limited', { statusCode: 429, retryAfterMs, code: 'rate_limited' });
    }
    if (res.status === 401 || res.status === 403) {
      throw new PollError(`HTTP ${res.status} auth rejected`, { statusCode: res.status, fixedDelayMs: 300000, code: 'auth_rejected' });
    }
    if (!res.ok) throw new PollError(`HTTP ${res.status}`, { statusCode: res.status, code: 'http' });
    let json;
    try { json = await res.json(); } catch { throw new PollError('invalid JSON from usage endpoint', { code: 'parse' }); }
    return json;
  }

  async function run() {
    const t = now();
    const cached = await files.readCachedUsage();
    if (cached && cached.fetchedAtMs > 0 && t - cached.fetchedAtMs < config.usageCacheMaxAgeSeconds * 1000) {
      const { limits, extra } = normalizeLimits(cached.utilization);
      if (limits.length) {
        history.sample(limits, cached.fetchedAtMs, `cache:${cached.fetchedAtMs}`);
        state.setUsage({ limits, extra, fetchedAt: cached.fetchedAtMs, origin: 'cache' });
        return;
      }
      log?.debug?.('cached usage had no limits; falling back to network');
    }
    const creds = await files.readCredentials();
    if (!creds.present) throw new PollError(`no credentials (${creds.error})`, { fixedDelayMs: 60000, code: 'no_credentials' });
    if (creds.expired) throw new PollError('token expired', { fixedDelayMs: 60000, code: 'token_expired' });
    const json = await fetchNetwork(creds);
    const { limits, extra } = normalizeLimits(json);
    if (!limits.length) throw new PollError('usage response had no limits', { code: 'schema' });
    history.sample(limits, t, `net:${t}`);
    state.setUsage({ limits, extra, fetchedAt: t, origin: 'network' });
    log?.info?.(`usage fetched from network (${limits.map((l) => `${l.id}=${l.percent}%`).join(', ')})`);
  }

  return { run, fetchNetwork };
}
