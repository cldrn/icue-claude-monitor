import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCM } from './helpers.mjs';

const CM = loadCM(['format.js']);
const F = CM.format;
const H = 3600000, D = 24 * H;

test('formatCountdown table', () => {
  assert.equal(F.formatCountdown(0), '<1m');
  assert.equal(F.formatCountdown(59 * 1000), '<1m');
  assert.equal(F.formatCountdown(61 * 60000), '1h 1m');
  assert.equal(F.formatCountdown(2 * H + 14 * 60000 + 30000), '2h 14m');
  assert.equal(F.formatCountdown(45 * 60000), '45m');
  assert.equal(F.formatCountdown(4 * D + 3 * H + 5 * 60000), '4d 3h');
  assert.equal(F.formatCountdown(-5000), 'resetting');
  assert.equal(F.formatCountdown(null), null);
  assert.equal(F.formatCountdown(NaN), null);
});

test('formatElapsed', () => {
  assert.equal(F.formatElapsed(H + 12 * 60000), '1h 12m');
  assert.equal(F.formatElapsed(-1), null);
});

test('formatAbsolute in 24 h and 12 h with Today/Tomorrow/weekday/date', () => {
  const now = new Date(2026, 8, 26, 15, 0, 0).getTime(); // Sat Sep 26 2026 15:00 local
  const w = { today: 'Today', tomorrow: 'Tomorrow' };
  assert.equal(F.formatAbsolute(new Date(2026, 8, 26, 17, 30), '24', now, w), 'Today 17:30');
  assert.equal(F.formatAbsolute(new Date(2026, 8, 27, 9, 0), '24', now, w), 'Tomorrow 09:00');
  assert.equal(F.formatAbsolute(new Date(2026, 8, 29, 9, 5), '24', now, w), 'Tue 09:05');
  assert.equal(F.formatAbsolute(new Date(2026, 9, 10, 9, 0), '24', now, w), 'Oct 10 09:00');
  assert.equal(F.formatAbsolute(new Date(2026, 8, 26, 17, 30), '12', now, w), 'Today 5:30 PM');
  assert.equal(F.formatAbsolute(new Date(2026, 8, 27, 0, 5), '12', now, w), 'Tomorrow 12:05 AM');
  assert.equal(F.formatAbsolute(new Date(NaN), '24', now, w), null);
});

test('formatRelative', () => {
  const now = 10 * D;
  assert.equal(F.formatRelative(now - 3000, now), 'just now');
  assert.equal(F.formatRelative(now - 45000, now), '45 s ago');
  assert.equal(F.formatRelative(now - 2 * 60000, now), '2m ago');
  assert.equal(F.formatRelative(now - 3 * H, now), '3h ago');
  assert.equal(F.formatRelative(now - 2 * D - H, now, { ago: 'atrás' }), '2d atrás');
  assert.equal(F.formatRelative(null, now), null);
});

test('computePace: 15 % at 42 % elapsed is on pace, 63 % at half is hot, early window hides', () => {
  const now = 1_790_000_000_000;
  const win = 604800;
  const onPace = F.computePace({ percent: 15, windowSeconds: win, now, resetsAt: new Date(now + win * 1000 * 0.58).toISOString() });
  assert.equal(onPace.label, 'on-pace');
  assert.ok(Math.abs(onPace.projected - 36) <= 1, `projected ${onPace.projected}`);
  const hot = F.computePace({ percent: 63, windowSeconds: win, now, resetsAt: now + win * 500 });
  assert.equal(hot.label, 'hot');
  assert.equal(hot.projected, 126);
  assert.ok(hot.hitsBeforeReset, 'reaches 100 % before reset');
  const tight = F.computePace({ percent: 50, windowSeconds: win, now, resetsAt: now + win * 500 });
  assert.equal(tight.label, 'tight');
  const early = F.computePace({ percent: 3, windowSeconds: 18000, now, resetsAt: now + 18000 * 1000 * 0.97 });
  assert.equal(early.label, 'early');
  assert.equal(F.computePace({ percent: 10, windowSeconds: 18000, now, resetsAt: null }), null);
  assert.equal(F.computePace({ percent: 10, windowSeconds: 18000, now, resetsAt: now + 2 * 18000 * 1000 }), null, 'reset beyond one window is invalid');
  const session = F.computePace({ percent: 20, windowSeconds: 18000, now, resetsAt: now + 9000 * 1000 });
  assert.ok(Math.abs(session.ratePerHour - 8) < 1e-9, `rate ${session.ratePerHour}`);
});

test('severityFor thresholds and server critical override', () => {
  assert.equal(F.severityFor(10, 'normal', 60, 85), 'ok');
  assert.equal(F.severityFor(60, 'normal', 60, 85), 'warn');
  assert.equal(F.severityFor(85, 'normal', 60, 85), 'crit');
  assert.equal(F.severityFor(5, 'critical', 60, 85), 'crit');
});

test('readSettings: token "none" means no token, port and thresholds are validated', () => {
  const B = loadCM(['icue-bridge.js']);
  const s0 = B.readSettings();
  assert.equal(s0.serverToken, '');
  assert.equal(s0.serverPort, '41780');
  B.query.serverToken = 'NONE';
  B.query.serverPort = '80';
  B.query.warnPercent = '90';
  B.query.criticalPercent = '50';
  const s1 = B.readSettings();
  assert.equal(s1.serverToken, '');
  assert.equal(s1.serverPort, '41780', 'ports below 1024 fall back to the default');
  assert.equal(s1.criticalPercent, 95, 'critical is kept at least 5 above warning');
  B.query.serverToken = 'abc-123';
  B.query.serverPort = '41781';
  const s2 = B.readSettings();
  assert.equal(s2.serverToken, 'abc-123');
  assert.equal(s2.serverPort, '41781');
});

test('fmtPercent, truncateMiddle, basename, hexToRgb, planLabel', () => {
  assert.equal(F.fmtPercent(15), '15%');
  assert.equal(F.fmtPercent(62.46), '62.5%');
  assert.equal(F.fmtPercent('x'), '--');
  assert.equal(F.truncateMiddle('abcdefghijklmnop', 9), 'abcd…mnop');
  assert.equal(F.truncateMiddle('short', 9), 'short');
  assert.equal(F.basename('c:\\Users\\pauli\\GitHub\\sendero\\'), 'sendero');
  assert.equal(F.basename('/home/x/repo'), 'repo');
  assert.equal(F.hexToRgb('#D97757'), '217, 119, 87');
  assert.equal(F.planLabel({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(F.planLabel({ organizationType: 'claude_pro' }), 'Pro');
  assert.equal(F.planLabel(null), null);
});
