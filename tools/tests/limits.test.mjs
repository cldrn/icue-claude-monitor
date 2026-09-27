import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLimits, limitLabel } from '../../server/limits.mjs';

const RESET_S = '2026-09-26T22:40:00.307926+00:00';
const RESET_W = '2026-09-30T23:00:00.307947+00:00';

const NEW_SHAPE = {
  five_hour: { utilization: 15, resets_at: RESET_S },
  seven_day: { utilization: 39, resets_at: RESET_W },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 63, severity: 'normal', resets_at: RESET_W, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
    { kind: 'session', group: 'session', percent: 15, severity: 'normal', resets_at: RESET_S, scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 39, severity: 'normal', resets_at: RESET_W, scope: null, is_active: false }
  ]
};

test('limits[] wins over legacy fields and is ordered session, weekly, scoped', () => {
  const { limits, extra } = normalizeLimits(NEW_SHAPE);
  assert.deepEqual(limits.map((l) => l.id), ['session', 'weekly_all', 'weekly_scoped:fable']);
  assert.deepEqual(limits.map((l) => l.label), ['Session (5hr)', 'Weekly (7 day)', 'Fable limit']);
  assert.deepEqual(limits.map((l) => l.percent), [15, 39, 63]);
  assert.deepEqual(limits.map((l) => l.windowSeconds), [18000, 604800, 604800]);
  assert.equal(limits[2].isActive, true);
  assert.equal(limits[2].scope.model, 'Fable');
  assert.equal(limits[0].resetsAt, new Date(RESET_S).toISOString());
  assert.equal(extra.isEnabled, false);
});

test('scoped limit at 0 % without resets_at is kept but inactive', () => {
  const { limits } = normalizeLimits({ limits: [{ kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { display_name: 'Sonnet' } } }] });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].resetsAt, null);
  assert.equal(limits[0].isActive, false);
  assert.equal(limits[0].id, 'weekly_scoped:sonnet');
});

test('legacy shape fallback synthesizes rows from five_hour / seven_day / seven_day_opus', () => {
  const { limits } = normalizeLimits({ five_hour: { utilization: 12.34, resets_at: RESET_S }, seven_day: { utilization: 40, resets_at: RESET_W }, seven_day_opus: { utilization: 5, resets_at: RESET_W }, seven_day_sonnet: null });
  assert.deepEqual(limits.map((l) => l.id), ['session', 'weekly_all', 'weekly_scoped:opus']);
  assert.equal(limits[0].percent, 12.3);
  assert.equal(limits[2].label, 'Opus limit');
});

test('percent is clamped and rounded; missing values become 0', () => {
  const { limits } = normalizeLimits({ limits: [{ kind: 'session', percent: 140.26 }, { kind: 'weekly_all', percent: -3 }, { kind: 'weekly_scoped', scope: { model: { display_name: 'X' } } }] });
  assert.deepEqual(limits.map((l) => l.percent), [100, 0, 0]);
});

test('unknown kinds are appended after the known ones and severity is normalized', () => {
  const { limits } = normalizeLimits({ limits: [{ kind: 'daily_burst', percent: 50, severity: 'critical' }, { kind: 'session', percent: 1, severity: 'weird' }] });
  assert.deepEqual(limits.map((l) => l.id), ['session', 'daily_burst:0']);
  assert.equal(limits[1].severity, 'critical');
  assert.equal(limits[0].severity, 'normal');
  assert.equal(limits[1].label, 'Daily Burst');
});

test('duplicate ids are dropped (first wins) and garbage is ignored', () => {
  const { limits } = normalizeLimits({ limits: [{ kind: 'session', percent: 1 }, { kind: 'session', percent: 2 }, null, 'x', { percent: 3 }] });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].percent, 1);
  assert.deepEqual(normalizeLimits(null), { limits: [], extra: null });
});

test('limitLabel', () => {
  assert.equal(limitLabel('weekly_scoped', 'Fable'), 'Fable limit');
  assert.equal(limitLabel('weekly_scoped', null), 'Model limit');
});
