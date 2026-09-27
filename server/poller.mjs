// Generic poller: setTimeout chaining, exponential backoff with jitter, retry-after floors, health reporting.
export class PollError extends Error {
  constructor(message, { statusCode = null, retryAfterMs = null, fixedDelayMs = null, code = null } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.fixedDelayMs = fixedDelayMs;
    this.code = code;
  }
}

export function createPoller({ name, intervalMs, run, log, maxBackoffMs = 3600000, minForceGapMs = 60000, enabled = true, now = Date.now }) {
  const s = {
    enabled, started: false, inFlight: false, failures: 0,
    lastSuccessAt: null, lastAttemptAt: null, lastError: null, lastStatusCode: null, lastCode: null,
    nextRetryAt: null, retryAfterUntil: null, timer: null
  };

  function jitter(ms) { return Math.round(ms * (0.9 + Math.random() * 0.2)); }
  function schedule(delay) {
    clearTimeout(s.timer);
    if (!s.started) return;
    s.timer = setTimeout(tick, Math.max(50, delay));
  }

  async function tick() {
    if (s.inFlight || !s.enabled) return { ran: false };
    s.inFlight = true;
    const t0 = now();
    s.lastAttemptAt = t0;
    try {
      await run();
      s.failures = 0;
      s.lastSuccessAt = now();
      s.lastError = null;
      s.lastStatusCode = null;
      s.lastCode = null;
      s.nextRetryAt = now() + intervalMs;
      s.retryAfterUntil = null;
      log?.debug?.(`${name} ok in ${now() - t0} ms`);
      schedule(intervalMs);
      return { ran: true, ok: true };
    } catch (err) {
      s.failures += 1;
      s.lastError = err?.message || String(err);
      s.lastStatusCode = err?.statusCode ?? null;
      s.lastCode = err?.code ?? null;
      let delay = err?.fixedDelayMs ?? Math.min(maxBackoffMs, intervalMs * 2 ** (s.failures - 1));
      delay = jitter(delay);
      if (err?.retryAfterMs) {
        delay = Math.max(delay, err.retryAfterMs);
        s.retryAfterUntil = now() + err.retryAfterMs;
      }
      s.nextRetryAt = now() + delay;
      log?.warn?.(`${name} failed: ${s.lastError} (attempt ${s.failures}, retry in ${Math.round(delay / 1000)} s)`);
      schedule(delay);
      return { ran: true, ok: false, error: err };
    } finally {
      s.inFlight = false;
    }
  }

  return {
    name,
    start(initialDelayMs = 0) { if (!s.enabled) return; s.started = true; schedule(initialDelayMs); },
    stop() { s.started = false; clearTimeout(s.timer); s.timer = null; },
    async runNow({ force = false } = {}) {
      if (!s.enabled) return { skipped: 'disabled' };
      if (s.inFlight) return { skipped: 'inflight' };
      const t = now();
      if (s.retryAfterUntil && t < s.retryAfterUntil) return { skipped: 'retry-after', nextRetryAt: s.retryAfterUntil };
      if (!force && s.nextRetryAt && t < s.nextRetryAt && s.lastAttemptAt) return { skipped: 'scheduled', nextRetryAt: s.nextRetryAt };
      if (force && s.lastSuccessAt && t - s.lastSuccessAt < minForceGapMs) return { skipped: 'recent', nextRetryAt: s.lastSuccessAt + minForceGapMs };
      return tick();
    },
    health() {
      const t = now();
      let status;
      if (!s.enabled) status = 'disabled';
      else if (s.lastSuccessAt == null) status = s.lastAttemptAt == null ? 'pending' : 'error';
      else if (s.failures > 0 || t - s.lastSuccessAt > 3 * intervalMs) status = 'stale';
      else status = 'ok';
      return {
        status,
        lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
        lastAttemptAt: s.lastAttemptAt ? new Date(s.lastAttemptAt).toISOString() : null,
        lastError: s.lastError,
        lastErrorCode: s.lastCode,
        lastStatusCode: s.lastStatusCode,
        consecutiveFailures: s.failures,
        nextRetryAt: s.nextRetryAt && s.started ? new Date(s.nextRetryAt).toISOString() : null,
        intervalSeconds: Math.round(intervalMs / 1000)
      };
    },
    get state() { return s; }
  };
}
