// Mock state provider for the widget dev loop: canned scenarios with relative times resolved at request time.
import fs from 'node:fs';

const REL = /^([+-])(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const MS_KEYS = new Set(['startedAt', 'updatedAt', 'statusUpdatedAt', 'serverTimeMs']);

export function relativeToMs(str, now) {
  const m = REL.exec(String(str).trim());
  if (!m || (m[2] == null && m[3] == null && m[4] == null && m[5] == null)) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const ms = ((Number(m[2] || 0) * 24 + Number(m[3] || 0)) * 3600 + Number(m[4] || 0) * 60 + Number(m[5] || 0)) * 1000;
  return now + sign * ms;
}

function synthHistory(spec, percent, now) {
  const [, shape = 'rising', resetsStr = '0'] = String(spec).split(':');
  const resets = Number(resetsStr) || 0;
  const points = [];
  const N = 240; // 24 h at 6 min
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    let p;
    if (shape === 'flat') p = percent * (0.85 + 0.15 * f);
    else if (shape === 'sawtooth') { const cycle = (f * (resets + 1)) % 1; p = percent * cycle; }
    else p = percent * Math.pow(f, 1.4);
    points.push({ t: now - (N - 1 - i) * 6 * 60000, p: Math.round(Math.max(0, Math.min(100, p)) * 10) / 10 });
  }
  points[N - 1].p = percent;
  return points;
}

/** Deep merge for scenario inheritance: objects merge, arrays and scalars replace. */
export function deepMerge(base, over) {
  if (Array.isArray(over) || over === null || typeof over !== 'object') return over;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export function resolveScenario(doc, now = Date.now()) {
  function walk(v, key, ctx) {
    if (Array.isArray(v)) return v.map((x) => walk(x, key, ctx));
    if (v && typeof v === 'object') {
      const out = {};
      const next = { ...ctx, percent: typeof v.percent === 'number' ? v.percent : ctx.percent };
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k, next);
      return out;
    }
    if (typeof v === 'string') {
      if (key === 'history' && v.startsWith('synthetic')) return synthHistory(v, ctx.percent ?? 0, now);
      const ms = relativeToMs(v, now);
      if (ms != null) return MS_KEYS.has(key) ? ms : new Date(ms).toISOString();
    }
    return v;
  }
  const resolved = walk(doc, null, {});
  resolved.meta = resolved.meta || {};
  resolved.meta.generatedAt = new Date(now).toISOString();
  resolved.meta.serverTimeMs = now;
  resolved.meta.mock = true;
  for (const l of resolved.usage?.limits ?? []) {
    const t = l.resetsAt ? Date.parse(l.resetsAt) : NaN;
    l.resetsInSeconds = Number.isFinite(t) ? Math.max(0, Math.floor((t - now) / 1000)) : null;
  }
  return resolved;
}

export function loadScenarios(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = doc.scenarios || {};
  const resolved = {};
  function build(name, stack = []) {
    if (resolved[name]) return resolved[name];
    if (stack.includes(name)) throw new Error(`scenario cycle: ${[...stack, name].join(' -> ')}`);
    const { extends: parent, ...body } = raw[name];
    const base = parent ? build(parent, [...stack, name]) : {};
    resolved[name] = deepMerge(base, body);
    return resolved[name];
  }
  for (const name of Object.keys(raw)) build(name);
  return resolved;
}

export function createMock({ file, scenario = 'normal', log }) {
  const scenarios = loadScenarios(file);
  const names = Object.keys(scenarios);
  let current = names.includes(scenario) ? scenario : names[0];
  if (!current) throw new Error('mock-state.json has no scenarios');
  log?.info?.(`mock mode: scenario "${current}" (available: ${names.join(', ')})`);
  return {
    getState({ includeHistory = true } = {}) {
      const s = resolveScenario(scenarios[current]);
      s.meta.scenario = current;
      if (!includeHistory) for (const l of s.usage?.limits ?? []) delete l.history;
      return s;
    },
    setScenario(name) {
      if (!names.includes(name)) return { ok: false, error: 'unknown scenario', available: names };
      current = name;
      log?.info?.(`mock scenario -> ${name}`);
      return { ok: true, scenario: name };
    },
    get scenario() { return current; },
    get scenarios() { return names; }
  };
}
