import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../../server/http.mjs';

const refreshes = [];
const srv = createHttpServer({
  getState: ({ includeHistory }) => ({ meta: { ok: true, includeHistory }, usage: { limits: [] } }),
  onRefresh: async () => { refreshes.push(1); return { queued: true }; },
  onScenario: (name) => (name === 'critical' ? { ok: true, scenario: name } : { ok: false, error: 'unknown scenario' }),
  token: 'secret-1',
  version: '9.9.9'
});
const addr = await srv.listen(0);
const base = `http://127.0.0.1:${addr.port}`;
after(() => srv.close());

test('healthz needs no token', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.version, '9.9.9');
});

test('state requires the token via header or query, and honors history=0', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state?token=wrong')).status, 401);
  const q = await fetch(base + '/api/state?token=secret-1&history=0');
  assert.equal(q.status, 200);
  assert.equal((await q.json()).meta.includeHistory, false);
  const h = await fetch(base + '/api/state', { headers: { 'X-Widget-Token': 'secret-1' } });
  assert.equal(h.status, 200);
  assert.equal((await h.json()).meta.includeHistory, true);
});

test('CORS headers on every response and a 204 preflight with private-network allowance', async () => {
  const r = await fetch(base + '/api/state?token=secret-1');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const o = await fetch(base + '/api/state', { method: 'OPTIONS' });
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('access-control-allow-private-network'), 'true');
  assert.match(o.headers.get('access-control-allow-headers'), /X-Widget-Token/);
});

test('refresh and mock scenario endpoints; unknown routes 404', async () => {
  const r = await fetch(base + '/api/refresh?token=secret-1', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(refreshes.length, 1);
  assert.equal((await fetch(base + '/api/mock/scenario?name=critical&token=secret-1', { method: 'POST' })).status, 200);
  assert.equal((await fetch(base + '/api/mock/scenario?name=zzz&token=secret-1', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/nope?token=secret-1')).status, 404);
});
