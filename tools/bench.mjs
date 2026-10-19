import { chromium } from 'playwright'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((q, r) => { const f = path.join(ROOT, q.url.split('?')[0]); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/javascript' }); r.end(b); } }); }).listen(0);
const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined }); const p = await b.newPage();
await p.goto(`http://127.0.0.1:${server.address().port}/tools/bench.html`); await p.waitForFunction(() => window.ready);
const skip = process.argv[2] || '';
for (const [w, q] of [[1080, 1], [720, 0.75], [540, 0.5], [540, 0.3]]) { const r = await p.evaluate(([w, q, s]) => window.bench(w, q, s), [w, q, skip]); delete r.prof; console.log(JSON.stringify(r)); }
await b.close(); server.close();
