// Local Claude Code sessions: ~/.claude/sessions/<pid>.json with liveness + process start-time verification.
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive, procStartMatches, queryProcStarts } from './procs.mjs';

const SESSION_FILE = /^(\d+)\.json$/;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

export function scanSessionsDir(dir) {
  const files = [];
  let malformed = 0;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return { files, malformed, error: e.code === 'ENOENT' ? 'missing' : e.message }; }
  for (const name of entries) {
    const m = SESSION_FILE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!data || typeof data !== 'object') { malformed++; continue; }
      files.push({ pid: Number(m[1]), data, mtimeMs: fs.statSync(full).mtimeMs });
    } catch { malformed++; }
  }
  return { files, malformed, error: null };
}

function basename(cwd) {
  const s = String(cwd || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Pure merge of scanned files with liveness facts.
 * @param files   [{pid, data}]
 * @param alive   Set<pid> of pids that exist
 * @param procMap Map<pid, filetime> from PowerShell, or null when the query was unavailable
 * @param cache   Map<pid, {procStart, ok}> previous verdicts
 */
export function mergeLiveness(files, alive, procMap, cache) {
  const items = [];
  const cacheUpdates = new Map();
  let staleFiles = 0;
  let reused = 0;
  for (const f of files) {
    const d = f.data;
    const pid = f.pid;
    if (!alive.has(pid)) { staleFiles++; continue; }
    const procStart = d.procStart != null ? String(d.procStart) : null;
    let verified;
    const cached = cache.get(pid);
    if (cached && cached.procStart === procStart) {
      if (!cached.ok) { reused++; continue; }
      verified = 'procStart';
    } else if (procMap && procMap.has(pid) && procStart) {
      const ok = procStartMatches(procStart, procMap.get(pid));
      cacheUpdates.set(pid, { procStart, ok });
      if (!ok) { reused++; continue; }
      verified = 'procStart';
    } else {
      verified = 'pid';
    }
    items.push({
      pid,
      sessionId: d.sessionId ?? null,
      name: d.name ?? `pid ${pid}`,
      nameSource: d.nameSource ?? null,
      title: null,
      cwd: d.cwd ?? null,
      project: basename(d.cwd),
      entrypoint: d.entrypoint ?? null,
      kind: d.kind ?? null,
      version: d.version ?? null,
      status: typeof d.status === 'string' ? d.status : 'unknown',
      startedAt: Number(d.startedAt) || null,
      updatedAt: Number(d.updatedAt) || null,
      statusUpdatedAt: Number(d.statusUpdatedAt) || Number(d.updatedAt) || null,
      verified,
      remote: false
    });
  }
  return { items, staleFiles, reused, cacheUpdates };
}

export function encodeProjectDir(cwd) { return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'); }

async function readChunk(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead).toString('utf8');
}

/** Finds the last ai-title record in a transcript by reading its head and tail only. */
export async function readTranscriptTitle(projectsDir, cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const encoded = encodeProjectDir(cwd);
  let dir = path.join(projectsDir, encoded);
  if (!fs.existsSync(dir)) {
    try {
      const hit = fs.readdirSync(projectsDir).find((n) => n.toLowerCase() === encoded.toLowerCase());
      if (!hit) return null;
      dir = path.join(projectsDir, hit);
    } catch { return null; }
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const tailStart = Math.max(0, size - TAIL_BYTES);
    let text = await readChunk(fh, tailStart, size - tailStart);
    if (tailStart > HEAD_BYTES) text = (await readChunk(fh, 0, HEAD_BYTES)) + '\n' + text;
    let title = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) title = rec.aiTitle.trim();
      } catch { /* partial line */ }
    }
    return { title, size };
  } catch { return null; } finally { await fh?.close?.(); }
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function createLocalSessions({ config, paths, files, log, now = Date.now, query = queryProcStarts }) {
  const verifyCache = new Map(); // pid -> {procStart, ok}
  const titleCache = new Map();  // sessionId -> {size, title, checkedAt}
  let latest = { items: [], staleFiles: 0, reused: 0, malformed: 0, verifier: 'procStart', error: null, maxVersion: null };
  let watcher = null;
  let debounce = null;
  let listeners = [];
  let poller = null;

  function maxVersion(items) {
    let best = null;
    for (const it of items) {
      if (!it.version) continue;
      if (!best || compareVersions(it.version, best) > 0) best = it.version;
    }
    return best;
  }

  async function enrichTitles(items) {
    if (!config.sessionTitles) return;
    const t = now();
    for (const it of items) {
      if (!it.sessionId || !it.cwd) continue;
      const c = titleCache.get(it.sessionId);
      if (c && t - c.checkedAt < 60000) { it.title = c.title; continue; }
      const r = await readTranscriptTitle(paths.projectsDir, it.cwd, it.sessionId);
      const entry = { size: r?.size ?? 0, title: r?.title ?? c?.title ?? null, checkedAt: t };
      titleCache.set(it.sessionId, entry);
      it.title = entry.title;
    }
    for (const id of [...titleCache.keys()]) if (!items.some((i) => i.sessionId === id)) titleCache.delete(id);
  }

  async function refresh() {
    const scan = scanSessionsDir(paths.sessionsDir);
    const alive = new Set(scan.files.map((f) => f.pid).filter((pid) => pidAlive(pid)));
    const needQuery = [...alive].filter((pid) => {
      const f = scan.files.find((x) => x.pid === pid);
      const ps = f?.data?.procStart != null ? String(f.data.procStart) : null;
      const c = verifyCache.get(pid);
      return ps && !(c && c.procStart === ps);
    });
    let procMap = new Map();
    let verifier = 'procStart';
    if (needQuery.length) {
      procMap = await query(needQuery);
      if (procMap === null) { verifier = 'pid-only'; log?.debug?.('process start query unavailable; pid-only verification'); }
      else log?.debug?.(`verified process start for pids ${needQuery.join(',')}`);
    }
    const merged = mergeLiveness(scan.files, alive, procMap, verifyCache);
    for (const [pid, v] of merged.cacheUpdates) verifyCache.set(pid, v);
    for (const pid of [...verifyCache.keys()]) if (!alive.has(pid)) verifyCache.delete(pid);
    let bridges = new Map();
    try { bridges = await files.readBridgePlaceholders(); } catch { /* optional */ }
    for (const it of merged.items) if (bridges.has(it.pid)) it.remote = true;
    await enrichTitles(merged.items);
    latest = {
      items: merged.items, staleFiles: merged.staleFiles, reused: merged.reused, malformed: scan.malformed,
      verifier, error: scan.error, maxVersion: maxVersion(merged.items)
    };
    for (const fn of listeners) { try { fn(latest); } catch (e) { log?.warn?.(`listener failed: ${e.message}`); } }
    return latest;
  }

  function armWatcher() {
    if (watcher) return;
    try {
      watcher = fs.watch(paths.sessionsDir, { persistent: false }, (_evt, name) => {
        if (name && !SESSION_FILE.test(String(name))) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => { poller?.runNow({ force: true }); }, 500);
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* ignore */ }
        watcher = null;
        setTimeout(armWatcher, 30000).unref?.();
      });
    } catch { watcher = null; setTimeout(armWatcher, 30000).unref?.(); }
  }

  return {
    refresh,
    get latest() { return latest; },
    onUpdate(fn) { listeners.push(fn); },
    attach(p) { poller = p; armWatcher(); },
    close() { clearTimeout(debounce); try { watcher?.close(); } catch { /* ignore */ } watcher = null; listeners = []; }
  };
}
