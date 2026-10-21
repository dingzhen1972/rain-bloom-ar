// 雨落成花 · web AR app: camera mode, video-test mode, demo mode, recording / export.
// Wiring only: detection → controller → effect → canvas. Look lives in theme.js, physics in effect-chain.js,
// device tiers and the frame-rate governor in perf.js.
import { ChainRainEffect } from './effect-chain.js';
import { LaughDetector, LaughController } from './laugh.js';
import { drawHUD } from './hud.js';
import { Sfx } from './sfx.js';
import { detectTier, Governor } from './perf.js';
import { THEME } from './theme.js';

const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---- device tier → canvas size, detection rate, particle budget ----
const tier = detectTier(qs.get('tier'));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = $('view'), ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const RES = clamp(Number(qs.get('res')) || tier.res, 360, 1440);
canvas.width = RES; canvas.height = Math.round((RES * 16) / 9);
const W = canvas.width, H = canvas.height;
const SHOW_HUD = qs.get('hud') !== '0';
const DEBUG = qs.has('debug');

const frameBuf = document.createElement('canvas'); frameBuf.width = W; frameBuf.height = H;
const fctx = frameBuf.getContext('2d', { alpha: false });
fctx.fillStyle = '#05070f'; fctx.fillRect(0, 0, W, H);

const src = $('src');
const sfx = new Sfx();
const log = [];   // what happened when (read by tools/ci-verify.mjs)
let forcedFlag = false, mode = null;
const startQ = tier.quality * (reducedMotion ? 0.6 : 1);
const fx = new ChainRainEffect({ width: W, height: H, quality: startQ, glitter: tier.glitter, mood: 1,
  onEvent: (t, d) => { sfx.handle(t, d); log.push({ t: +(performance.now() / 1000).toFixed(2), vt: mode === 'video' ? +src.currentTime.toFixed(2) : null, type: t, forced: forcedFlag }); } });
const gov = new Governor({ ...tier, quality: startQ }, (q) => fx.setQuality(q));
const detector = new LaughDetector({ segEvery: tier.segEvery });
const ctrl = new LaughController({ onPulse: (s) => fx.pulse(s), onTrigger: () => fx.trigger(), triggerScore: clamp(Number(qs.get('th')) || 0.42, 0.3, 0.95) });
const stats = {
  frames: 0, detections: 0, faceFrames: 0, silFrames: 0, detectMs: 0,
  maxSmile: 0, maxJaw: 0, maxMouthGap: 0, maxSquint: 0, maxScore: 0,
};
window.__rainbloom = { fx, ctrl, detector, gov, tier, log, stats, force: () => { forcedFlag = true; ctrl.force(); forcedFlag = false; } };

let stream = null, facing = 'user', running = false, lastT = 0, skipToggle = false;
let videoEnded = false, recorder = null, chunks = [], recStart = 0, waitingFinish = false, finishing = false, objectUrl = null, resultUrl = null;
let sessionId = 0, discardRecording = false;
let lastSample = null, demoClock = 0, idleTime = 0, hintA = 0, bloomedOnce = false, noFace = 0, lastFaceAt = 0;
let detectEvery = 1000 / tier.detectHz, lastDetect = -1e9, lastVideoTime = -1;
const crop = { cx: 0.5, cy: 0.45, locked: false };

// ---- helpers ----
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('toast'); el.textContent = msg; el.classList.toggle('show', !!msg);
  clearTimeout(toastTimer); if (msg && ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function show(id, on) { $(id).hidden = !on; }
const inApp = /MicroMessenger|QQ\/|Weibo|AlipayClient|DingTalk|aweme|Bytedance/i.test(navigator.userAgent);

function geometry(video) {
  const sw = video.videoWidth, sh = video.videoHeight; if (!sw || !sh) return null;
  const target = 9 / 16; let cw, ch;
  if (sw / sh > target) { ch = sh; cw = sh * target; } else { cw = sw; ch = sw / target; }
  const sx = clamp(crop.cx * sw - cw / 2, 0, sw - cw), sy = clamp(crop.cy * sh - ch / 2, 0, sh - ch);
  return { sw, sh, cw, ch, sx, sy, mirror: mode === 'camera' && facing === 'user' };
}
function toOut(p, g) { let x = (p.x * g.sw - g.sx) / g.cw; if (g.mirror) x = 1 - x; return { x, y: (p.y * g.sh - g.sy) / g.ch }; }
let silOut = null;
function smoothSil(out) { if (!silOut || silOut.length !== out.length) silOut = out; else for (let i = 0; i < out.length; i++) silOut[i] += (out[i] - silOut[i]) * 0.55; return silOut; }
function mapSilhouette(s, g) {   // person outline from source coordinates into the 9:16 output (mirroring included)
  const N = 72, n = s.length, out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let xo = (i + 0.5) / N; if (g.mirror) xo = 1 - xo;
    const nx = (g.sx + xo * g.cw) / g.sw, f = clamp(nx * n - 0.5, 0, n - 1.001), k = Math.floor(f), t = s[k] + (s[k + 1] - s[k]) * (f - k);
    out[i] = t >= 0.995 ? 1 : clamp((t * g.sh - g.sy) / g.ch, 0, 1);
  }
  return smoothSil(out);
}
function headShoulders(b, g) {   // no segmentation available: estimate head + shoulders from the face box
  const c = toOut({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, g), w = (b.w * g.sw) / g.cw, h = (b.h * g.sh) / g.ch;
  const N = 72, out = new Float32Array(N), hy = c.y - 0.12 * h, rx = 0.62 * w, ry = 0.68 * h, sy = c.y + 0.78 * h;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N, dx = (x - c.x) / rx; let top = 1;
    if (Math.abs(dx) < 1) top = hy - ry * Math.sqrt(1 - dx * dx);
    const d = Math.abs(x - c.x) - 0.5 * w; top = Math.min(top, d < 0 ? sy : sy + d * 0.3 + d * d * 0.25);
    out[i] = clamp(top, 0, 1);
  }
  return smoothSil(out);
}
function drawVideoFrame(g) {
  fctx.save();
  if (g.mirror) { fctx.translate(W, 0); fctx.scale(-1, 1); }
  fctx.drawImage(src, g.sx, g.sy, g.cw, g.ch, 0, 0, W, H);
  fctx.restore();
}
const bokeh = Array.from({ length: 40 }, () => ({ x: Math.random(), y: 0.35 + Math.random() * 0.6, r: 0.02 + Math.random() * 0.07, c: [[255, 190, 120], [140, 190, 255], [255, 140, 170]][Math.floor(Math.random() * 3)], a: 0.08 + Math.random() * 0.2 }));
let demoBg = null;
function drawDemoBackground() {   // static: painted once, reused every frame
  if (!demoBg) {
    demoBg = document.createElement('canvas'); demoBg.width = W; demoBg.height = H; const c = demoBg.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#060814'); g.addColorStop(0.6, '#121a33'); g.addColorStop(1, '#241d33');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (const b of bokeh) { const x = b.x * W, y = b.y * H, r = b.r * W, rg = c.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `rgba(${b.c},${b.a})`); rg.addColorStop(1, `rgba(${b.c},0)`); c.fillStyle = rg; c.fillRect(x - r, y - r, r * 2, r * 2); }
  }
  fctx.drawImage(demoBg, 0, 0);
}

// ---- detection: only on new video frames, at the tier's rate, backing off when the model is slow ----
function maybeDetect(now) {
  if (!detector.ready || now - lastDetect < detectEvery) return null;
  const vt = src.currentTime; if (mode === 'video' && vt === lastVideoTime) return null;   // same frame as last time
  lastVideoTime = vt; lastDetect = now;
  const t0 = performance.now(), s = detector.detect(src, now), ms = performance.now() - t0;
  stats.detectMs += (ms - stats.detectMs) * 0.1; stats.detections++;
  const base = 1000 / (detector.delegate === 'CPU' ? Math.min(tier.detectHz, 12) : tier.detectHz);   // the model must never eat the frame budget (CPU inference: 12 Hz is plenty for expressions)
  detectEvery = clamp(stats.detectMs > base * 0.6 ? detectEvery * 1.1 : detectEvery * 0.98, base, 1000 / 8);
  return s;
}

// ---- main loop ----
function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  if (tier.fpsCap <= 30) { skipToggle = !skipToggle; if (skipToggle) return; }   // low tier renders at 30 fps
  const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 1 / 30); lastT = now;
  if (mode === 'camera' || (mode === 'video' && !videoEnded)) {
    if (src.readyState >= 2 && src.videoWidth) {
      const sample = maybeDetect(now), g = geometry(src);
      if (sample) {
        stats.frames++;
        const faceOK = sample.face && sample.box && sample.box.w > 0.05;   // tiny (far) faces give unreliable expressions
        if (faceOK) {
          stats.faceFrames++; lastFaceAt = now;
          const m = toOut(sample.mouth, g); fx.setMouth(m.x, m.y);
          const b = sample.box, c = toOut({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, g);
          fx.setFace(c.x, c.y, (b.w * g.sw) / g.cw, (b.h * g.sh) / g.ch);
          const k = crop.locked ? Math.min(1, dt * 2.2) : 1; crop.locked = true;   // portrait reframing follows the face
          crop.cx += (b.x + b.w / 2 - crop.cx) * k; crop.cy += (b.y + b.h * 0.45 - crop.cy) * k;
          lastSample = sample;
        }
        if (sample.sil) { stats.silFrames++; fx.setSilhouette(mapSilhouette(sample.sil, g)); }
        else if (faceOK) fx.setSilhouette(headShoulders(sample.box, g));
        ctrl.update(faceOK ? sample : null, Math.max(dt, detectEvery / 1000), fx.busy);
        if (faceOK) {
          stats.maxSmile = Math.max(stats.maxSmile, sample.smile || 0);
          stats.maxJaw = Math.max(stats.maxJaw, sample.jaw || 0);
          stats.maxMouthGap = Math.max(stats.maxMouthGap, sample.mouthGap || 0);
          stats.maxSquint = Math.max(stats.maxSquint, sample.squint || 0);
          stats.maxScore = Math.max(stats.maxScore, ctrl.score);
        }
      } else if (!detector.ready) ctrl.update(null, dt, fx.busy);
      drawVideoFrame(geometry(src));
    }
    noFace = lastFaceAt ? (now - lastFaceAt) / 1000 : 99;
    if (detector.ready) fx.setMood(noFace > 1.5 ? 0 : ctrl.rel.smile);
    else fx.setMood(1);   // no model: keep it raining so the manual trigger still has something to ignite
  } else if (mode === 'demo') {
    drawDemoBackground();
    demoClock += dt; const c = demoClock % 11;
    fx.setMouth(0.5, 0.62); fx.setFace(null); fx.setSilhouette(null); fx.setMood(c > 1.5 ? 0.7 : 0);
    if (!fx.busy) { for (const p of [3.6, 4.0]) if (Math.abs(c - p) < dt / 2) fx.pulse(1); if (Math.abs(c - 4.4) < dt / 2) ctrl.force(); }
    ctrl.update({ face: true, smile: c > 1.5 ? 0.7 : 0.05, jaw: fx.busy ? 0.5 : 0.05, squint: 0.2 }, dt, fx.busy);
  } else if (mode === 'video' && videoEnded) ctrl.update(null, dt, fx.busy);
  fx.update(dt);

  ctx.drawImage(frameBuf, 0, 0);
  fx.drawGrade(ctx); fx.draw(ctx);
  if (SHOW_HUD) drawUI(now, dt);
  if (DEBUG) debugOverlay();

  if (mode === 'video') {
    const p = src.duration ? (videoEnded ? 1 : src.currentTime / src.duration) : 0;
    $('progress').firstElementChild.style.width = `${(p * 100).toFixed(1)}%`;
    if (videoEnded && !fx.busy && !finishing) { finishing = true; setTimeout(() => stopRecording(), 400); }   // clip over AND fireworks done
  }
  if (waitingFinish && !fx.busy) stopRecording();
  gov.frame(dt * (tier.fpsCap <= 30 ? 0.5 : 1));
}

function drawUI(now, dt) {
  const T = THEME.hud;
  const hint = mode === 'demo' ? '轻点屏幕' : !detector.ready ? (detector.error ? '识别不可用 · 轻点屏幕' : detector.progress >= 0.99 ? '即将就绪' : `载入中 ${Math.round(detector.progress * 100)}%`) : noFace > 1.5 ? '把脸放进画面' : ctrl.state === 'smile' ? T.hintLaugh : T.hintSmile;
  idleTime = fx.busy ? 0 : idleTime + dt; if (fx.busy) bloomedOnce = true;
  const want = !detector.ready || mode === 'demo' || noFace > 1.5 ? 1 : fx.busy ? 0 : idleTime > (bloomedOnce ? 1.5 : 0.5) ? 1 : 0;   // guidance returns after each round
  hintA += (want - hintA) * Math.min(1, dt * 3);
  const rec = recorder && recorder.state === 'recording' ? fmt((performance.now() - recStart) / 1000) : '';
  const icon = hint === T.hintSmile ? 'smile' : hint === T.hintLaugh ? 'laugh' : null;
  drawHUD(ctx, W, H, { score: ctrl.score, state: ctrl.state, threshold: ctrl.triggerScore, hint, icon, hintAlpha: hintA, time: now / 1000, rec });
}
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function debugOverlay() {
  ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, H * 0.3, W * 0.9, 220);
  ctx.fillStyle = '#9f9'; ctx.font = `${Math.round(W / 40)}px monospace`;
  const s = lastSample || {};
  [`${tier.name} ${W}x${H}  fps ${gov.fps.toFixed(0)}  q ${fx.quality.toFixed(2)}`, `detect ${stats.detectMs.toFixed(1)}ms / ${detectEvery.toFixed(0)}ms  seg ${detector.seg ? 'on' : 'off'}`,
    `score ${ctrl.score.toFixed(2)} ${ctrl.state}  smile ${ctrl.rel.smile.toFixed(2)} jaw ${ctrl.rel.jaw.toFixed(2)}`, `raw smile ${(s.smile || 0).toFixed(2)} jaw ${(s.jaw || 0).toFixed(2)}`,
    `drops ${fx.drops.length} embers ${fx.embers.length} stars ${fx.stars.length} sparks ${fx.debris.length}`,
    `load ms ${JSON.stringify(detector.timings)} ${detector.delegate || ''}`]
    .forEach((l, i) => ctx.fillText(l, 12, H * 0.3 + 30 + i * 32));
  ctx.restore();
}

// ---- modes ----
async function begin(newMode) {
  mode = newMode; videoEnded = false; finishing = false; crop.locked = false; noFace = 0; lastFaceAt = 0; silOut = null; lastSample = null;
  show('start', false); show('done', false); show('bar', true);
  show('progress', mode === 'video');
  show('btnRec', !!(window.MediaRecorder && canvas.captureStream));
  $('btnRec').disabled = mode === 'video';
  try { await sfx.start(); } catch (_) { /* sound is optional */ }
  if (mode !== 'demo') loadModels();
  if (!running) { running = true; lastT = 0; requestAnimationFrame(loop); }
}

async function startCamera() {
  const id = ++sessionId;
  if (!window.isSecureContext) { toast('摄像头需要 https 链接打开（GitHub Pages 默认就是 https）', 6000); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(inApp ? '当前 App 内置浏览器不支持摄像头，请点右上角「在浏览器打开」' : '这个浏览器不支持摄像头，请换 Chrome 或 Safari', 6000); return; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  const tries = [
    { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false },
    { video: { facingMode: facing }, audio: false },
    { video: true, audio: false },
  ];
  let err = null, nextStream = null;
  for (const c of tries) { try { nextStream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { err = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; } }
  if (id !== sessionId) { if (nextStream) nextStream.getTracks().forEach((t) => t.stop()); return; }
  if (!nextStream) {
    const msg = { NotAllowedError: '摄像头权限被拒绝：请在浏览器设置里允许摄像头，再刷新页面', NotFoundError: '没有找到摄像头：可以用「用视频测试」或「无摄像头演示」', NotReadableError: '摄像头正被别的应用占用，关掉后再试', SecurityError: '当前页面不允许使用摄像头（需要 https）' }[err && err.name];
    toast(msg || `无法打开摄像头：${err ? err.name : '未知错误'}`, 6000); return;
  }
  stream = nextStream;
  stream.getVideoTracks()[0].addEventListener('ended', () => { toast('摄像头已断开', 4000); backToStart(); });
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  src.removeAttribute('src'); src.srcObject = stream; src.muted = true; src.setAttribute('playsinline', ''); src.loop = false;
  try { await src.play(); } catch (e) {
    stream.getTracks().forEach((t) => t.stop()); stream = null; src.srcObject = null;
    toast('无法播放摄像头画面，请再点一次', 4000); return;
  }
  if (id !== sessionId) { stream.getTracks().forEach((t) => t.stop()); stream = null; src.srcObject = null; return; }
  await begin('camera');
}

async function startVideo(file) {
  const id = ++sessionId;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const localUrl = URL.createObjectURL(file); objectUrl = localUrl;
  src.srcObject = null; src.src = localUrl; src.loop = false; src.muted = true;
  try {
    await new Promise((r, j) => {
      let timer = 0; const clear = () => { clearTimeout(timer); src.onloadeddata = null; src.onerror = null; };
      src.onloadeddata = () => { clear(); r(); };
      src.onerror = () => { clear(); j(new Error('这个视频格式浏览器解不了，换 MP4 试试')); };
      timer = setTimeout(() => { clear(); j(new Error('视频加载超时')); }, 15000);
    });
  } catch (e) {
    if (objectUrl === localUrl) { URL.revokeObjectURL(localUrl); objectUrl = null; src.removeAttribute('src'); }
    if (id === sessionId) toast(e.message, 5000); return;
  }
  if (id !== sessionId) return;
  src.onended = () => { videoEnded = true; if (fx.busy) toast('视频已结束：定格最后一帧，等烟花放完', 4000); };
  await begin('video');
  const t0 = performance.now();   // let the models warm up so the first seconds are analysed too
  while (id === sessionId && mode === 'video' && !detector.ready && !detector.error && performance.now() - t0 < 25000) await new Promise((r) => setTimeout(r, 200));
  if (id !== sessionId || mode !== 'video') return;
  src.currentTime = 0; lastVideoTime = -1; startRecording();
  try { await src.play(); } catch (e) { discardRecording = true; stopRecording(); backToStart(); toast('视频无法播放', 4000); return; }
  toast('处理中：视频播完、烟花放完后自动生成成片', 3500);
}

// ---- recording ----
function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startRecording() {
  if (!window.MediaRecorder || !canvas.captureStream) { toast('此浏览器不支持录制，可用系统录屏', 4000); return; }
  const s = canvas.captureStream(30);
  if (sfx.on && sfx.stream) sfx.stream.getAudioTracks().forEach((t) => s.addTrack(t));
  const mime = pickMime();
  try { recorder = new MediaRecorder(s, mime ? { mimeType: mime, videoBitsPerSecond: W >= 1000 ? 10_000_000 : 6_000_000 } : undefined); }
  catch (e) { toast('录制启动失败，可用系统录屏', 4000); recorder = null; return; }
  chunks = []; discardRecording = false; recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    if (discardRecording) { discardRecording = false; chunks = []; recorder = null; return; }
    showResult(new Blob(chunks, { type: recorder.mimeType || mime || 'video/webm' }));
  };
  recorder.start(500); recStart = performance.now(); setRecUI(true);
}
function requestStop() {
  if (!recorder || recorder.state !== 'recording') return;
  if (fx.busy) { waitingFinish = true; toast('等烟花放完再停止…', 0); } else stopRecording();
}
function stopRecording() {
  waitingFinish = false;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  setRecUI(false);
}
function setRecUI(on) { $('btnRec').classList.toggle('on', on); $('btnRec').setAttribute('aria-label', on ? '停止录制' : '录制'); }
function showResult(blob) {
  toast('');
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob); const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const v = $('result'); v.src = resultUrl; v.play().catch(() => {});
  const a = $('download'); a.href = resultUrl; a.download = `雨落成花-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  $('resultInfo').textContent = `${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()} · ${W}×${H}`;
  if (mode === 'video') running = false;
  show('done', true); show('bar', false);
}

function backToStart() {
  sessionId++; running = false; waitingFinish = false; finishing = false;
  if (recorder && recorder.state === 'recording') { discardRecording = true; recorder.stop(); }
  setRecUI(false);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  src.pause(); src.removeAttribute('src'); src.srcObject = null;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  show('bar', false); show('done', false); show('progress', false); show('start', true); toast('');
  mode = null; startIdle();
}
// models load as soon as the page opens; Start stays disabled (showing progress) until they are ready,
// so nobody lands in the camera with recognition still missing. On failure Start unlocks with tap-to-trigger.
function loadModels() { if (!detector.ready && !detector.error) detector.init(); }
function startButton() {
  const b = $('btnCamera'), ok = detector.ready || !!detector.error, p = detector.progress;
  // once the bytes are in, the phone still has to start the model (seconds on some devices):
  // say so instead of parking the number at 99%
  b.disabled = !ok; b.lastElementChild.textContent = ok ? '开始' : p >= 0.99 ? '即将就绪' : `载入中 ${Math.round(p * 100)}%`;
  b.firstElementChild.style.width = ok ? '0' : `${(p * 100).toFixed(1)}%`;
  b.classList.toggle('warming', !ok && p >= 0.99);
  if (!ok) setTimeout(startButton, 200);
}

// ---- wire up ----
$('btnCamera').onclick = startCamera;
$('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) startVideo(f); e.target.value = ''; };
$('btnBack').onclick = backToStart;
$('btnAgain').onclick = () => { if (mode === 'video') backToStart(); else { show('done', false); show('bar', true); } };
$('btnRec').onclick = () => (recorder && recorder.state === 'recording' ? requestStop() : startRecording());
canvas.addEventListener('click', () => { if (mode && (mode === 'demo' || detector.error)) window.__rainbloom.force(); });   // tap only as a fallback when recognition is unavailable
addEventListener('keydown', (e) => { if (!mode) return; if (e.code === 'Space') { e.preventDefault(); window.__rainbloom.force(); } if (e.key === 'h') fx.pulse(1); });
// background tab: rAF stops by itself; pause video; on return, no giant time step
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { sfx.pause(); if (mode === 'video' && !src.paused) src.pause(); }
  else { lastT = 0; if (mode) sfx.resume(); if (mode === 'video' && !videoEnded && src.paused && running) src.play().catch(() => {}); }
});
window.addEventListener('pagehide', () => { sfx.pause(); if (stream) stream.getTracks().forEach((t) => t.stop()); });
if (inApp) toast('在 App 内置浏览器里摄像头可能不可用，建议「在浏览器打开」', 6000);

// idle: rain behind the start panel, so the page is alive at once
// Cover: near-black, a faint veil of rain. Deliberately cheap (a few dozen lines at 30 fps) so the phone's CPU
// goes to loading the models, not to the cover.
const coverRain = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), v: 0.5 + Math.random() * 0.7, l: 0.04 + Math.random() * 0.07, a: 0.05 + Math.random() * 0.11 }));
let coverBg = null, coverAcc = 0;
function idle(now) {
  if (running) return;
  const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 1 / 30); lastT = now;
  coverAcc += dt; if (coverAcc < 1 / 30) { requestAnimationFrame(idle); return; }
  const step = coverAcc; coverAcc = 0;
  if (!coverBg) {
    coverBg = document.createElement('canvas'); coverBg.width = W; coverBg.height = H; const c = coverBg.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#030407'); g.addColorStop(0.55, '#07090f'); g.addColorStop(1, '#0b0d14'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    const v = c.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, H * 0.55); v.addColorStop(0, 'rgba(120,140,180,0.07)'); v.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = v; c.fillRect(0, 0, W, H);
  }
  ctx.drawImage(coverBg, 0, 0); ctx.lineWidth = Math.max(1, W / 900); ctx.lineCap = 'round';
  for (const d of coverRain) {
    d.y += d.v * step; d.x -= d.v * step * 0.07 * (H / W); if (d.y - d.l > 1) { d.y = -0.02; d.x = Math.random() * 1.1; }
    ctx.strokeStyle = `rgba(200,212,235,${d.a})`; ctx.beginPath(); ctx.moveTo(d.x * W + d.l * H * 0.07, (d.y - d.l) * H); ctx.lineTo(d.x * W, d.y * H); ctx.stroke();
  }
  requestAnimationFrame(idle);
}
function startIdle() { lastT = 0; fx.setFace(null); fx.setSilhouette(null); silOut = null; requestAnimationFrame(idle); }
startIdle();
if (qs.get('mode') !== 'demo') { loadModels(); startButton(); }
if (qs.get('mode') === 'demo') { sessionId++; begin('demo'); }
