// In-memory state store and the /api/state document builder. Tokens never enter this module.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export function createState({ config, history, now = Date.now }) {
  const startedAt = now();
  const s = {
    credentials: { present: false, expired: false, expiresAt: null, scopes: [], subscriptionType: null, rateLimitTier: null, organizationUuid: null, error: null },
    account: null,
    usage: { fetchedAt: null, fetchedAtMs: null, origin: null, limits: [], extra: null },
    local: { items: [], staleFiles: 0, reused: 0, verifier: 'procStart', error: null, maxVersion: null },
    cloud: { items: [], route: 'code', clearedAt: null }
  };
  const sources = new Map(); // name -> () => health

  function registerSource(name, healthFn) { sources.set(name, healthFn); }

  function setCredentials(c) {
    s.credentials = {
      present: Boolean(c?.present), expired: Boolean(c?.expired),
      expiresAt: c?.expiresAt ? new Date(c.expiresAt).toISOString() : null,
      scopes: c?.scopes ?? [], subscriptionType: c?.subscriptionType ?? null, rateLimitTier: c?.rateLimitTier ?? null,
      organizationUuid: c?.organizationUuid ?? null, error: c?.error ?? null
    };
  }
  function setAccount(a) { s.account = a?.present ? a : null; }
  function setUsage({ limits, extra, fetchedAt, origin }) {
    s.usage = { fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null, fetchedAtMs: fetchedAt ?? null, origin, limits, extra };
  }
  function setLocal(l) { s.local = { ...s.local, ...l }; }
  function setCloud(c) { s.cloud = { ...s.cloud, ...c }; }
  function clearCloud() { s.cloud = { ...s.cloud, items: [], clearedAt: now() }; }
  function localVersion() { return s.local.maxVersion; }

  function buildState({ includeHistory = true, mock = false } = {}) {
    const t = now();
    const healths = {};
    for (const [name, fn] of sources) healths[name] = fn();
    const limits = s.usage.limits.map((l) => {
      const resetsMs = l.resetsAt ? Date.parse(l.resetsAt) : NaN;
      const out = { ...l, resetsInSeconds: Number.isFinite(resetsMs) ? Math.max(0, Math.floor((resetsMs - t) / 1000)) : null };
      if (includeHistory) out.history = history.get(l.id);
      return out;
    });
    const acct = s.account;
    return {
      meta: {
        serverVersion: pkg.version,
        generatedAt: new Date(t).toISOString(),
        serverTimeMs: t,
        uptimeSeconds: Math.round((t - startedAt) / 1000),
        mock,
        claudeConfigDir: config.paths?.claudeConfigDir ?? null,
        port: config.port,
        sources: {
          credentials: { status: s.credentials.present ? (s.credentials.expired ? 'stale' : 'ok') : 'error', lastError: s.credentials.error },
          account: { status: acct ? 'ok' : 'error', lastError: acct ? null : 'no account block' },
          usage: { ...(healths.usage ?? { status: 'pending' }), origin: s.usage.origin, cacheMaxAgeSeconds: config.usageCacheMaxAgeSeconds },
          localSessions: {
            ...(healths.localSessions ?? { status: 'pending' }),
            staleFiles: s.local.staleFiles, reusedPids: s.local.reused, verifier: s.local.verifier,
            lastError: s.local.error ?? healths.localSessions?.lastError ?? null
          },
          cloudSessions: { ...(healths.cloudSessions ?? { status: 'disabled' }), route: s.cloud.route }
        }
      },
      account: {
        email: acct?.email ?? null,
        displayName: acct?.displayName ?? null,
        organizationName: acct?.organizationName ?? null,
        organizationType: acct?.organizationType ?? null,
        rateLimitTier: acct?.organizationRateLimitTier ?? s.credentials.rateLimitTier ?? null,
        subscriptionType: s.credentials.subscriptionType ?? null,
        seatTier: acct?.seatTier ?? null,
        billingType: acct?.billingType ?? null,
        hasExtraUsageEnabled: Boolean(acct?.hasExtraUsageEnabled),
        token: { present: s.credentials.present, expired: s.credentials.expired, expiresAt: s.credentials.expiresAt, scopes: s.credentials.scopes }
      },
      usage: { fetchedAt: s.usage.fetchedAt, origin: s.usage.origin, limits, extra: s.usage.extra },
      sessions: { local: s.local.items, cloud: s.cloud.items }
    };
  }

  return { registerSource, setCredentials, setAccount, setUsage, setLocal, setCloud, clearCloud, localVersion, buildState, get raw() { return s; } };
}
