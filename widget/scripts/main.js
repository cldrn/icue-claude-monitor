/* Wiring: boot -> settings -> data -> render; timers; touch handlers. */
(function () {
  'use strict';
  var CM = globalThis.CM;
  var F = CM.format;

  var env = { inIcue: false, fpsLimit: 30, isPreview: false };
  var settings = CM.readSettings();
  var lastSettingsJson = '';
  var booted = false;
  var resizeTimer = null;

  function applyStyles(s) {
    var root = document.documentElement.style;
    root.setProperty('--text-color', s.textColor);
    root.setProperty('--accent-color', s.accentColor);
    root.setProperty('--accent-rgb', F.hexToRgb(s.accentColor));
    root.setProperty('--bg-rgb', F.hexToRgb(s.backgroundColor));
    root.setProperty('--bg-opacity', String(s.transparency / 100));
  }

  function historyWanted() {
    var tier = CM.ui.ctx.tier;
    return settings.showSparklines && tier !== 's' && tier !== 'm';
  }

  function applySettings() {
    var next = CM.readSettings();
    var json = JSON.stringify(next);
    if (json === lastSettingsJson) return;
    settings = next;
    lastSettingsJson = json;
    applyStyles(settings);
    CM.ui.applySettings(settings, env);
    CM.data.updateSettings(settings);
    CM.data.setHistoryWanted(historyWanted());
    if (booted) CM.ui.renderAll(CM.data.state);
  }

  function boot(e) {
    env = e;
    CM.ui.applyStaticText();
    CM.ui.restoreUserPrefs();
    CM.ui.setTier();
    applySettings();
    CM.data.on('update', function (st) { CM.ui.renderAll(st); });
    CM.data.on('status', function (st) { CM.ui.renderAll(st); });
    booted = true;
    CM.data.start(settings);
  }

  /* ---------- touch / click ---------- */
  function tap(id, fn) {
    var node = document.getElementById(id);
    if (!node) return;
    node.addEventListener('pointerup', function (ev) { ev.preventDefault(); fn(ev); });
    node.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(ev); } });
  }
  tap('retry', function () { CM.ui.setState('loading'); CM.data.refreshNow(); });
  tap('topbar', function () { CM.data.forceServerRefresh(); });
  tap('usage-list', function (ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest('.usage-row') : null;
    if (row) CM.ui.toggleResetMode();
  });
  tap('usage-title', function () { CM.ui.nextPage(); CM.ui.renderAll(CM.data.state); });
  tap('local-title', function () { CM.ui.cycleSort(); CM.ui.renderAll(CM.data.state); });

  /* ---------- timers ---------- */
  CM.onIcue('update', applySettings);
  CM.onIcue('ready', applySettings);
  CM.onIcue('translations', function () { CM.ui.applyStaticText(); if (booted) CM.ui.renderAll(CM.data.state); });
  setInterval(applySettings, 5000);                    // some iCUE builds update values without firing onDataUpdated
  setInterval(function () { if (booted) CM.ui.tick(); }, 10000);
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var before = CM.ui.ctx.tier;
      CM.ui.setTier();
      CM.data.setHistoryWanted(historyWanted());
      if (booted) { if (before !== CM.ui.ctx.tier) CM.ui.renderAll(CM.data.state); else CM.ui.drawSparklines(); }
    }, 150);
  });

  if (typeof icueEvents === 'undefined') console.warn('[CM] icueEvents missing');
  CM.bootCheck(boot);
})();
