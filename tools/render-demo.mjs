// Render a real clip + the effect into a 9:16 phone video, offline and frame-exact.
// If the clip ends before the firework sequence finishes, the last frame is held until it does.
//
//   node tools/render-demo.mjs <framesDir> <track.json> <out.mp4> [--audio events.wav]
//   framesDir: JPGs extracted at 30 fps (ffmpeg -i clip.webm -vf fps=30 frames/%04d.jpg)
//   track.json: { src:[w,h], cropW, frames:[{cropX, mouth:[x,y]}], score:[[t,v]...], pulses:[t...], trigger:t }
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [framesDir, trackPath, outPath] = process.argv.slice(2);
const FPS = 30, OUT = [1080, 1920], SEQ = 7.8;
const track = JSON.parse(fs.readFileSync(trackPath, 'utf8'));
const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
const total = Math.max(frames.length, track.trigger == null ? 0 : Math.ceil((track.trigger + SEQ) * FPS) + 12);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const file = u.startsWith('/__frames/') ? path.join(path.resolve(framesDir), u.slice(10)) : path.join(ROOT, u);
  fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(buf); });
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error(e); process.exit(1); });
await page.goto(`http://127.0.0.1:${port}/tools/offline.html`);
await page.waitForFunction(() => window.ready);
await page.evaluate((cfg) => window.setup(cfg), { ...track, fps: FPS, out: OUT, total });

const PREVIEW = process.env.PREVIEW ? process.env.PREVIEW.split(',').map(Number) : null;
const ff = PREVIEW ? null : spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath], { stdio: ['pipe', 'inherit', 'inherit'] });
for (let i = 0; i < total; i++) {
  const url = i < frames.length ? `/__frames/${frames[i]}` : null;   // past the end: hold the last frame
  const grab = !PREVIEW || PREVIEW.includes(i);
  const { data } = await page.evaluate(([i, url, g]) => window.step(i, url, g), [i, url, grab]);
  if (grab) {
    const buf = Buffer.from(data.split(',')[1], 'base64');
    if (PREVIEW) fs.writeFileSync(outPath.replace(/\.mp4$/, `_${String(i).padStart(3, '0')}.jpg`), buf);
    else if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  if (i % 60 === 0) console.log(`frame ${i}/${total}${i >= frames.length ? ' (holding last frame)' : ''}`);
}
fs.writeFileSync(outPath.replace(/\.mp4$/, '.events.json'), JSON.stringify({ fps: FPS, total, clipFrames: frames.length, events: await page.evaluate(() => window.getEvents()) }));
if (ff) { ff.stdin.end(); await new Promise((r) => ff.on('close', r)); }
await browser.close(); server.close();
console.log(`wrote ${outPath}: ${total} frames (${(total / FPS).toFixed(2)} s), clip ${frames.length} frames, held ${Math.max(0, total - frames.length)} frames`);
