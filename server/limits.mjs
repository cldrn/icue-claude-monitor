// Pure normalization of the /api/oauth/usage payload into the widget's limits contract.
export const WINDOW_SECONDS = { session: 18000, weekly_all: 604800, weekly_scoped: 604800 };

const LEGACY = [
  ['five_hour', 'session', null],
  ['seven_day', 'weekly_all', null],
  ['seven_day_opus', 'weekly_scoped', 'Opus'],
  ['seven_day_sonnet', 'weekly_scoped', 'Sonnet']
];

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model'; }
function round1(n) { return Math.round(n * 10) / 10; }
function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, round1(n)));
}
function validIso(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function humanKind(kind) { return String(kind).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

export function limitLabel(kind, model) {
  if (kind === 'session') return 'Session (5hr)';
  if (kind === 'weekly_all') return 'Weekly (7 day)';
  if (kind === 'weekly_scoped') return `${model || 'Model'} limit`;
  return humanKind(kind);
}

function fromLimitsArray(arr) {
  const out = [];
  let unknown = 0;
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') continue;
    const kind = raw.kind;
    const model = raw.scope?.model?.display_name || raw.scope?.model?.id || null;
    let id;
    if (kind === 'session' || kind === 'weekly_all') id = kind;
    else if (kind === 'weekly_scoped') id = `weekly_scoped:${slug(model)}`;
    else id = `${kind}:${unknown++}`;
    const resetsAt = validIso(raw.resets_at);
    out.push({
      id, kind, label: limitLabel(kind, model),
      percent: clampPct(raw.percent ?? raw.utilization),
      resetsAt,
      windowSeconds: WINDOW_SECONDS[kind] ?? null,
      isActive: typeof raw.is_active === 'boolean' ? raw.is_active : resetsAt != null,
      severity: raw.severity === 'critical' ? 'critical' : 'normal',
      scope: model ? { model, surface: raw.scope?.surface ?? null } : null,
      group: raw.group ?? null
    });
  }
  return out;
}

function fromLegacy(raw) {
  const out = [];
  for (const [key, kind, model] of LEGACY) {
    const v = raw[key];
    if (!v || typeof v !== 'object') continue;
    const resetsAt = validIso(v.resets_at);
    out.push({
      id: kind === 'weekly_scoped' ? `weekly_scoped:${slug(model)}` : kind,
      kind, label: limitLabel(kind, model),
      percent: clampPct(v.utilization ?? v.percent),
      resetsAt,
      windowSeconds: WINDOW_SECONDS[kind],
      isActive: resetsAt != null,
      severity: 'normal',
      scope: model ? { model, surface: null } : null,
      group: kind === 'session' ? 'session' : 'weekly'
    });
  }
  return out;
}

const ORDER = { session: 0, weekly_all: 1, weekly_scoped: 2 };
function sortLimits(a, b) {
  const oa = ORDER[a.kind] ?? 9, ob = ORDER[b.kind] ?? 9;
  if (oa !== ob) return oa - ob;
  return a.label.localeCompare(b.label);
}

export function normalizeExtra(raw) {
  const e = raw?.extra_usage;
  if (!e || typeof e !== 'object') return null;
  return {
    isEnabled: Boolean(e.is_enabled),
    monthlyLimit: e.monthly_limit ?? null,
    usedCredits: e.used_credits ?? null,
    utilization: e.utilization == null ? null : clampPct(e.utilization),
    currency: e.currency ?? null,
    spendLimitReached: Boolean(e.spend_limit_reached)
  };
}

/** @returns {{limits: object[], extra: object|null}} */
export function normalizeLimits(raw) {
  if (!raw || typeof raw !== 'object') return { limits: [], extra: null };
  let limits = Array.isArray(raw.limits) && raw.limits.length ? fromLimitsArray(raw.limits) : fromLegacy(raw);
  const seen = new Set();
  limits = limits.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  limits.sort(sortLimits);
  return { limits, extra: normalizeExtra(raw) };
}
