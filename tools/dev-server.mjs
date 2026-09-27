// Zero-dependency static server for local widget testing.
// Usage: node tools/dev-server.mjs [port]  ->  http://localhost:8080/tools/preview.html
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2] ?? 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};
http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(root, urlPath);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const st = statSync(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`dev server: http://localhost:${port}/tools/preview.html`));
