// Drives the widget in a real Chrome (via puppeteer-core) to verify rendering at XENEON EDGE slot sizes.
// Usage: node tools/screenshot.mjs [--url http://localhost:8080/widget/index.html] [--out tools/.shots]
//        [--sizes 2536x696,1688x696,840x696,840x344,696x416,696x840] [--port 41781] [--scenario critical]
//        [--offline] [--set density=compact,clockFormat=12] [--mock-tr] [--chrome "C:\\path\\chrome.exe"]
// Needs `npm run dev` (static server) and `npm run serve:mock -- --port 41781` (or the real server) running.
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return acc; }, []));
const port = String(args.port ?? '41781');
const base = args.url ?? 'http://localhost:8080/widget/index.html';
const out = args.out ?? 'tools/.shots';
const sizes = String(args.sizes ?? '2536x696,1688x696,840x696,840x344,696x416,696x840').split(',').map((s) => s.split('x').map(Number));
const candidates = [args.chrome, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; pass --chrome');

if (args.scenario) {
  const r = await fetch(`http://127.0.0.1:${port}/api/mock/scenario?name=${encodeURIComponent(args.scenario)}`, { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) console.warn(`could not switch scenario "${args.scenario}" on port ${port} (is the mock server running?)`);
}

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--hide-scrollbars'] });
try {
  for (const [w, h] of sizes) {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    if (args['mock-tr']) {
      await page.evaluateOnNewDocument(() => { window.tr = (k) => new Promise((r) => setTimeout(() => r(String(k).toUpperCase()), 300)); });
    }
    if (args.set) {
      const props = Object.fromEntries(String(args.set).split(',').map((kv) => { const [k, v] = kv.split('='); return [k, v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)]; }));
      await page.evaluateOnNewDocument((p) => { for (const k of Object.keys(p)) window[k] = p[k]; }, props);
    }
    if (args.offline) {
      await page.setRequestInterception(true);
      page.on('request', (req) => (/^http:\/\/(127\.0\.0\.1|localhost):\d+\/(api|healthz)/.test(req.url()) ? req.abort('failed') : req.continue()));
    }
    const url = `${base}?nowait=1&serverPort=${port}`;
    await page.goto(url, { waitUntil: 'load' });
    try {
      await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && ['content', 'offline', 'error'].includes(app.dataset.state);
      }, { timeout: 15000 });
    } catch { logs.push('warn: timed out waiting for a settled state'); }
    await new Promise((r) => setTimeout(r, 800));
    const state = await page.evaluate(() => {
      const app = document.getElementById('app');
      const txt = (id) => (document.getElementById(id) || {}).textContent || '';
      return {
        state: app.dataset.state, tier: app.dataset.tier, reset: app.dataset.reset,
        banner: document.getElementById('banner').hasAttribute('hidden') ? null : txt('banner-text'),
        sync: txt('sync-chip'),
        limits: [...document.querySelectorAll('.usage-row')].map((r) => `${r.querySelector('.usage-label')?.textContent}=${r.querySelector('.usage-pct')?.textContent} [${r.dataset.severity}] ${r.querySelector('.usage-reset')?.textContent || ''} ${r.querySelector('.pace-chip:not([hidden])')?.textContent || ''}`.trim()),
        localCount: document.querySelectorAll('#local-list .session-row').length,
        cloudCount: document.querySelectorAll('#cloud-list .session-row').length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        overflowY: [...document.querySelectorAll('.usage-list, .session-list')].some((l) => l.scrollHeight > l.clientHeight + 2)
      };
    });
    const file = path.join(out, `shot-${w}x${h}${args.scenario ? '-' + args.scenario : ''}${args.offline ? '-offline' : ''}${args.set ? '-set' : ''}.png`);
    await page.screenshot({ path: file });
    console.log(`${w}x${h} -> ${file}`);
    console.log('  ', JSON.stringify(state));
    for (const l of logs) console.log('   log:', l);
    await page.close();
  }
} finally {
  await browser.close();
}
