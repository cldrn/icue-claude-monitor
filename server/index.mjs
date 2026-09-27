#!/usr/bin/env node
// Companion feed server for the iCUE Claude Code monitor widget. See README "Companion server".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCli, loadConfig, HELP } from './config.mjs';
import { createLogger } from './log.mjs';
import { createPoller } from './poller.mjs';
import { createClaudeFiles } from './claude-files.mjs';
import { createHistory } from './history.mjs';
import { createState } from './state.mjs';
import { createUsageSource } from './usage.mjs';
import { createLocalSessions } from './sessions-local.mjs';
import { createCloudSource } from './sessions-cloud.mjs';
import { createHttpServer } from './http.mjs';
import { createMock } from './mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLOUD_STALE_CLEAR_MS = 30 * 60000;

async function main() {
  let cli;
  try { cli = parseCli(); } catch (e) { console.error(e.message); console.error(HELP); process.exit(2); }
  if (cli.help) { console.log(HELP); return; }
  const config = loadConfig(cli);
  const log = createLogger({ file: cli.mock ? null : config.paths.logFile, level: config.logLevel, console: cli.once ? false : null });
  if (config.paths.configCreated) log.info(`created ${config.paths.configFile} with defaults`);
  if (cli.mock) return runMock(cli, config, log);
  return runReal(cli, config, log);
}

async function runMock(cli, config, log) {
  const mock = createMock({ file: path.join(ROOT, 'tools', 'mock-state.json'), scenario: cli.scenario ?? 'normal', log });
  if (cli.once) { console.log(JSON.stringify(mock.getState({ includeHistory: cli.history !== '0' }), null, 2)); return; }
  const server = createHttpServer({
    getState: (o) => mock.getState(o),
    onScenario: (name) => mock.setScenario(name),
    onRefresh: async () => ({ queued: false, mock: true, scenario: mock.scenario }),
    token: config.token, version: pkg.version, log
  });
  await listenOrExit(server, config.port, log);
  console.log(`mock server: http://127.0.0.1:${config.port}/api/state  (scenarios: ${mock.scenarios.join(', ')}; switch with POST /api/mock/scenario?name=...)`);
  installShutdown(log, async () => { await server.close(); });
}

async function runReal(cli, config, log) {
  const files = createClaudeFiles({ paths: config.paths, log: log.child('files') });
  const history = createHistory({ file: config.paths.historyFile, hours: config.historyHours, stepSeconds: config.historyStepSeconds, log: log.child('history') });
  history.load();
  const state = createState({ config, history });
  const usage = createUsageSource({ config, files, state, history, log: log.child('usage') });
  const local = createLocalSessions({ config, paths: config.paths, files, log: log.child('local') });
  local.onUpdate((l) => state.setLocal(l));
  const cloud = createCloudSource({ config, files, state, log: log.child('cloud') });

  let lastCacheKey = null;
  async function refreshFiles() {
    state.setCredentials(await files.readCredentials());
    state.setAccount(await files.readAccount());
    const cu = await files.readCachedUsage();
    if (cu && cu.fetchedAtMs && cu.fetchedAtMs !== lastCacheKey) {
      const first = lastCacheKey === null;
      lastCacheKey = cu.fetchedAtMs;
      if (!first) usagePoller.runNow({ force: true }).catch(() => {});
    }
  }

  const filesPoller = createPoller({ name: 'files', intervalMs: 5000, run: refreshFiles, log: log.child('files') });
  const usagePoller = createPoller({ name: 'usage', intervalMs: config.usageIntervalSeconds * 1000, run: usage.run, log: log.child('usage'), minForceGapMs: 30000 });
  const localPoller = createPoller({ name: 'localSessions', intervalMs: config.localPollSeconds * 1000, run: local.refresh, log: log.child('local'), minForceGapMs: 1000 });
  const cloudPoller = createPoller({ name: 'cloudSessions', intervalMs: config.cloudIntervalSeconds * 1000, run: cloud.run, log: log.child('cloud'), enabled: config.cloudEnabled });
  state.registerSource('usage', () => usagePoller.health());
  state.registerSource('localSessions', () => localPoller.health());
  state.registerSource('cloudSessions', () => cloudPoller.health());

  if (cli.once) {
    await filesPoller.runNow();
    await usagePoller.runNow();
    await localPoller.runNow();
    if (config.cloudEnabled) await cloudPoller.runNow();
    const doc = state.buildState({ includeHistory: cli.history !== '0' });
    history.flush();
    console.log(JSON.stringify(doc, null, 2));
    const u = doc.meta.sources.usage;
    if (u.status !== 'ok') { console.error(`usage: ${u.status}${u.lastError ? ' - ' + u.lastError : ''}`); process.exitCode = 1; }
    return;
  }

  fs.writeFileSync(config.paths.pidFile, String(process.pid));
  await filesPoller.runNow();
  filesPoller.start(5000);
  usagePoller.start(200);
  localPoller.start(100);
  local.attach(localPoller);
  cloudPoller.start(1500);

  const server = createHttpServer({
    getState: (o) => state.buildState(o),
    onRefresh: async () => {
      const results = {};
      for (const [name, p] of [['usage', usagePoller], ['localSessions', localPoller], ['cloudSessions', cloudPoller]]) {
        p.runNow({ force: true }).then((r) => { if (r?.skipped) log.debug(`refresh ${name} skipped: ${r.skipped}`); }).catch(() => {});
        results[name] = 'queued';
      }
      return { queued: true, results };
    },
    token: config.token, version: pkg.version, log: log.child('http')
  });
  await listenOrExit(server, config.port, log);
  log.info(`listening on http://127.0.0.1:${config.port} (usage every ${config.usageIntervalSeconds} s, cache max age ${config.usageCacheMaxAgeSeconds} s, cloud ${config.cloudEnabled ? 'on' : 'off'})`);
  if (process.stdout.isTTY) console.log(`icue-claude-monitor server: http://127.0.0.1:${config.port}/api/state  (log: ${config.paths.logFile})`);

  const housekeeping = setInterval(() => {
    const h = cloudPoller.health();
    if (h.status === 'stale' && h.lastSuccessAt && Date.now() - Date.parse(h.lastSuccessAt) > CLOUD_STALE_CLEAR_MS && state.raw.cloud.items.length) {
      state.clearCloud();
      log.info('cloud sessions cleared after 30 min without a successful poll');
    }
  }, 60000);
  housekeeping.unref();

  installShutdown(log, async () => {
    clearInterval(housekeeping);
    for (const p of [filesPoller, usagePoller, localPoller, cloudPoller]) p.stop();
    local.close();
    history.flush();
    await server.close();
    try { fs.unlinkSync(config.paths.pidFile); } catch { /* ignore */ }
  });
}

async function listenOrExit(server, port, log) {
  try {
    await server.listen(port);
  } catch (e) {
    if (e.code === 'EADDRINUSE') { log.error(`port ${port} is already in use (another instance running?)`); console.error(`port ${port} is already in use`); process.exit(2); }
    throw e;
  }
}

function installShutdown(log, cleanup) {
  let done = false;
  async function shutdown(sig) {
    if (done) return;
    done = true;
    log.info(`shutting down (${sig})`);
    setTimeout(() => process.exit(0), 3000).unref();
    try { await cleanup(); } catch (e) { log.warn(`cleanup failed: ${e.message}`); }
    process.exit(0);
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => shutdown(sig)); } catch { /* unsupported signal */ }
  }
}

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
