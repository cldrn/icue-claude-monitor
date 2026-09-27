import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeToMs, deepMerge, resolveScenario, loadScenarios, createMock } from '../../server/mock.mjs';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock-state.json');

test('relativeToMs parses +2h14m / -3s / +4d2h and rejects other strings', () => {
  const now = 1_000_000;
  assert.equal(relativeToMs('+2h14m', now), now + (2 * 3600 + 14 * 60) * 1000);
  assert.equal(relativeToMs('-3s', now), now - 3000);
  assert.equal(relativeToMs('+4d2h', now), now + (4 * 86400 + 2 * 3600) * 1000);
  assert.equal(relativeToMs('+', now), null);
  assert.equal(relativeToMs('hello', now), null);
  assert.equal(relativeToMs('2026-09-26T00:00:00Z', now), null);
});

test('deepMerge merges objects, replaces arrays and scalars', () => {
  const out = deepMerge({ a: { b: 1, c: [1, 2] }, d: 'x' }, { a: { c: [3] }, d: null, e: 5 });
  assert.deepEqual(out, { a: { b: 1, c: [3] }, d: null, e: 5 });
});

test('resolveScenario turns relative times into ISO / ms by key and synthesizes history', () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const doc = resolveScenario({ usage: { limits: [{ id: 'x', percent: 40, resetsAt: '+1h', history: 'synthetic:rising' }] }, sessions: { local: [{ startedAt: '-1h', updatedAt: '-5s' }] } }, now);
  const l = doc.usage.limits[0];
  assert.equal(l.resetsAt, new Date(now + 3600000).toISOString());
  assert.equal(l.resetsInSeconds, 3600);
  assert.equal(l.history.length, 240);
  assert.equal(l.history[l.history.length - 1].p, 40);
  assert.equal(doc.sessions.local[0].startedAt, now - 3600000);
  assert.equal(doc.meta.mock, true);
});

test('all scenarios in tools/mock-state.json resolve with the expected shape', () => {
  const scenarios = loadScenarios(FILE);
  for (const [name, s] of Object.entries(scenarios)) {
    const doc = resolveScenario(s);
    assert.ok(doc.meta.sources.usage, `${name}: usage source`);
    assert.ok(Array.isArray(doc.usage.limits), `${name}: limits`);
    assert.ok(Array.isArray(doc.sessions.local) && Array.isArray(doc.sessions.cloud), `${name}: sessions`);
    for (const l of doc.usage.limits) assert.ok(l.resetsAt === null || !Number.isNaN(Date.parse(l.resetsAt)), `${name}: ${l.id} resetsAt`);
  }
  assert.equal(scenarios.critical.usage.limits[0].percent, 92);
  assert.equal(scenarios.critical.account.email, scenarios.normal.account.email, 'extends keeps the base account');
  assert.equal(scenarios.tokenExpired.account.token.expired, true);
  const m = createMock({ file: FILE, scenario: 'noCloud' });
  assert.equal(m.getState().sessions.cloud.length, 0);
  assert.equal(m.setScenario('nope').ok, false);
  assert.equal(m.setScenario('empty').ok, true);
  assert.equal(m.getState({ includeHistory: false }).usage.limits[0].history, undefined);
});
