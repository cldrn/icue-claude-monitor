// Process liveness helpers: pid checks and Windows process start-time (FILETIME) verification via one PowerShell call.
import { execFile } from 'node:child_process';

const EPOCH_DIFF_100NS = 116444736000000000n; // 1601-01-01 -> 1970-01-01 in 100 ns ticks

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function filetimeToMs(ft) {
  try { return Number((BigInt(String(ft)) - EPOCH_DIFF_100NS) / 10000n); } catch { return NaN; }
}

/** True when two FILETIME strings are within `toleranceTicks` (default 10 ms). */
export function procStartMatches(a, b, toleranceTicks = 100000n) {
  if (a == null || b == null) return false;
  try {
    const d = BigInt(String(a)) - BigInt(String(b));
    return (d < 0n ? -d : d) <= toleranceTicks;
  } catch { return false; }
}

/** ConvertTo-Json emits an object for one result and an array for several; empty output for none. */
export function parseProcList(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  const j = JSON.parse(s);
  const arr = Array.isArray(j) ? j : [j];
  return arr.filter((x) => x && Number.isInteger(x.pid) && x.ft != null).map((x) => ({ pid: x.pid, ft: String(x.ft) }));
}

/** Resolves to Map<pid, filetimeString>, or null when the query cannot run (non-Windows, timeout, error). */
export function queryProcStarts(pids, { timeoutMs = 8000, exec = execFile } = {}) {
  const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return Promise.resolve(new Map());
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { [pscustomobject]@{ pid = $_.Id; ft = $_.StartTime.ToFileTimeUtc().ToString() } } catch { } } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(new Map(parseProcList(stdout).map((x) => [x.pid, x.ft]))); } catch { resolve(null); }
      });
  });
}
