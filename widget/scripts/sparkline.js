/* Canvas sparkline: 24 h utilization series, 0-100 %, 2 px line, 10 % area wash, gaps at resets, end dot. */
globalThis.CM = globalThis.CM || {};

(function (CM) {
  'use strict';

  function draw(canvas, points, opts) {
    opts = opts || {};
    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    var cssW = canvas.clientWidth || canvas.width || 100;
    var cssH = canvas.clientHeight || canvas.height || 24;
    var W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    var g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);

    var toMs = opts.toMs || Date.now();
    var fromMs = opts.fromMs || (toMs - 24 * 3600000);
    var color = opts.color || '#ffffff';
    var pad = 2 * dpr;
    var lw = (opts.lineWidth || 2) * dpr;

    /* baseline hairline */
    g.strokeStyle = opts.gridColor || 'rgba(255,255,255,0.14)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H - 0.5); g.lineTo(W, H - 0.5); g.stroke();

    var pts = (points || []).filter(function (p) { return p && isFinite(p.t) && isFinite(p.p) && p.t >= fromMs && p.t <= toMs; });
    if (pts.length < 2) return;

    function x(t) { return pad + ((t - fromMs) / (toMs - fromMs)) * (W - 2 * pad); }
    function y(p) { return pad + (1 - Math.max(0, Math.min(100, p)) / 100) * (H - 2 * pad - lw / 2); }

    /* split into runs at resets (sharp drops) */
    var runs = [], run = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      if (pts[i - 1].p - pts[i].p > 20) { runs.push(run); run = []; }
      run.push(pts[i]);
    }
    runs.push(run);

    g.lineJoin = 'round'; g.lineCap = 'round';
    runs.forEach(function (r) {
      if (r.length < 2) return;
      /* area wash */
      g.beginPath();
      g.moveTo(x(r[0].t), H - pad);
      r.forEach(function (p) { g.lineTo(x(p.t), y(p.p)); });
      g.lineTo(x(r[r.length - 1].t), H - pad);
      g.closePath();
      g.globalAlpha = opts.muted ? 0.06 : 0.12;
      g.fillStyle = color;
      g.fill();
      g.globalAlpha = 1;
      /* line */
      g.beginPath();
      r.forEach(function (p, j) { if (j === 0) g.moveTo(x(p.t), y(p.p)); else g.lineTo(x(p.t), y(p.p)); });
      g.strokeStyle = color;
      g.globalAlpha = opts.muted ? 0.5 : 0.9;
      g.lineWidth = lw;
      g.stroke();
      g.globalAlpha = 1;
    });

    /* end dot with a surface ring */
    var last = pts[pts.length - 1];
    var r = Math.max(3 * dpr, lw * 1.5);
    g.beginPath(); g.arc(x(last.t), y(last.p), r + 1.5 * dpr, 0, Math.PI * 2); g.fillStyle = opts.surface || 'rgba(0,0,0,0.9)'; g.fill();
    g.beginPath(); g.arc(x(last.t), y(last.p), r, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  }

  CM.sparkline = { draw: draw };
})(globalThis.CM);
