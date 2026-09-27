// Produces the 128x56 preview image iCUE shows in the widget selector by rendering the widget against the mock server.
// Usage: node tools/make-preview.mjs [--url http://localhost:8080/widget/index.html] [--port 41781] [--out widget/resources/preview.png]
import puppeteer from 'puppeteer-core';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return acc; }, []));
const base = args.url ?? 'http://localhost:8080/widget/index.html';
const port = String(args.port ?? '41781');
const out = args.out ?? 'widget/resources/preview.png';
const W = 128, H = 56, SCALE = 10;
const candidates = [args.chrome, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; pass --chrome');

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W * SCALE, height: H * SCALE, deviceScaleFactor: 1 });
  await page.goto(`${base}?nowait=1&serverPort=${port}&density=compact&showSparklines=false`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app').dataset.state === 'content', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  const big = await page.screenshot({ encoding: 'base64' });

  const small = await browser.newPage();
  await small.setContent('<canvas id="c"></canvas>');
  const dataUrl = await small.evaluate(async (b64, w, h) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const c = document.getElementById('c'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    const mid = document.createElement('canvas'); mid.width = w * 4; mid.height = h * 4;
    const mx = mid.getContext('2d'); mx.imageSmoothingQuality = 'high'; mx.drawImage(img, 0, 0, mid.width, mid.height);
    x.drawImage(mid, 0, 0, w, h);
    return c.toDataURL('image/png');
  }, big, W, H);
  await writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', out, `(${W}x${H})`);
} finally {
  await browser.close();
}
