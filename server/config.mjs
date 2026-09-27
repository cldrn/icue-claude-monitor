// Configuration: data dir, config.json defaults, CLI flags and the Claude Code file locations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULTS = Object.freeze({
  port: 41780,
  token: '',
  usageIntervalSeconds: 180,       // network polls of /api/oauth/usage, only when the cache is stale
  usageCacheMaxAgeSeconds: 300,    // how fresh ~/.claude.json cachedUsageUtilization must be to skip the network
  cloudIntervalSeconds: 60,
  localPollSeconds: 5,
  historyHours: 24,
  historyStepSeconds: 180,
  cloudEnabled: true,
  sessionTitles: true,             // read ai-title records from transcripts for nicer session names
  claudeConfigDir: null,           // default: $CLAUDE_CONFIG_DIR or ~/.claude
  claudeJsonPath: null,            // default: ~/.claude.json
  userAgent: null,                 // default: claude-cli/<version> (external, icue-claude-monitor)
  logLevel: 'info'
});

const RANGES = {
  port: [1024, 65535],
  usageIntervalSeconds: [120, 3600],
  usageCacheMaxAgeSeconds: [30, 3600],
  cloudIntervalSeconds: [30, 3600],
  localPollSeconds: [2, 60],
  historyHours: [1, 168],
  historyStepSeconds: [60, 3600]
};
const LEVELS = ['debug', 'info', 'warn', 'error'];

export function parseCli(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      once: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      scenario: { type: 'string' },
      config: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-cloud': { type: 'boolean', default: false },
      'log-level': { type: 'string' },
      history: { type: 'string' },
      help: { type: 'boolean', default: false }
    },
    strict: true,
    allowPositionals: false
  });
  return values;
}

export const HELP = `icue-claude-monitor companion server
Usage: node server/index.mjs [--port N] [--once] [--mock [--scenario NAME]] [--config FILE] [--data-dir DIR] [--no-cloud] [--log-level LEVEL] [--history 0]
  --once       poll every source once, print /api/state JSON to stdout and exit (1 if usage failed)
  --mock       serve canned scenarios from tools/mock-state.json (no file or network access)
  --history 0  with --once: omit history arrays
Config file: %LOCALAPPDATA%\\icue-claude-monitor\\config.json (created with defaults on first run)`;

function clampInt(v, [min, max], fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (raw && raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key];
  }
  for (const key of Object.keys(RANGES)) cfg[key] = clampInt(cfg[key], RANGES[key], DEFAULTS[key]);
  cfg.token = typeof cfg.token === 'string' ? cfg.token.trim() : '';
  cfg.cloudEnabled = cfg.cloudEnabled !== false;
  cfg.sessionTitles = cfg.sessionTitles !== false;
  cfg.logLevel = LEVELS.includes(cfg.logLevel) ? cfg.logLevel : 'info';
  return cfg;
}

export function loadConfig(cli = {}) {
  const dataDir = cli['data-dir'] || process.env.ICM_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'icue-claude-monitor');
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = cli.config || path.join(dataDir, 'config.json');
  let raw = {};
  let created = false;
  if (fs.existsSync(configFile)) {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } else if (!cli.config) {
    fs.writeFileSync(configFile, JSON.stringify(DEFAULTS, null, 2) + '\n');
    created = true;
  }
  const cfg = normalizeConfig(raw);
  if (cli.port) cfg.port = clampInt(cli.port, RANGES.port, cfg.port);
  if (cli['no-cloud']) cfg.cloudEnabled = false;
  if (cli['log-level'] && LEVELS.includes(cli['log-level'])) cfg.logLevel = cli['log-level'];

  const claudeConfigDir = cfg.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  cfg.paths = {
    dataDir,
    configFile,
    configCreated: created,
    historyFile: path.join(dataDir, 'history.json'),
    logFile: path.join(dataDir, 'server.log'),
    pidFile: path.join(dataDir, 'server.pid'),
    claudeConfigDir,
    credentialsFile: path.join(claudeConfigDir, '.credentials.json'),
    sessionsDir: path.join(claudeConfigDir, 'sessions'),
    projectsDir: path.join(claudeConfigDir, 'projects'),
    claudeJsonFile: cfg.claudeJsonPath || path.join(os.homedir(), '.claude.json')
  };
  return cfg;
}
