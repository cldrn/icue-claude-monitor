// Claude Code web (cloud) sessions via the internal sessions API. Best effort: any surprise degrades gracefully.
import { PollError } from './poller.mjs';
import { userAgentFor, FALLBACK_CC_VERSION } from './usage.mjs';

const BASE = 'https://api.anthropic.com';
const MAX_PAGES = 5;

export function repoFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const clean = url.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = clean.split(/[/:]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] || null;
}

function isoOrNull(v) {
  if (v == null) return null;
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function normalizeCloudSession(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const sources = raw.config?.sources || raw.session_context?.sources || [];
  const git = Array.isArray(sources) ? sources.find((s) => s && (s.type === 'git_repository' || s.url)) : null;
  const repoUrl = git?.url ?? null;
  const rawStatus = raw.status ?? raw.session_status ?? null;
  const worker = raw.worker_status ?? null;
  const archived = rawStatus === 'archived' || raw.archived === true || Boolean(raw.archived_at);
  const running = worker === 'running' || rawStatus === 'running' || raw.session_status === 'running';
  const waiting = worker === 'requires_action' || Boolean(raw.external_metadata?.pending_action);
  return {
    id: String(raw.id),
    title: (typeof raw.title === 'string' && raw.title.trim()) || repoFromUrl(repoUrl) || String(raw.id),
    status: running ? 'running' : waiting ? 'waiting' : 'idle',
    rawStatus,
    workerStatus: worker,
    archived,
    createdAt: isoOrNull(raw.created_at),
    updatedAt: isoOrNull(raw.last_event_at ?? raw.updated_at ?? raw.created_at),
    repo: repoFromUrl(repoUrl),
    repoUrl,
    branch: git?.revision ?? null,
    environment: raw.environment_kind ?? null,
    pendingAction: raw.external_metadata?.pending_action ?? null
  };
}

export function createCloudSource({ config, files, state, log, fetchImpl = globalThis.fetch, now = Date.now }) {
  let route = 'code'; // 'code' = /v1/code/sessions, 'legacy' = /v1/sessions
  let lastPrimaryProbe = 0;

  function headersFor(creds, version) {
    const h = {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': userAgentFor(config, version)
    };
    if (route === 'code') h['anthropic-client-platform'] = 'claude_code_vscode';
    else {
      h['anthropic-beta'] = 'ccr-byoc-2025-07-29';
      if (creds.organizationUuid) h['x-organization-uuid'] = creds.organizationUuid;
    }
    return h;
  }

  async function fetchPage(creds, version, afterId) {
    const url = new URL(route === 'code' ? '/v1/code/sessions' : '/v1/sessions', BASE);
    url.searchParams.set('limit', route === 'code' ? '50' : '100');
    if (afterId) url.searchParams.set('after_id', afterId);
    let res;
    try {
      res = await fetchImpl(url, { headers: headersFor(creds, version), signal: AbortSignal.timeout(15000) });
    } catch (e) { throw new PollError(`network: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`, { code: 'network' }); }
    if (res.status === 429) throw new PollError('HTTP 429 rate limited', { statusCode: 429, retryAfterMs: 5 * 60000, code: 'rate_limited' });
    if (res.status === 401 || res.status === 403) throw new PollError(`HTTP ${res.status} auth rejected`, { statusCode: res.status, fixedDelayMs: 300000, code: 'auth_rejected' });
    if (res.status === 404 || res.status === 410) throw new PollError(`HTTP ${res.status} route missing`, { statusCode: res.status, code: 'route_missing' });
    if (!res.ok) throw new PollError(`HTTP ${res.status}`, { statusCode: res.status, code: 'http' });
    let json;
    try { json = await res.json(); } catch { throw new PollError('invalid JSON from sessions endpoint', { code: 'parse' }); }
    if (!json || !Array.isArray(json.data)) throw new PollError('unexpected sessions payload (no data array)', { code: 'schema' });
    return json;
  }

  async function run() {
    const creds = await files.readCredentials();
    if (!creds.present) throw new PollError(`no credentials (${creds.error})`, { fixedDelayMs: 60000, code: 'no_credentials' });
    if (creds.expired) throw new PollError('token expired', { fixedDelayMs: 60000, code: 'token_expired' });
    const version = state.localVersion() || FALLBACK_CC_VERSION;
    if (route === 'legacy' && now() - lastPrimaryProbe > 3600e3) route = 'code';
    if (route === 'code') lastPrimaryProbe = now();

    const items = [];
    let afterId = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      let json;
      try {
        json = await fetchPage(creds, version, afterId);
      } catch (e) {
        if (e.code === 'route_missing' && route === 'code') {
          route = 'legacy';
          log?.info?.('cloud sessions: /v1/code/sessions missing, using /v1/sessions');
          json = await fetchPage(creds, version, afterId);
        } else throw e;
      }
      for (const raw of json.data) { const n = normalizeCloudSession(raw); if (n && !n.archived) items.push(n); }
      if (!json.has_more || !json.last_id) break;
      afterId = json.last_id;
    }
    const rank = { running: 0, waiting: 1, idle: 2 };
    items.sort((a, b) => (rank[a.status] - rank[b.status]) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    state.setCloud({ items: items.slice(0, 50), route });
    log?.debug?.(`cloud sessions: ${items.length} (${route})`);
  }

  return { run, get route() { return route; } };
}
