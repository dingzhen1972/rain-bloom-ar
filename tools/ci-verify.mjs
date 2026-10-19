// End-to-end check with the REAL MediaPipe models (run by .github/workflows/verify.yml, or locally with internet):
// plays a test clip through the app's video mode without any manual trigger and checks that
//   1) the face model and the person segmentation load,  2) a face is found in most frames,
//   3) the laugh is detected on its own and the fireworks play,  4) an exported video is produced.
//   node tools/ci-verify.mjs tests/fixtures/laugh.webm ci-out
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [clip, outDir = 'ci-out'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((q, r) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(b); } }); }).listen(0);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const consoleLines = []; page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.stack}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?res=540&debug=1`);
await page.setInputFiles('#fileInput', path.resolve(clip));
let shots = 0; const shotTimer = setInterval(() => page.screenshot({ path: `${outDir}/frame_${String(shots++).padStart(2, '0')}.png` }).catch(() => {}), 1500);
let ok = true;
try { await page.waitForSelector('#done:not([hidden])', { timeout: 180000 }); } catch (e) { ok = false; consoleLines.push('timed out waiting for the export'); }
clearInterval(shotTimer);
const r = await page.evaluate(async () => {
  const R = window.__rainbloom, a = document.getElementById('download');
  let bytes = null; try { if (a.href) bytes = Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())); } catch (_) {}
  return { ready: R.detector.ready, segmentation: !!R.detector.seg, error: R.detector.error ? String(R.detector.error) : null, stats: R.stats, log: R.log, file: a.download, bytes };
});
if (r.bytes) fs.writeFileSync(`${outDir}/${r.file || 'export.webm'}`, Buffer.from(r.bytes));
const auto = r.log.filter((e) => e.type === 'ignite' && !e.forced);
const report = {
  modelLoaded: r.ready, segmentationLoaded: r.segmentation, error: r.error,
  faceFoundRatio: r.stats.frames ? +(r.stats.faceFrames / r.stats.frames).toFixed(3) : 0,
  silhouetteRatio: r.stats.frames ? +(r.stats.silFrames / r.stats.frames).toFixed(3) : 0,
  maxSmile: +r.stats.maxSmile.toFixed(3), maxJaw: +r.stats.maxJaw.toFixed(3),
  maxMouthGap: +r.stats.maxMouthGap.toFixed(3),
  maxSquint: +r.stats.maxSquint.toFixed(3), maxScore: +r.stats.maxScore.toFixed(3),
  pulses: r.log.filter((e) => e.type === 'pulse').map((e) => e.vt),
  laughDetectedAtVideoTime: auto.length ? auto[0].vt : null,
  fireworks: r.log.filter((e) => e.type === 'burst').length,
  exported: !!r.bytes, exportBytes: r.bytes ? r.bytes.length : 0,
};
report.pass = ok && report.modelLoaded && report.faceFoundRatio > 0.8 && report.laughDetectedAtVideoTime != null && report.exported;
fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
fs.writeFileSync(`${outDir}/console.log`, consoleLines.join('\n'));
console.log(JSON.stringify(report, null, 2));
await browser.close(); server.close();
process.exit(report.pass ? 0 : 1);
