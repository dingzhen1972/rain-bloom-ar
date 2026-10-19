// Headless smoke test of the web app's video mode: load a clip, force a laugh near the end,
// check that the clip end is held (frozen) until the fireworks finish, and that an export is produced.
//   node tools/smoke-test.mjs <clip.webm|mp4> [laughAtSeconds] [out.webm]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clip = path.resolve(process.argv[2]);
const laughAt = Number(process.argv[3] || 5);
const out = process.argv[4] || 'smoke-export.webm';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); } });
}).listen(0);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const log = [];
page.on('console', (m) => log.push(m.text()));
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.stack); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?res=540&debug=1`);
await page.screenshot({ path: out.replace(/\.\w+$/, '_start.png') });
await page.setInputFiles('#fileInput', clip);
// wait until playback actually starts
await page.waitForFunction(() => { const v = document.getElementById('src'); return v.currentTime > 0.2; }, null, { timeout: 30000 });
const dur = await page.evaluate(() => document.getElementById('src').duration);
console.log('clip duration', dur.toFixed(2));
await page.waitForFunction((t) => document.getElementById('src').currentTime >= t, laughAt, { timeout: 60000 });
await page.evaluate(() => window.__rainbloom.ctrl.force());
const tForce = Date.now();
await page.screenshot({ path: out.replace(/\.\w+$/, '_laugh.png') });
await page.waitForFunction(() => document.getElementById('src').ended, null, { timeout: 60000 });
const tEnd = Date.now();
const busyAtEnd = await page.evaluate(() => window.__rainbloom.fx.busy);
await page.screenshot({ path: out.replace(/\.\w+$/, '_frozen.png') });
await page.waitForSelector('#done:not([hidden])', { timeout: 60000 });
const tDone = Date.now();
const info = await page.evaluate(async () => {
  const a = document.getElementById('download'); const b = await (await fetch(a.href)).arrayBuffer();
  return { name: a.download, bytes: Array.from(new Uint8Array(b)), text: document.getElementById('resultInfo').textContent };
});
fs.writeFileSync(out, Buffer.from(info.bytes));
await page.screenshot({ path: out.replace(/\.\w+$/, '_done.png') });
console.log(JSON.stringify({ busyAtClipEnd: busyAtEnd, heldAfterClipEndSec: (tDone - tEnd) / 1000, sinceLaughSec: (tDone - tForce) / 1000, file: info.name, info: info.text }));
console.log(log.filter((l) => /error|fail|warn/i.test(l)).slice(0, 8).join('\n'));
await browser.close(); server.close();
