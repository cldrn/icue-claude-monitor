// mtime-cached readers for the Claude Code files this server depends on. Tokens stay in memory only.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export function createClaudeFiles({ paths, log }) {
  const cache = new Map(); // file -> { mtimeMs, size, value, error }

  async function readJsonCached(file) {
    let st;
    try { st = fs.statSync(file); } catch (e) {
      cache.set(file, { mtimeMs: 0, size: 0, value: null, error: e.code === 'ENOENT' ? 'missing' : e.message });
      return null;
    }
    const prev = cache.get(file);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.value;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, error: null });
        log?.debug?.(`re-read ${file}`);
        return value;
      } catch (e) {
        if (attempt === 0) { await sleep(200); continue; }
        log?.warn?.(`could not parse ${file}: ${e.message}; keeping last good copy`);
        if (prev) { cache.set(file, { ...prev, error: e.message }); return prev.value; }
        cache.set(file, { mtimeMs: 0, size: 0, value: null, error: e.message });
        return null;
      }
    }
    return null;
  }

  function fileError(file) { return cache.get(file)?.error ?? null; }

  async function readCredentials() {
    const j = await readJsonCached(paths.credentialsFile);
    const o = j?.claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken) {
      return { present: false, error: fileError(paths.credentialsFile) || 'no claudeAiOauth block' };
    }
    const expiresAt = Number(o.expiresAt) || 0;
    return {
      present: true,
      accessToken: o.accessToken,
      expiresAt,
      expired: expiresAt > 0 && expiresAt <= Date.now(),
      scopes: Array.isArray(o.scopes) ? o.scopes : [],
      subscriptionType: o.subscriptionType ?? null,
      rateLimitTier: o.rateLimitTier ?? null,
      organizationUuid: j.organizationUuid ?? null,
      error: null
    };
  }

  async function readClaudeJson() { return readJsonCached(paths.claudeJsonFile); }

  async function readAccount() {
    const j = await readClaudeJson();
    const a = j?.oauthAccount;
    if (!a) return { present: false, error: fileError(paths.claudeJsonFile) || 'no oauthAccount block' };
    return {
      present: true,
      email: a.emailAddress ?? null,
      displayName: a.displayName ?? null,
      fullName: a.fullName ?? null,
      organizationName: a.organizationName ?? null,
      organizationType: a.organizationType ?? null,
      organizationUuid: a.organizationUuid ?? null,
      organizationRateLimitTier: a.organizationRateLimitTier ?? null,
      userRateLimitTier: a.userRateLimitTier ?? null,
      seatTier: a.seatTier ?? null,
      billingType: a.billingType ?? null,
      hasExtraUsageEnabled: Boolean(a.hasExtraUsageEnabled),
      profileFetchedAt: a.profileFetchedAt ?? null,
      error: null
    };
  }

  async function readCachedUsage() {
    const j = await readClaudeJson();
    const c = j?.cachedUsageUtilization;
    if (!c || !c.utilization || typeof c.utilization !== 'object') return null;
    return { fetchedAtMs: Number(c.fetchedAtMs) || 0, utilization: c.utilization };
  }

  async function readBridgePlaceholders() {
    const j = await readClaudeJson();
    const b = j?.replBridgePlaceholders;
    const out = new Map();
    if (b && typeof b === 'object') {
      for (const [id, v] of Object.entries(b)) {
        if (v && Number.isInteger(v.pid)) out.set(v.pid, { id, procStart: v.procStart ?? null, createdAt: v.createdAt ?? null });
      }
    }
    return out;
  }

  return { readCredentials, readAccount, readCachedUsage, readBridgePlaceholders, readJsonCached };
}
