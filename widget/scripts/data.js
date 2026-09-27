/* Companion server client: polls /api/state, caches the last document, backs off on failure, host fallback. */
globalThis.CM = globalThis.CM || {};

(function (CM) {
  'use strict';

  var CACHE_KEY = 'cm.v1.state';
  var HOSTS = ['127.0.0.1', 'localhost'];
  var FETCH_TIMEOUT = 8000;
  var BACKOFF = [5000, 10000, 20000, 60000];

  var state = {
    doc: null, receivedAt: 0, fromCache: false,
    status: 'loading',   // loading | content | offline | error
    lastError: null, httpStatus: null, failures: 0, host: null, hostIndex: 0,
    lastForceAt: 0
  };
  var settings = { serverPort: '41780', serverToken: '', refreshSeconds: 10 };
  var wantHistory = true;
  var timer = null;
  var inflight = false;
  var listeners = { update: [], status: [] };

  function on(evt, fn) { listeners[evt].push(fn); }
  function emit(evt) { listeners[evt].forEach(function (fn) { try { fn(state); } catch (e) { console.error('[CM.data]', e); } }); }
  function setStatus(s, err, http) {
    var changed = s !== state.status || err !== state.lastError;
    state.status = s; state.lastError = err || null; state.httpStatus = http || null;
    if (changed) emit('status');
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      var o = JSON.parse(raw);
      if (!o || !o.doc) return false;
      state.doc = o.doc; state.receivedAt = o.receivedAt || 0; state.fromCache = true;
      return true;
    } catch (e) { return false; }
  }
  function saveCache() {
    try {
      var slim = JSON.parse(JSON.stringify(state.doc));
      if (slim && slim.usage && slim.usage.limits) slim.usage.limits.forEach(function (l) { delete l.history; });
      localStorage.setItem(CACHE_KEY, JSON.stringify({ receivedAt: state.receivedAt, doc: slim }));
    } catch (e) { /* quota / unavailable */ }
  }

  function baseUrl() {
    var host = state.host || HOSTS[state.hostIndex % HOSTS.length];
    return 'http://' + host + ':' + settings.serverPort;
  }
  function withToken(url) {
    return settings.serverToken ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(settings.serverToken) : url;
  }

  function fetchJson(url, init) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT) : null;
    init = init || {};
    if (ctrl) init.signal = ctrl.signal;
    init.cache = 'no-store';
    return fetch(url, init).finally(function () { if (t) clearTimeout(t); });
  }

  function poll() {
    if (inflight) return Promise.resolve();
    inflight = true;
    var url = baseUrl() + '/api/state' + (wantHistory ? '' : '?history=0');
    return fetchJson(withToken(url))
      .then(function (res) {
        if (res.status === 401) { var e = new Error('unauthorized'); e.http = 401; throw e; }
        if (!res.ok) { var e2 = new Error('HTTP ' + res.status); e2.http = res.status; throw e2; }
        return res.json();
      })
      .then(function (doc) {
        if (!doc || !doc.meta) throw new Error('bad payload');
        state.host = state.host || HOSTS[state.hostIndex % HOSTS.length];
        state.doc = doc; state.receivedAt = Date.now(); state.fromCache = false; state.failures = 0;
        saveCache();
        setStatus('content', null, null);
        emit('update');
        schedule(Math.max(5, settings.refreshSeconds) * 1000);
      })
      .catch(function (err) {
        state.failures += 1;
        var msg = (err && err.message) || String(err);
        if (err && err.http) setStatus('error', msg, err.http);
        else {
          if (!state.host) state.hostIndex += 1;   // try the other loopback name next time
          if (state.doc && state.failures < 2) { /* keep content for one miss */ }
          else setStatus('offline', msg, null);
        }
        console.warn('[CM.data] poll failed: ' + msg);
        schedule(BACKOFF[Math.min(BACKOFF.length - 1, state.failures - 1)]);
      })
      .finally(function () { inflight = false; });
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function start(s) {
    updateSettings(s);
    loadCache();
    if (state.doc) emit('update');
    return poll();
  }
  function updateSettings(s) {
    var changed = s.serverPort !== settings.serverPort || s.serverToken !== settings.serverToken;
    settings = { serverPort: s.serverPort, serverToken: s.serverToken, refreshSeconds: s.refreshSeconds };
    if (changed) { state.host = null; state.hostIndex = 0; state.failures = 0; if (timer) schedule(50); }
  }
  function setHistoryWanted(v) { wantHistory = !!v; }
  function refreshNow() { clearTimeout(timer); return poll(); }

  /* Asks the server to poll its sources right away, then re-fetches. Rate-limited client-side. */
  function forceServerRefresh() {
    var now = Date.now();
    if (now - state.lastForceAt < 10000) return refreshNow();
    state.lastForceAt = now;
    return fetchJson(withToken(baseUrl() + '/api/refresh'), { method: 'POST' })
      .catch(function () { /* ignore */ })
      .then(function () { clearTimeout(timer); timer = setTimeout(poll, 1500); });
  }

  CM.data = { state: state, on: on, start: start, updateSettings: updateSettings, setHistoryWanted: setHistoryWanted, refreshNow: refreshNow, forceServerRefresh: forceServerRefresh, baseUrl: baseUrl };
})(globalThis.CM);
