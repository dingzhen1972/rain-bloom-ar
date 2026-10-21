// Face → laugh signal.
// LaughDetector wraps MediaPipe FaceLandmarker (blendshapes); LaughController turns the
// per-frame numbers into two kinds of moments: "pulse" (one ha) and "trigger" (a real laugh).

const TV_VERSION = '0.10.14';
const WASM_CANDIDATES = [
  './vendor/tasks-vision/wasm',                                            // self-hosted (see README)
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/wasm`,
  `https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/wasm`,
];
const BUNDLE_CANDIDATES = [
  './vendor/tasks-vision/vision_bundle.mjs',
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/vision_bundle.mjs`,
  `https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/vision_bundle.mjs`,
];
const SEG_MODEL_CANDIDATES = [
  './models/selfie_segmenter.tflite',
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
];
const SIL_COLS = 96;
const MODEL_CANDIDATES = [
  './models/face_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
];

const abs = (u) => (u.startsWith('.') ? new URL(u, document.baseURI).href : u);
const SIZES = { wasm: 9.4e6, model: 3.76e6, seg: 0.25e6 };   // used when a server sends no Content-Length

/** Ask every mirror for its first 256 KB at once and keep whichever answers first.
 *  Which host is fast depends on where the viewer is (GitHub Pages is often slow in mainland China, jsDelivr is not). */
async function fastest(urls, ms = 6000) {
  urls = urls.map(abs);
  const ctl = urls.map(() => new AbortController());
  const tries = urls.map((u, i) => fetch(u, { headers: { Range: 'bytes=0-262143' }, signal: ctl[i].signal, cache: 'no-store' })
    .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); await r.arrayBuffer(); return u; }));
  const timer = new Promise((res) => setTimeout(() => res(null), ms));
  let win = null;
  try { win = await Promise.race([Promise.any(tries), timer]); } catch (_) { win = null; }
  ctl.forEach((c, i) => { if (urls[i] !== win) c.abort(); });
  return win || urls[0];
}
/** Download with byte progress. force-cache so MediaPipe's own request for the same URL is served from cache. */
async function download(url, guess, onBytes) {
  const r = await fetch(url, { cache: 'force-cache' }); if (!r.ok) throw new Error(`${r.status} ${url}`);
  const total = Number(r.headers.get('content-length')) || guess;
  if (!r.body || !r.body.getReader) { const b = await r.arrayBuffer(); onBytes(b.byteLength, total); return b; }
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onBytes(got, total); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
const simdOK = (() => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (_) { return false; } })();
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(msg)), ms))]);

export class LaughDetector {
  constructor(opts = {}) { this.ready = false; this.loading = false; this.lastTs = -1; this.lm = null; this.seg = null; this.error = null; this.segEvery = opts.segEvery || 2; this.progress = 0; this._p = {}; this.timings = {}; }

  /** Safe to call early (e.g. on page load) and more than once: later calls share the same load. */
  init(onStatus = () => {}) {
    if (this._init) return this._init;
    this.loading = true; this._last = this._t0 = performance.now();
    // fail only when nothing has arrived for a long time (a slow but moving download is fine)
    const stall = new Promise((_, j) => { const t = setInterval(() => { if (this.ready || this.error) clearInterval(t); else if (performance.now() - this._last > 25000) { clearInterval(t); j(new Error('模型下载停滞')); } }, 1000); });
    this._init = Promise.race([this._load(onStatus), stall]).then(() => true, (e) => { this.error = e; this.ready = false; onStatus(''); console.warn('[LaughDetector]', e); return false; })
      .finally(() => { this.loading = false; });
    return this._init;
  }
  _bytes(key, got, total) { this._p[key] = [got, total]; this._last = performance.now(); let g = 0, t = 0; for (const k of ['wasm', 'model', 'seg']) { const v = this._p[k] || [0, SIZES[k]]; g += v[0]; t += v[1]; } this.progress = Math.min(0.99, g / t); }

  async _load(onStatus) {
    onStatus('加载识别模块…');
    let vision = null, lastErr = null;
    for (const url of BUNDLE_CANDIDATES) { try { vision = await import(/* @vite-ignore */ abs(url)); break; } catch (e) { lastErr = e; } }
    if (!vision) throw lastErr || new Error('无法加载 MediaPipe');
    this._last = performance.now();
    const wasmFile = simdOK ? 'vision_wasm_internal.wasm' : 'vision_wasm_nosimd_internal.wasm';
    const wasmBase = (await fastest(WASM_CANDIDATES.map((w) => `${w}/${wasmFile}`))).replace(/\/[^/]+$/, '');
    const modelUrl = await fastest(MODEL_CANDIDATES), segUrl = abs(SEG_MODEL_CANDIDATES[0]);
    // the three downloads run in parallel; progress is the sum of their bytes
    this.timings.start = Math.round(performance.now() - this._t0);
    const [, modelBuf, segBuf] = await Promise.all([
      download(`${wasmBase}/${wasmFile}`, SIZES.wasm, (g, t) => this._bytes('wasm', g, t)),
      download(modelUrl, SIZES.model, (g, t) => this._bytes('model', g, t)),
      download(segUrl, SIZES.seg, (g, t) => this._bytes('seg', g, t)).catch(() => null),
    ]);
    this.timings.downloaded = Math.round(performance.now() - this._t0);
    const fileset = await vision.FilesetResolver.forVisionTasks(wasmBase);
    onStatus('启动识别…');
    const make = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(modelBuf), delegate },
      runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    });
    // Some phones (seen on Honor) hang forever creating the GPU delegate. Try it for 2.5 s; if it hangs,
    // remember that on this device and go straight to the CPU next time.
    let noGpu = false; try { noGpu = localStorage.getItem('rb-nogpu') === '1'; } catch (_) {}
    if (!noGpu) { try { this.lm = await withTimeout(make('GPU'), 2500, 'GPU timeout'); this.delegate = 'GPU'; } catch (_) { try { localStorage.setItem('rb-nogpu', '1'); } catch (e) {} } }
    if (!this.lm) { this.lm = await make('CPU'); this.delegate = 'CPU'; this.segEvery = Math.max(this.segEvery, 4); }
    // face recognition is all that's needed to start; the person outline joins a moment later in the background
    this.progress = 1; this.ready = true; onStatus(''); this.timings.ready = Math.round(performance.now() - this._t0);
    if (segBuf) (async () => {
      try {
        const mkSeg = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: new Uint8Array(segBuf), delegate }, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
        });
        this.seg = this.delegate === 'GPU' ? await withTimeout(mkSeg('GPU'), 2500, 'GPU timeout').catch(() => mkSeg('CPU')) : await mkSeg('CPU');
      } catch (e) { this.seg = null; console.warn('[LaughDetector] segmentation unavailable', e); }
          this.timings.seg = Math.round(performance.now() - this._t0);
    })();

  }

  /** @returns {{face:boolean, smile:number, jaw:number, squint:number, mouth:{x:number,y:number}, box:{x:number,y:number,w:number,h:number}}|null} */
  detect(source, timeMs) {
    if (!this.ready) return null;
    const ts = Math.max(this.lastTs + 1, Math.round(timeMs));
    this.lastTs = ts;
    let res;
    try { res = this.lm.detectForVideo(source, ts); } catch (e) { return null; }
    if (this.seg && (this._segTick = (this._segTick || 0) + 1) % this.segEvery === 0) {
      try {
        this.seg.segmentForVideo(source, ts, (r) => {
          const m = r && r.confidenceMasks && r.confidenceMasks[0]; if (!m) return;
          const a = m.getAsFloat32Array(), w = m.width, h = m.height, tops = new Float32Array(SIL_COLS);
          for (let c = 0; c < SIL_COLS; c++) {
            const x = Math.min(w - 1, Math.floor(((c + 0.5) / SIL_COLS) * w)); let top = 1;
            for (let y = 0; y < h; y++) if (a[y * w + x] > 0.5) { top = y / h; break; }
            tops[c] = top;
          }
          this.sil = tops;
        });
      } catch (_) { /* keep the previous outline */ }
    }
    if (!res || !res.faceLandmarks || !res.faceLandmarks.length) return { face: false, smile: 0, jaw: 0, squint: 0, mouth: null, box: null, sil: this.sil || null };
    // several people in frame: follow the biggest (nearest) face
    let best = 0, bestArea = -1, boxes = [];
    res.faceLandmarks.forEach((L, i) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of L) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      boxes.push([x0, y0, x1, y1]); const a = (x1 - x0) * (y1 - y0); if (a > bestArea) { bestArea = a; best = i; }
    });
    const L = res.faceLandmarks[best], [x0, y0, x1, y1] = boxes[best];
    const bs = {};
    (res.faceBlendshapes?.[best]?.categories || []).forEach((c) => { bs[c.categoryName] = c.score; });
    const mouthGap = Math.abs(L[14].y - L[13].y) / Math.max(0.01, y1 - y0);
    // jawOpen varies noticeably between MediaPipe versions and camera angles. The
    // landmark gap is scale-independent, so use it as a second signal and let the
    // controller's personal baseline remove each person's resting mouth shape.
    const landmarkJaw = Math.max(0, Math.min(1, (mouthGap - 0.01) * 8));
    return {
      face: true,
      smile: ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2,
      jaw: Math.max(bs.jawOpen || 0, landmarkJaw),
      mouthGap,
      squint: ((bs.cheekSquintLeft || 0) + (bs.cheekSquintRight || 0)) / 2,
      mouth: { x: (L[13].x + L[14].x) / 2, y: (L[13].y + L[14].y) / 2 },
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      sil: this.sil || null,   // person top edge per column, in source-normalised coordinates
    };
  }
}

export class LaughController {
  // Works per person: a slow-moving baseline learns each face's resting smile and mouth opening,
  // so a naturally wide mouth or an upturned resting expression does not count as laughing.
  constructor(opts = {}) {
    this.onPulse = opts.onPulse || (() => {});
    this.onTrigger = opts.onTrigger || (() => {});
    this.triggerScore = opts.triggerScore ?? 0.42;  // sustained score that counts as a laugh
    this.holdTime = opts.holdTime ?? 0.25;          // seconds above triggerScore
    this.peaksToTrigger = opts.peaksToTrigger ?? 3; // or this many "ha" within peakWindow
    this.peakWindow = opts.peakWindow ?? 1.6;
    this.score = 0; this.state = 'still'; this.t = 0;
    this.above = 0; this.peaks = []; this.jawMin = 1; this.jawArmed = true; this.lastPeak = -9;
    this.noFace = 0; this.cooldownUntil = 0; this.laughFlash = 0;
    this.base = null; this.rel = { smile: 0, jaw: 0, squint: 0 };
  }

  static scoreOf(r) { return Math.max(0, Math.min(1, 0.55 * r.smile + 0.75 * r.jaw + 0.15 * r.squint)); }

  _relative(s, dt) {
    if (!this.base) this.base = { smile: s.smile, jaw: s.jaw, squint: s.squint };
    const out = {};
    for (const k of ['smile', 'jaw', 'squint']) {
      const v = s[k], b = this.base[k];
      this.base[k] += (v - b) * (v < b ? Math.min(1, dt * 1.5) : dt * 0.015);   // drops fast to the resting face, rises very slowly
      out[k] = Math.max(0, Math.min(1, (v - this.base[k]) / Math.max(0.25, 1 - this.base[k])));
    }
    return out;
  }

  /** sample: detector output (or null); busy: effect still playing. */
  update(sample, dt, busy) {
    this.t += dt; this.laughFlash = Math.max(0, this.laughFlash - dt);
    let raw = 0;
    if (sample && sample.face) { this.rel = this._relative(sample, dt); raw = LaughController.scoreOf(this.rel); this.noFace = 0; }
    else { this.noFace += dt; }
    const k = 1 - Math.exp(-dt * (raw > this.score ? 14 : 5));
    this.score += (raw - this.score) * k;
    if (busy) { this.state = this.laughFlash > 0 ? 'laugh' : 'bloom'; this.cooldownUntil = this.t + 1.0; this.above = 0; this.peaks = []; return this; }

    if (sample && sample.face) {   // one "ha": the jaw opens clearly from its recent low while smiling
      const j = this.rel.jaw;
      this.jawMin = Math.min(this.jawMin + dt * 0.4, j);
      if (this.jawArmed && j > this.jawMin + 0.14 && j > 0.16 && this.rel.smile > 0.12 && this.t - this.lastPeak > 0.18) {
        this.jawArmed = false; this.lastPeak = this.t; this.peaks.push(this.t);
        this.onPulse(Math.min(1.4, 0.6 + j));
      }
      if (!this.jawArmed && j < this.jawMin + 0.06) this.jawArmed = true;
    }
    this.peaks = this.peaks.filter((p) => this.t - p < this.peakWindow);
    // a laugh needs both: a smile alone, or an open jaw alone (yawn, shout, talking), does not count
    this.above = this.score > this.triggerScore && this.rel.smile > 0.2 && this.rel.jaw > 0.12 ? this.above + dt : 0;

    if (this.t >= this.cooldownUntil && this.noFace < 0.5 && (this.above >= this.holdTime || this.peaks.length >= this.peaksToTrigger)) {
      this.peaks = []; this.above = 0; this.laughFlash = 0.8;
      this.onTrigger(); this.state = 'laugh';
      return this;
    }
    this.state = this.score > 0.25 ? 'smile' : 'still';
    return this;
  }

  /** Manual trigger (tap / space) for demos or when the model is unavailable. */
  force() { this.laughFlash = 0.8; this.onTrigger(); }
}
