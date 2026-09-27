// Loopback HTTP API for the widget: /healthz, /api/state, /api/refresh (+ mock scenario switch). CORS open, optional token.
import http from 'node:http';
import crypto from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Widget-Token, Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600'
};

function tokenOk(expected, req, url) {
  if (!expected) return true;
  const given = req.headers['x-widget-token'] ?? url.searchParams.get('token') ?? '';
  const a = Buffer.from(String(given)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createHttpServer({ getState, onRefresh = null, onScenario = null, token = '', version = '0.0.0', log }) {
  const startedAt = Date.now();
  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(json)
    });
    res.end(json);
  }

  let requests = 0;
  let lastRequestAt = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests += 1;
    lastRequestAt = Date.now();
    log?.debug?.(`${req.method} ${url.pathname} from ${req.socket.remoteAddress} origin=${req.headers.origin ?? '-'} ua=${(req.headers['user-agent'] ?? '-').slice(0, 60)}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { ok: true, version, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), requests, lastRequestAt: lastRequestAt ? new Date(lastRequestAt).toISOString() : null });
    }
    if (!tokenOk(token, req, url)) return send(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, getState({ includeHistory: url.searchParams.get('history') !== '0' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const r = onRefresh ? await onRefresh() : { queued: false };
        return send(res, 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/mock/scenario' && onScenario) {
        const r = onScenario(url.searchParams.get('name'));
        return send(res, r.ok ? 200 : 404, r);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log?.error?.(`request failed: ${e.message}`);
      return send(res, 500, { error: 'internal', message: e.message });
    }
  });
  server.keepAliveTimeout = 5000;

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() { return new Promise((resolve) => server.close(() => resolve())); }
  };
}
