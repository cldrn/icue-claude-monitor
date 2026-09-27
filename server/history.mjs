// Rolling per-limit utilization history (ring buffer) persisted atomically to history.json.
import fs from 'node:fs';

export function createHistory({ file, hours = 24, stepSeconds = 180, maxPoints = 600, log, now = Date.now }) {
  const series = new Map(); // id -> [{t, p}]
  let lastKey = null;
  let dirty = false;
  let saveTimer = null;

  function prune(arr, t) {
    const cutoff = t - hours * 3600e3;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    while (arr.length > maxPoints) arr.shift();
  }

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.series && typeof j.series === 'object') {
        for (const [id, arr] of Object.entries(j.series)) {
          if (!Array.isArray(arr)) continue;
          const clean = arr.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.p)).map((p) => ({ t: p.t, p: p.p }));
          prune(clean, now());
          series.set(id, clean);
        }
      }
      lastKey = j?.lastKey ?? null;
      log?.info?.(`history loaded (${series.size} series)`);
    } catch (e) {
      log?.warn?.(`history unreadable (${e.message}); starting fresh`);
      try { fs.renameSync(file, file + '.bad'); } catch { /* ignore */ }
    }
  }

  function flush() {
    if (!dirty) return;
    clearTimeout(saveTimer); saveTimer = null;
    const doc = { savedAt: new Date(now()).toISOString(), lastKey, series: Object.fromEntries(series) };
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(doc));
      fs.renameSync(file + '.tmp', file);
      dirty = false;
    } catch (e) { log?.warn?.(`history save failed: ${e.message}`); }
  }
  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 60000);
    saveTimer.unref?.();
  }

  /** Records one point per limit unless the sample key (e.g. fetchedAtMs) was already recorded. */
  function sample(limits, t = now(), key = null) {
    if (key != null && key === lastKey) return false;
    let added = false;
    for (const l of limits) {
      let arr = series.get(l.id);
      if (!arr) { arr = []; series.set(l.id, arr); }
      const last = arr[arr.length - 1];
      if (last && t <= last.t) continue;                                   // never go backwards in time
      if (last && t - last.t < stepSeconds * 1000 && last.p === l.percent) continue;
      if (last && t - last.t < stepSeconds * 500) continue;                // never denser than half a step
      arr.push({ t, p: l.percent });
      prune(arr, t);
      added = true;
    }
    if (key != null) lastKey = key;
    if (added) scheduleSave();
    return added;
  }

  function get(id) { return series.get(id) ?? []; }
  function ids() { return [...series.keys()]; }

  return { load, flush, sample, get, ids, get size() { return series.size; } };
}
