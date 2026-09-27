/* Pure formatting and math helpers (no DOM): countdowns, absolute/relative times, pace, severity, text trimming. */
globalThis.CM = globalThis.CM || {};

(function (CM) {
  'use strict';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* "4d 3h", "2h 14m", "45m", "<1m"; null for unknown; "resetting" when the moment has passed */
  function formatCountdown(ms) {
    if (ms == null || !isFinite(ms)) return null;
    if (ms < 0) return 'resetting';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return '<1m';
  }

  /* Elapsed durations: "3d 2h", "1h 12m", "45m", "<1m" */
  function formatElapsed(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return null;
    var r = formatCountdown(ms);
    return r === 'resetting' ? null : r;
  }

  function formatClock(date, clock) {
    var h = date.getHours(), m = date.getMinutes();
    if (clock === '12') {
      var ampm = h >= 12 ? 'PM' : 'AM';
      var hh = h % 12; if (hh === 0) hh = 12;
      return hh + ':' + pad2(m) + ' ' + ampm;
    }
    return pad2(h) + ':' + pad2(m);
  }

  /* "Today 17:30" / "Tomorrow 09:00" / "Tue 09:00" / "Sep 30 09:00" ; labels come from `words` for translation */
  function formatAbsolute(date, clock, now, words) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    words = words || {};
    var ref = new Date(now == null ? Date.now() : now);
    var startToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
    var dayIndex = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - startToday) / 86400000);
    var time = formatClock(date, clock);
    if (dayIndex === 0) return (words.today || 'Today') + ' ' + time;
    if (dayIndex === 1) return (words.tomorrow || 'Tomorrow') + ' ' + time;
    if (dayIndex > 1 && dayIndex < 7) return DAY_NAMES[date.getDay()] + ' ' + time;
    return MONTHS[date.getMonth()] + ' ' + date.getDate() + ' ' + time;
  }

  /* "just now" / "45 s ago" / "2m ago" / "3h ago" / "2d ago" */
  function formatRelative(ms, now, words) {
    if (ms == null || !isFinite(ms)) return null;
    words = words || {};
    var ago = words.ago || 'ago';
    var diff = (now == null ? Date.now() : now) - ms;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 10) return words.justNow || 'just now';
    if (s < 60) return s + ' s ' + ago;
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + ago;
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + ago;
    var d = Math.floor(h / 24);
    return d + 'd ' + ago;
  }

  /* Pace of consumption inside the rolling window.
     Returns null when it cannot be computed; `label` is early | on-pace | tight | hot. */
  function computePace(opts) {
    var percent = Number(opts.percent);
    var windowSeconds = Number(opts.windowSeconds);
    var now = opts.now == null ? Date.now() : opts.now;
    if (opts.resetsAt == null || opts.resetsAt === '') return null;
    var resetsAt = opts.resetsAt instanceof Date ? opts.resetsAt.getTime() : (typeof opts.resetsAt === 'string' ? Date.parse(opts.resetsAt) : Number(opts.resetsAt));
    if (!isFinite(percent) || !isFinite(windowSeconds) || windowSeconds <= 0 || !isFinite(resetsAt)) return null;
    var windowMs = windowSeconds * 1000;
    var remaining = Math.max(0, resetsAt - now);
    var elapsed = windowMs - remaining;
    if (elapsed < 0 || elapsed > windowMs) return null;
    var elapsedFraction = Math.max(0, Math.min(1, elapsed / windowMs));
    if (elapsedFraction < 0.05) return { label: 'early', elapsedFraction: elapsedFraction, projected: null, ratePerHour: null, hits100InMs: null };
    var projected = Math.min(999, percent / elapsedFraction);
    var ratePerHour = percent / (elapsed / 3600000);
    var hits100InMs = ratePerHour > 0 && percent < 100 ? ((100 - percent) / ratePerHour) * 3600000 : null;
    var label = projected < 90 ? 'on-pace' : projected <= 110 ? 'tight' : 'hot';
    return {
      label: label,
      elapsedFraction: elapsedFraction,
      projected: Math.round(projected),
      ratePerHour: ratePerHour,
      ratePerDay: ratePerHour * 24,
      hits100InMs: hits100InMs,
      hitsBeforeReset: hits100InMs != null && hits100InMs < remaining
    };
  }

  /* ok | warn | crit; the server's "critical" severity always wins */
  function severityFor(percent, serverSeverity, warn, crit) {
    if (serverSeverity === 'critical') return 'crit';
    var p = Number(percent) || 0;
    if (p >= crit) return 'crit';
    if (p >= warn) return 'warn';
    return 'ok';
  }

  function fmtPercent(p) {
    var n = Number(p);
    if (!isFinite(n)) return '--';
    return (Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : Math.round(n * 10) / 10) + '%';
  }

  function basename(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function truncateMiddle(s, max) {
    s = String(s == null ? '' : s);
    if (s.length <= max || max < 5) return s;
    var keep = max - 1, head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }

  function hexToRgb(hex) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) : '0, 0, 0';
  }

  function planLabel(account) {
    if (!account) return null;
    var tier = String(account.rateLimitTier || '');
    var m = /max_(\d+)x/i.exec(tier);
    var sub = account.subscriptionType || (account.organizationType ? String(account.organizationType).replace(/^claude_/, '') : null);
    if (!sub) return null;
    var label = sub.charAt(0).toUpperCase() + sub.slice(1);
    return m ? label + ' ' + m[1] + 'x' : label;
  }

  CM.format = {
    formatCountdown: formatCountdown,
    formatElapsed: formatElapsed,
    formatClock: formatClock,
    formatAbsolute: formatAbsolute,
    formatRelative: formatRelative,
    computePace: computePace,
    severityFor: severityFor,
    fmtPercent: fmtPercent,
    basename: basename,
    truncateMiddle: truncateMiddle,
    hexToRgb: hexToRgb,
    planLabel: planLabel
  };
})(globalThis.CM);
