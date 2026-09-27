/* iCUE runtime bridge: event registration, safe property access, boot detection, settings.
   NOTE: `icueEvents` must be a bare global assignment (no var/let/const) and this file
   must not be in strict mode at top level, otherwise iCUE cannot see the handlers. */
globalThis.CM = globalThis.CM || {};

(function (CM) {
  'use strict';

  var listeners = { ready: [], update: [], translations: [] };
  CM.onIcue = function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); };
  CM.emitIcue = function (evt) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(); } catch (e) { console.error('[CM] handler error', evt, e); }
    });
  };

  /* Browser-only overrides for the dev harness: ?serverPort=41780&density=compact ... */
  var query = {};
  try {
    if (typeof location !== 'undefined' && location.search) {
      location.search.slice(1).split('&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
        var v = decodeURIComponent(i < 0 ? '1' : kv.slice(i + 1));
        query[k] = v;
      });
    }
  } catch (e) { /* ignore */ }
  CM.query = query;

  /* iCUE may inject property values either on window or as locals of a sandboxed
     function context. Check both; never reference the property names directly. */
  var SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  CM.getIcueProperty = function (name, fallback) {
    if (!SAFE_NAME.test(name)) return fallback;
    if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
      var v = window[name];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    try {
      var value = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
      if (value !== undefined && value !== null && value !== '') return value;
    } catch (e) { /* not injected */ }
    if (Object.prototype.hasOwnProperty.call(query, name) && query[name] !== '') return query[name];
    return fallback;
  };

  /* iCUE's tr() may return a Promise (async translation lookup). Never render that directly:
     return the English key now, cache the resolved string and ask the UI to re-render. */
  var trCache = {};
  var trNotify = null;
  CM.tr = function (key) {
    if (Object.prototype.hasOwnProperty.call(trCache, key)) return trCache[key];
    try {
      if (typeof tr === 'function') {
        var t = tr(key);
        if (t && typeof t.then === 'function') {
          t.then(function (v) {
            if (typeof v === 'string' && v && v !== key) {
              trCache[key] = v;
              clearTimeout(trNotify);
              trNotify = setTimeout(function () { CM.emitIcue('translations'); }, 150);
            } else {
              trCache[key] = key;
            }
          }).catch(function () { trCache[key] = key; });
          return key;
        }
        if (typeof t === 'string' && t) { trCache[key] = t; return t; }
      }
    } catch (e) { /* no tr() */ }
    return key;
  };

  /* A single false read of iCUE_initialized is a race; retry for ~1.5 s before
     concluding the widget runs in a plain browser. */
  CM.bootCheck = function (onReady) {
    var attempts = 0, MAX = 15, EVERY = 100;
    if (query.nowait) MAX = 1;
    function env(inIcue) {
      var ic = (typeof iCUE !== 'undefined' && iCUE) ? iCUE : null;
      return {
        inIcue: inIcue,
        fpsLimit: (ic && Number(ic.fpsLimit)) || 30,
        isPreview: !!(ic && ic.isPreview) || query.preview === '1',
        language: (ic && ic.iCUELanguage) || 'en'
      };
    }
    (function check() {
      if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) { onReady(env(true)); return; }
      if (attempts++ < MAX) { setTimeout(check, EVERY); return; }
      onReady(env(false));
    })();
  };

  var DEFAULTS = {
    serverPort: '41780',
    serverToken: 'none',
    refreshSeconds: 10,
    warnPercent: 60,
    criticalPercent: 85,
    showSparklines: true,
    resetDisplay: 'countdown',
    showWebSessions: true,
    showIdleSessions: true,
    sessionSort: 'activity',
    clockFormat: '24',
    density: 'comfortable',
    textColor: '#FFFFFF',
    accentColor: '#D97757',
    backgroundColor: '#000000',
    transparency: 100
  };
  CM.DEFAULTS = DEFAULTS;

  function bool(v, d) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true' || v === '1';
    if (typeof v === 'number') return v !== 0;
    return d;
  }
  function num(v, d, min, max) {
    var n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.max(min, Math.min(max, n));
  }
  function oneOf(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }
  function color(v, d) { return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : d; }
  function port(v, d) {
    var s = String(v == null ? '' : v).replace(/\D/g, '');
    var n = Number(s);
    return (n >= 1024 && n <= 65535) ? String(n) : d;
  }
  function token(v) {
    var s = String(v == null ? '' : v).trim();
    if (s.toLowerCase() === 'none') return '';
    return /^[A-Za-z0-9._-]{0,128}$/.test(s) ? s : '';
  }

  CM.readSettings = function () {
    var g = CM.getIcueProperty;
    var s = {
      serverPort: port(g('serverPort'), DEFAULTS.serverPort),
      serverToken: token(g('serverToken', DEFAULTS.serverToken)),
      refreshSeconds: num(g('refreshSeconds'), DEFAULTS.refreshSeconds, 5, 60),
      warnPercent: num(g('warnPercent'), DEFAULTS.warnPercent, 10, 95),
      criticalPercent: num(g('criticalPercent'), DEFAULTS.criticalPercent, 20, 100),
      showSparklines: bool(g('showSparklines'), DEFAULTS.showSparklines),
      resetDisplay: oneOf(g('resetDisplay'), ['countdown', 'absolute'], DEFAULTS.resetDisplay),
      showWebSessions: bool(g('showWebSessions'), DEFAULTS.showWebSessions),
      showIdleSessions: bool(g('showIdleSessions'), DEFAULTS.showIdleSessions),
      sessionSort: oneOf(g('sessionSort'), ['activity', 'started', 'name'], DEFAULTS.sessionSort),
      clockFormat: oneOf(String(g('clockFormat', DEFAULTS.clockFormat)), ['24', '12'], DEFAULTS.clockFormat),
      density: oneOf(g('density'), ['comfortable', 'compact'], DEFAULTS.density),
      textColor: color(g('textColor'), DEFAULTS.textColor),
      accentColor: color(g('accentColor'), DEFAULTS.accentColor),
      backgroundColor: color(g('backgroundColor'), DEFAULTS.backgroundColor),
      transparency: num(g('transparency'), DEFAULTS.transparency, 0, 100)
    };
    if (s.criticalPercent < s.warnPercent + 5) s.criticalPercent = Math.min(100, s.warnPercent + 5);
    return s;
  };
})(globalThis.CM);

icueEvents = {
  onDataUpdated: function () { CM.emitIcue('update'); },
  onICUEInitialized: function () { CM.emitIcue('ready'); }
};
