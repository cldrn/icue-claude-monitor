/* DOM rendering: top bar, banners, usage rows (meter + countdown + pace + sparkline), session lists, states. */
globalThis.CM = globalThis.CM || {};

(function (CM) {
  'use strict';

  var F = CM.format;
  var $ = function (id) { return document.getElementById(id); };
  function tr(k) { return CM.tr(k); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function show(node, on) { if (on) node.removeAttribute('hidden'); else node.setAttribute('hidden', 'hidden'); }

  var ROW_CAP = { xl: 5, l: 4, m: 4, s: 3, v: 5 };
  var SORT_CYCLE = ['activity', 'started', 'name'];
  var STATUS_RANK = { waiting: 0, busy: 1, running: 1, idle: 2, unknown: 3 };

  var ctx = { settings: null, env: null, tier: 'xl', sort: 'activity', page: 0, sevRgb: {} };
  var sparkCanvases = [];

  /* ---------- helpers ---------- */
  function words() { return { today: tr('Today'), tomorrow: tr('Tomorrow'), ago: tr('ago'), justNow: tr('just now') }; }
  function hhmm(ms) { return F.formatClock(new Date(ms), ctx.settings ? ctx.settings.clockFormat : '24'); }
  function computeTier() {
    var w = window.innerWidth, h = window.innerHeight;
    if (h > w) return 'v';
    if (h <= 400) return 's';
    if (w >= 2200) return 'xl';
    if (w >= 1400) return 'l';
    return 'm';
  }
  function setState(s) { $('app').setAttribute('data-state', s); }
  function setTier() {
    var t = computeTier();
    if (t !== ctx.tier) { ctx.tier = t; $('app').setAttribute('data-tier', t); }
    return t;
  }
  function applySettings(s, env) {
    ctx.settings = s; ctx.env = env || ctx.env;
    ctx.sort = ctx.sort || s.sessionSort;
    var app = $('app');
    app.setAttribute('data-density', s.density);
    app.setAttribute('data-cloud', s.showWebSessions ? 'on' : 'off');
    app.setAttribute('data-sparklines', s.showSparklines ? 'on' : 'off');
    if (!app.getAttribute('data-reset-user')) app.setAttribute('data-reset', s.resetDisplay);
  }
  function resetMode() { return $('app').getAttribute('data-reset') || 'countdown'; }
  function toggleResetMode() {
    var app = $('app');
    var next = resetMode() === 'countdown' ? 'absolute' : 'countdown';
    app.setAttribute('data-reset', next);
    app.setAttribute('data-reset-user', '1');
    try { localStorage.setItem('cm.v1.reset', next); } catch (e) { /* ignore */ }
    tick();
  }
  function restoreUserPrefs() {
    try {
      var r = localStorage.getItem('cm.v1.reset');
      if (r === 'countdown' || r === 'absolute') { $('app').setAttribute('data-reset', r); $('app').setAttribute('data-reset-user', '1'); }
      var s = localStorage.getItem('cm.v1.sort');
      if (SORT_CYCLE.indexOf(s) >= 0) ctx.sort = s;
    } catch (e) { /* ignore */ }
  }
  function cycleSort() {
    ctx.sort = SORT_CYCLE[(SORT_CYCLE.indexOf(ctx.sort) + 1) % SORT_CYCLE.length];
    try { localStorage.setItem('cm.v1.sort', ctx.sort); } catch (e) { /* ignore */ }
  }
  function nextPage() { ctx.page += 1; }

  function applyStaticText() {
    $('usage-title-text').textContent = tr('Account & Usage');
    $('local-title-text').textContent = tr('Local sessions');
    $('cloud-title-text').textContent = tr('Web sessions');
    $('loading-text').textContent = tr('Connecting to companion server');
    $('offline-title').textContent = tr('Companion server not reachable');
    $('retry').textContent = tr('Retry');
  }

  /* ---------- top bar ---------- */
  function renderTopbar(doc, data) {
    var acct = doc && doc.account;
    $('account-email').textContent = (acct && acct.email) || (acct && acct.displayName) || '—';
    var plan = F.planLabel(acct);
    $('account-plan').textContent = plan || '';
    show($('account-plan'), !!plan);

    var local = (doc && doc.sessions && doc.sessions.local) || [];
    var busy = local.filter(function (s) { return s.status === 'busy' || s.status === 'waiting'; }).length;
    $('local-chip').textContent = local.length + ' ' + tr('local') + (busy ? ' · ' + busy + ' ' + tr('busy') : '');
    show($('local-chip'), !!doc);

    var cloudSrc = doc && doc.meta && doc.meta.sources && doc.meta.sources.cloudSessions;
    var cloud = (doc && doc.sessions && doc.sessions.cloud) || [];
    var running = cloud.filter(function (s) { return s.status === 'running'; }).length;
    var cloudAvailable = cloudSrc && (cloudSrc.status === 'ok' || cloudSrc.status === 'stale' || cloud.length);
    $('cloud-chip').textContent = cloudAvailable ? cloud.length + ' ' + tr('web') + (running ? ' · ' + running + ' ' + tr('running') : '') : tr('web') + ': ' + tr('n/a');
    show($('cloud-chip'), !!doc && ctx.settings && ctx.settings.showWebSessions);

    renderSyncChip(doc, data);
  }
  function renderSyncChip(doc, data) {
    var chip = $('sync-chip');
    var text;
    if (data.status === 'offline' && doc) text = tr('Offline') + ' · ' + tr('data from') + ' ' + hhmm(data.receivedAt);
    else if (data.status === 'error') text = tr('Error') + ' · ' + (data.lastError || '');
    else if (data.receivedAt) text = tr('Updated') + ' ' + F.formatRelative(data.receivedAt, Date.now(), words());
    else text = '…';
    if (doc && doc.meta && doc.meta.mock) text += ' · MOCK';
    chip.textContent = text;
    chip.setAttribute('data-status', data.status);
  }

  /* ---------- banner ---------- */
  function renderBanner(doc, data) {
    var kind = null, text = '';
    var src = doc && doc.meta && doc.meta.sources || {};
    var usage = src.usage || {};
    var token = doc && doc.account && doc.account.token || {};
    if (data.status === 'offline' && doc) { kind = 'offline'; text = tr('Companion server not reachable') + ' · ' + tr('showing data from') + ' ' + hhmm(data.receivedAt); }
    else if (data.status === 'error' && data.httpStatus === 401) { kind = 'auth'; text = tr('Access token mismatch — check the widget setting'); }
    else if (token.present === false || usage.lastErrorCode === 'no_credentials') { kind = 'auth'; text = tr('No Claude Code credentials found — sign in to Claude Code on this PC'); }
    else if (token.expired || usage.lastErrorCode === 'token_expired') { kind = 'token'; text = tr('Claude Code token expired — open Claude Code to refresh it'); }
    else if (usage.lastErrorCode === 'rate_limited') {
      kind = 'rate';
      var wait = usage.nextRetryAt ? F.formatCountdown(Date.parse(usage.nextRetryAt) - Date.now()) : null;
      text = tr('Usage API rate limited') + (wait && wait !== 'resetting' ? ' · ' + tr('retry in') + ' ' + wait : '');
    }
    else if (usage.status === 'stale' && doc.usage && doc.usage.fetchedAt) { kind = 'stale'; text = tr('Usage data from') + ' ' + hhmm(Date.parse(doc.usage.fetchedAt)) + (usage.lastError ? ' · ' + usage.lastError : ''); }
    else if (usage.status === 'error' && usage.lastError) { kind = 'stale'; text = tr('Usage unavailable') + ' · ' + usage.lastError; }
    var b = $('banner');
    b.setAttribute('data-kind', kind || '');
    $('banner-text').textContent = text;
    show(b, !!kind);
  }

  /* ---------- usage ---------- */
  function visibleLimits(limits) {
    var cap = ROW_CAP[ctx.tier] || 4;
    if (limits.length <= cap) { ctx.page = 0; return { rows: limits, hidden: 0, pages: 1 }; }
    var s = ctx.settings;
    var rank = { crit: 0, warn: 1, ok: 2 };
    var sorted = limits.slice().sort(function (a, b) {
      var ra = rank[F.severityFor(a.percent, a.severity, s.warnPercent, s.criticalPercent)];
      var rb = rank[F.severityFor(b.percent, b.severity, s.warnPercent, s.criticalPercent)];
      return ra - rb || limits.indexOf(a) - limits.indexOf(b);
    });
    var pages = Math.ceil(sorted.length / cap);
    ctx.page = ctx.page % pages;
    var rows = sorted.slice(ctx.page * cap, ctx.page * cap + cap);
    return { rows: rows, hidden: sorted.length - rows.length, pages: pages };
  }

  function resetText(limit, now) {
    if (!limit.resetsAt) return (limit.isActive === false && !limit.percent) ? tr('not started') : '—';
    var t = Date.parse(limit.resetsAt);
    if (!isFinite(t)) return '—';
    if (resetMode() === 'absolute') return tr('Resets') + ' ' + F.formatAbsolute(new Date(t), ctx.settings.clockFormat, now, words());
    var c = F.formatCountdown(t - now);
    if (c === 'resetting') return tr('resetting…');
    return tr('Resets in') + ' ' + c;
  }
  function paceLabel(p) {
    if (!p || p.label === 'early') return null;
    if (p.label === 'on-pace') return tr('on pace');
    if (p.label === 'tight') return tr('tight');
    return tr('hot');
  }
  function rateText(limit, p) {
    if (!p || p.label === 'early' || p.ratePerHour == null) return '';
    if (limit.kind === 'session') return '≈' + (Math.round(p.ratePerHour * 10) / 10) + ' %/h';
    return '≈' + (Math.round(p.ratePerDay * 10) / 10) + ' %/' + tr('day');
  }
  function hitsText(p) {
    if (!p || !p.hitsBeforeReset) return '';
    var c = F.formatCountdown(p.hits100InMs);
    return c && c !== 'resetting' ? '100% ' + tr('in') + ' ' + c : '';
  }

  function renderUsage(doc) {
    var list = $('usage-list');
    clear(list);
    sparkCanvases = [];
    var limits = (doc && doc.usage && doc.usage.limits) || [];
    var s = ctx.settings;
    var now = Date.now();
    if (!limits.length) {
      var li0 = el('li', 'usage-empty', tr('No usage data yet'));
      list.appendChild(li0);
      show($('more-limits'), false);
      return;
    }
    var vis = visibleLimits(limits);
    var withSpark = s.showSparklines && vis.rows.length <= 3;
    $('app').setAttribute('data-many-limits', vis.rows.length > 3 ? '1' : '0');
    vis.rows.forEach(function (limit) {
      var sev = F.severityFor(limit.percent, limit.severity, s.warnPercent, s.criticalPercent);
      var pace = F.computePace({ percent: limit.percent, resetsAt: limit.resetsAt, windowSeconds: limit.windowSeconds, now: now });
      var li = el('li', 'usage-row');
      li.setAttribute('data-id', limit.id);
      li.setAttribute('data-severity', sev);
      li.setAttribute('role', 'button');
      if (limit.isActive === false && !limit.percent) li.setAttribute('data-inactive', '1');
      if (limit.isActive) li.setAttribute('data-active', '1');

      var head = el('div', 'usage-head');
      var label = el('span', 'usage-label', (sev === 'crit' ? '! ' : '') + limitLabel(limit));
      head.appendChild(label);
      var chipText = paceLabel(pace);
      var chip = el('span', 'pace-chip', chipText || '');
      chip.setAttribute('data-pace', pace ? pace.label : 'none');
      show(chip, !!chipText);
      head.appendChild(chip);
      head.appendChild(el('span', 'usage-pct', F.fmtPercent(limit.percent)));
      li.appendChild(head);

      var bar = el('div', 'bar');
      var fill = el('i', 'bar-fill');
      fill.style.width = Math.max(0, Math.min(100, limit.percent)) + '%';
      bar.appendChild(fill);
      if (pace && pace.elapsedFraction > 0 && pace.elapsedFraction < 1) {
        var expect = el('i', 'bar-expect');
        expect.style.left = (pace.elapsedFraction * 100) + '%';
        expect.setAttribute('title', tr('Elapsed share of the window'));
        bar.appendChild(expect);
      }
      li.appendChild(bar);

      var foot = el('div', 'usage-foot');
      var reset = el('span', 'usage-reset', resetText(limit, now));
      reset.setAttribute('data-resets-at', limit.resetsAt || '');
      reset.setAttribute('data-percent', String(limit.percent));
      reset.setAttribute('data-active', limit.isActive ? '1' : '0');
      foot.appendChild(reset);
      var hits = hitsText(pace);
      var rate = el('span', 'usage-rate', hits ? hits + ' · ' + rateText(limit, pace) : rateText(limit, pace));
      foot.appendChild(rate);
      li.appendChild(foot);

      if (withSpark && limit.history && limit.history.length > 1) {
        var canvas = el('canvas', 'spark');
        li.appendChild(canvas);
        sparkCanvases.push({ canvas: canvas, points: limit.history, sev: sev });
      }
      list.appendChild(li);
    });

    if (doc.usage.extra && doc.usage.extra.isEnabled) {
      var ex = doc.usage.extra;
      var lix = el('li', 'usage-row usage-extra');
      lix.setAttribute('data-severity', ex.spendLimitReached ? 'crit' : 'ok');
      var h = el('div', 'usage-head');
      h.appendChild(el('span', 'usage-label', tr('Extra usage')));
      var used = ex.usedCredits != null ? String(ex.usedCredits) + (ex.monthlyLimit != null ? ' / ' + ex.monthlyLimit : '') + (ex.currency ? ' ' + ex.currency : '') : '';
      h.appendChild(el('span', 'usage-sub', used));
      h.appendChild(el('span', 'usage-pct usage-pct-small', ex.utilization != null ? F.fmtPercent(ex.utilization) : '—'));
      lix.appendChild(h);
      var bx = el('div', 'bar'); var fx = el('i', 'bar-fill'); fx.style.width = (ex.utilization || 0) + '%'; bx.appendChild(fx); lix.appendChild(bx);
      list.appendChild(lix);
    }

    var more = $('more-limits');
    if (vis.pages > 1) { more.textContent = (ctx.page + 1) + '/' + vis.pages + ' · +' + vis.hidden + ' ' + tr('more'); show(more, true); }
    else show(more, false);
    drawSparklines();
  }
  function limitLabel(limit) {
    if (limit.kind === 'session') return tr('Session (5hr)');
    if (limit.kind === 'weekly_all') return tr('Weekly (7 day)');
    if (limit.kind === 'weekly_scoped' && limit.scope && limit.scope.model) return tr('{model} limit').replace('{model}', limit.scope.model);
    return limit.label || limit.id;
  }
  function sevColor(sev) {
    var cs = getComputedStyle(document.documentElement);
    var v = cs.getPropertyValue(sev === 'crit' ? '--c-crit' : sev === 'warn' ? '--c-warn' : '--accent-color').trim();
    return v || '#ffffff';
  }
  function drawSparklines() {
    if (!sparkCanvases.length) return;
    var now = Date.now();
    var surface = 'rgba(' + getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').trim() + ',0.95)';
    sparkCanvases.forEach(function (sc) {
      if (!sc.canvas.clientWidth) return;
      CM.sparkline.draw(sc.canvas, sc.points, { fromMs: now - 24 * 3600000, toMs: now, color: sevColor(sc.sev), surface: surface });
    });
  }

  /* ---------- sessions ---------- */
  function sortSessions(items) {
    var mode = ctx.sort;
    return items.slice().sort(function (a, b) {
      if (mode === 'name') return String(a.title || a.name).localeCompare(String(b.title || b.name));
      if (mode === 'started') return (b.startedAt || 0) - (a.startedAt || 0);
      var ra = STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 3;
      var rb = STATUS_RANK[b.status] != null ? STATUS_RANK[b.status] : 3;
      return ra - rb || (b.statusUpdatedAt || b.updatedAt || 0) - (a.statusUpdatedAt || a.updatedAt || 0);
    });
  }
  function statusWord(st) {
    if (st === 'busy') return tr('busy');
    if (st === 'waiting') return tr('waiting');
    if (st === 'idle') return tr('idle');
    if (st === 'running') return tr('running');
    return st || '';
  }
  function entryBadge(ep) {
    if (!ep) return null;
    if (/vscode/i.test(ep)) return 'VS';
    if (/jetbrains|idea|pycharm|webstorm/i.test(ep)) return 'JB';
    if (/cli|terminal/i.test(ep)) return '>_';
    return String(ep).slice(0, 3).toUpperCase();
  }

  function renderLocal(doc) {
    var list = $('local-list');
    clear(list);
    var s = ctx.settings;
    var all = (doc && doc.sessions && doc.sessions.local) || [];
    var idle = all.filter(function (x) { return x.status === 'idle'; }).length;
    var items = s.showIdleSessions ? all : all.filter(function (x) { return x.status !== 'idle'; });
    items = sortSessions(items);
    var now = Date.now();
    items.forEach(function (it) {
      var li = el('li', 'session-row');
      li.setAttribute('data-status', it.status);
      li.setAttribute('title', F.truncateMiddle(it.cwd || '', 60));
      var dot = el('span', 'dot'); dot.setAttribute('aria-label', statusWord(it.status)); li.appendChild(dot);
      var main = el('span', 's-main');
      var name = el('span', 's-name', it.title || it.name);
      main.appendChild(name);
      var sub = el('span', 's-sub');
      var badge = entryBadge(it.entrypoint);
      if (badge) sub.appendChild(el('span', 'badge', badge));
      if (it.remote) sub.appendChild(el('span', 'badge badge-remote', tr('remote')));
      sub.appendChild(el('span', 's-project', it.project || ''));
      if (it.title && it.name && it.title !== it.name) sub.appendChild(el('span', 's-dim', '· ' + it.name));
      main.appendChild(sub);
      li.appendChild(main);
      var meta = el('span', 's-meta');
      var st = el('span', 's-status', statusWord(it.status));
      meta.appendChild(st);
      var act = el('span', 's-activity', F.formatRelative(it.statusUpdatedAt || it.updatedAt, now, words()) || '');
      act.setAttribute('data-at', String(it.statusUpdatedAt || it.updatedAt || ''));
      meta.appendChild(act);
      var elapsed = el('span', 's-elapsed', it.startedAt ? '⏱ ' + (F.formatElapsed(now - it.startedAt) || '') : '');
      elapsed.setAttribute('data-started', String(it.startedAt || ''));
      meta.appendChild(elapsed);
      li.appendChild(meta);
      list.appendChild(li);
    });
    $('local-count').textContent = all.length ? String(all.length) + (idle && !s.showIdleSessions ? ' (' + idle + ' ' + tr('idle') + ')' : '') : '0';
    $('local-sort').textContent = ctx.sort === 'name' ? tr('Name') : ctx.sort === 'started' ? tr('Started') : tr('Activity');
    var empty = $('local-empty');
    empty.textContent = all.length ? tr('Only idle sessions') : tr('No Claude Code sessions running');
    show(empty, !items.length);
  }

  function renderCloud(doc) {
    var list = $('cloud-list');
    clear(list);
    var src = (doc && doc.meta && doc.meta.sources && doc.meta.sources.cloudSessions) || { status: 'disabled' };
    var items = (doc && doc.sessions && doc.sessions.cloud) || [];
    var now = Date.now();
    items.forEach(function (it) {
      var li = el('li', 'session-row');
      li.setAttribute('data-status', it.status);
      li.setAttribute('title', it.repoUrl || it.id);
      var dot = el('span', 'dot'); dot.setAttribute('aria-label', statusWord(it.status)); li.appendChild(dot);
      var main = el('span', 's-main');
      main.appendChild(el('span', 's-name', it.title || it.id));
      var sub = el('span', 's-sub');
      if (it.repo) sub.appendChild(el('span', 's-project', it.repo));
      if (it.branch) sub.appendChild(el('span', 's-dim', '· ' + it.branch));
      if (it.pendingAction) sub.appendChild(el('span', 'badge badge-warn', tr('needs you')));
      main.appendChild(sub);
      li.appendChild(main);
      var meta = el('span', 's-meta');
      meta.appendChild(el('span', 's-status', statusWord(it.status)));
      var upd = el('span', 's-activity', it.updatedAt ? (F.formatRelative(Date.parse(it.updatedAt), now, words()) || '') : '');
      upd.setAttribute('data-at', it.updatedAt ? String(Date.parse(it.updatedAt)) : '');
      meta.appendChild(upd);
      li.appendChild(meta);
      list.appendChild(li);
    });
    var running = items.filter(function (x) { return x.status === 'running'; }).length;
    $('cloud-count').textContent = items.length ? String(items.length) + (running ? ' · ' + running + ' ' + tr('running') : '') : '0';
    var empty = $('cloud-empty');
    var unavailable = src.status === 'error' || src.status === 'disabled' || (src.status === 'stale' && !items.length);
    empty.textContent = unavailable ? tr('Web sessions unavailable') + (src.lastError && src.status !== 'disabled' ? ' · ' + src.lastError : '') : (src.status === 'pending' ? tr('Loading web sessions') : tr('No web sessions'));
    show(empty, !items.length);
  }

  /* ---------- states ---------- */
  function renderState(doc, data) {
    var app = $('app');
    if (data.status === 'loading' && !doc) { setState('loading'); return; }
    if (data.status === 'offline' && !doc) {
      $('offline-detail').textContent = tr('Nothing is answering on') + ' ' + CM.data.baseUrl() + (data.lastError ? ' (' + data.lastError + ')' : '');
      $('offline-hint').textContent = 'npm run serve';
      setState('offline'); return;
    }
    if (data.status === 'error' && !doc) {
      $('offline-title').textContent = data.httpStatus === 401 ? tr('Access token mismatch — check the widget setting') : tr('Companion server error');
      $('offline-detail').textContent = data.lastError || '';
      $('offline-hint').textContent = CM.data.baseUrl();
      setState('offline'); return;
    }
    $('offline-title').textContent = tr('Companion server not reachable');
    app.setAttribute('data-stale', data.status === 'offline' || data.status === 'error' ? '1' : '0');
    setState('content');
  }

  /* ---------- tick: countdowns and relative times only ---------- */
  function tick() {
    var now = Date.now();
    var mode = resetMode();
    var s = ctx.settings || CM.DEFAULTS;
    var w = words();
    var nodes = document.querySelectorAll('.usage-reset');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var iso = n.getAttribute('data-resets-at');
      if (!iso) continue;
      var t = Date.parse(iso);
      if (!isFinite(t)) continue;
      if (mode === 'absolute') n.textContent = tr('Resets') + ' ' + F.formatAbsolute(new Date(t), s.clockFormat, now, w);
      else { var c = F.formatCountdown(t - now); n.textContent = c === 'resetting' ? tr('resetting…') : tr('Resets in') + ' ' + c; }
    }
    var acts = document.querySelectorAll('.s-activity[data-at]');
    for (var j = 0; j < acts.length; j++) { var at = Number(acts[j].getAttribute('data-at')); if (at) acts[j].textContent = F.formatRelative(at, now, w) || ''; }
    var els = document.querySelectorAll('.s-elapsed[data-started]');
    for (var k = 0; k < els.length; k++) { var st = Number(els[k].getAttribute('data-started')); if (st) els[k].textContent = '⏱ ' + (F.formatElapsed(now - st) || ''); }
    renderSyncChip(CM.data.state.doc, CM.data.state);
  }

  function renderAll(data) {
    var doc = data.doc;
    setTier();
    renderState(doc, data);
    if (!doc) return;
    renderTopbar(doc, data);
    renderBanner(doc, data);
    renderUsage(doc);
    renderLocal(doc);
    renderCloud(doc);
  }

  CM.ui = {
    ctx: ctx,
    applySettings: applySettings,
    applyStaticText: applyStaticText,
    restoreUserPrefs: restoreUserPrefs,
    renderAll: renderAll,
    renderState: renderState,
    drawSparklines: drawSparklines,
    tick: tick,
    toggleResetMode: toggleResetMode,
    cycleSort: cycleSort,
    nextPage: nextPage,
    setTier: setTier,
    setState: setState
  };
})(globalThis.CM);
