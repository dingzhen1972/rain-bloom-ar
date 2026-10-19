// Camera-mode check with Chromium's fake camera fed from a .y4m file:  node tools/camera-test.mjs cam.y4m outdir
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [y4m, outDir] = process.argv.slice(2);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((q, r) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(b); } }); }).listen(0);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(y4m)}`, '--autoplay-policy=no-user-gesture-required'] });
const ctxb = await browser.newContext({ viewport: { width: 400, height: 820 }, permissions: ['camera'] });
const page = await ctxb.newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?res=540`);
await page.click('#btnCamera');
await page.waitForFunction(() => document.getElementById('src').videoWidth > 0, null, { timeout: 20000 });
await page.waitForTimeout(2500); await page.screenshot({ path: `${outDir}/cam_rain.png` });
await page.click('#btnRec');            // start recording
await page.keyboard.press('h'); await page.waitForTimeout(400); await page.keyboard.press('h');
await page.waitForTimeout(500); await page.keyboard.press('Space');
await page.waitForTimeout(1600); await page.screenshot({ path: `${outDir}/cam_bloom.png` });
await page.click('#btnRec');            // ask to stop while the fireworks are still playing
const waiting = await page.evaluate(() => window.__rainbloom.fx.busy);
await page.waitForSelector('#done:not([hidden])', { timeout: 90000 });
const busyAtStop = await page.evaluate(() => window.__rainbloom.fx.busy);
await page.screenshot({ path: `${outDir}/cam_done.png` });
console.log(JSON.stringify({ busyWhenStopPressed: waiting, busyWhenRecordingEnded: busyAtStop, info: await page.evaluate(() => document.getElementById('resultInfo').textContent) }));
await browser.close(); server.close();
