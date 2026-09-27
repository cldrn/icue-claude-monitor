// Leveled logger writing to the console (when attached to a TTY or forced) and a rotating file. Redacts secrets in meta.
import fs from 'node:fs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /authorization|token|secret|cookie|password/i;
const MAX_BYTES = 1024 * 1024;

export function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export function createLogger({ file = null, level = 'info', console: toConsole = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const useConsole = toConsole === null ? Boolean(process.stdout.isTTY) : toConsole;

  function rotate() {
    try {
      if (file && fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* ignore rotation errors */ }
  }
  function write(lvl, scope, msg, meta) {
    if (LEVELS[lvl] < threshold) return;
    const parts = [new Date().toISOString(), lvl.toUpperCase().padEnd(5), scope ? scope + ':' : '', msg];
    if (meta !== undefined) {
      try { parts.push(JSON.stringify(redact(meta))); } catch { parts.push(String(meta)); }
    }
    const line = parts.filter(Boolean).join(' ');
    if (useConsole) (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
    if (file) {
      try { rotate(); fs.appendFileSync(file, line + '\n'); } catch { /* disk issues must never crash the server */ }
    }
  }
  function make(scope) {
    return {
      debug: (m, meta) => write('debug', scope, m, meta),
      info: (m, meta) => write('info', scope, m, meta),
      warn: (m, meta) => write('warn', scope, m, meta),
      error: (m, meta) => write('error', scope, m, meta),
      child: (name) => make(scope ? scope + '.' + name : name)
    };
  }
  return make('');
}
