// 雨落成花 —— smile: rain falls around you, in real depth, and lands on you.
//              laugh: the rain ignites drop by drop, embers drift up, fireworks open behind you,
//                     and a golden cascade bursts above your head, its sparks bouncing off your head and shoulders.
//
//   const fx = new ChainRainEffect({ width, height, quality, onEvent });
//   fx.setMood(smile)             // 0..1 relative smile: drives how hard it rains
//   fx.setMouth(x, y)             // normalised: where the laugh comes from
//   fx.setFace(cx, cy, w, h)      // normalised face box: distance from the camera + head position
//   fx.setSilhouette(tops)        // person's top edge per column (0..1, 1 = nobody): collisions + occlusion
//   fx.pulse() / fx.trigger()     // one "ha" / the laugh
//   each frame: fx.update(dt); fx.drawGrade(ctx); fx.draw(ctx);  fx.busy while the sequence plays
//
// Look (colours, sizes, choreography, grade) lives in theme.js. This file is physics + drawing mechanics.
// Depth model: pinhole camera, focal f ≈ 0.9·H px. Each raindrop has a distance z (0.22 … 14 m); speed,
// streak length, thickness, focus and fog follow from z. The person stands at zp, estimated from face width.

import { THEME } from './theme.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const inv = (a, b, x) => clamp((x - a) / (b - a));
const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (v) => v - Math.floor(v);
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// remove element i in O(1) (order is not needed for particles)
function drop(arr, i) { const last = arr.pop(); if (i < arr.length) arr[i] = last; }

const Z_FAR = 14, FALL = 7.5, SHUTTER = 1 / 45, MAX_RAIN = 1150;
export const SEQUENCE_LENGTH = 7.8;

export class ChainRainEffect {
  constructor(opts = {}) {
    this.theme = opts.theme || THEME;
    this.quality = opts.quality ?? 1;
    this.glitter = opts.glitter ?? true;
    this.onEvent = opts.onEvent || (() => {});
    this.rand = opts.seed != null ? mulberry32(opts.seed) : Math.random;
    this.drops = []; this.splash = []; this.embers = []; this.flares = []; this.stars = []; this.debris = [];
    this.rockets = []; this.smoke = []; this.flashes = []; this.glows = []; this.queue = [];
    this.mouth = { x: 0.5, y: 0.58 }; this.face = null; this.faceV = { x: 0, y: 0 };
    this.sil = null; this.silV = null; this.silPath = null; this._silT = 0; this.zp = 0.7;
    this.state = 'rain'; this.tau = 0; this.time = 0; this.ts = 1; this.gradeV = this.theme.grade.rainLevel;
    this.mood = opts.mood ?? 1; this.rainLevel = this.mood; this._sprites = new Map();
    this.resize(opts.width || 1080, opts.height || 1920);
    const n = Math.round(this.target * this.rainLevel); for (let i = 0; i < n; i++) this._spawn(true);
  }

  // ---------- inputs ----------
  resize(w, h) { this.W = w; this.H = h; this.S = Math.min(w, h) / 1080; this.f = 0.9 * h; this._vig = null; this.setQuality(this.quality); }
  setQuality(q) { this.quality = clamp(q, 0.3, 1); this.target = Math.round(MAX_RAIN * this.quality * Math.min(1.5, (this.W * this.H) / (1080 * 1920))); }
  /** 0..1 smile (relative to the person's resting face). Rain follows it. */
  setMood(m) { this.mood = clamp(m); }
  setMouth(x, y) { this.mouth.x = clamp(x); this.mouth.y = clamp(y); }
  setFace(cx, cy, w, h) {
    if (cx == null) { this.face = null; return; }
    const nx = cx * this.W, ny = cy * this.H, dt = Math.max(1 / 120, this.time - (this._faceT ?? this.time - 1 / 30));
    if (this.face) { this.faceV.x += ((nx - this.face.cx) / dt - this.faceV.x) * 0.5; this.faceV.y += ((ny - this.face.cy) / dt - this.faceV.y) * 0.5; }
    this._faceT = this.time;
    this.face = { cx: nx, cy: ny, rx: (w * this.W) / 2, ry: (h * this.H) / 2 };
    this.zp += (clamp((this.f * 0.15) / Math.max(1, w * this.W), 0.3, 3) - this.zp) * 0.2;
  }
  setSilhouette(tops) {
    if (!tops || !tops.length) { this.sil = null; this.silV = null; this.silPath = null; return; }
    const dt = Math.max(1 / 120, this.time - this._silT); this._silT = this.time;
    const prev = this.sil, n = tops.length;
    tops = this._constrainToFace(tops);
    if (!this.silV || this.silV.length !== n) this.silV = new Float32Array(n);
    for (let i = 0; i < n; i++) {   // how fast each part of the outline moves (the head pushing sparks around)
      const v = prev && prev.length === n && tops[i] < 0.995 && prev[i] < 0.995 ? ((tops[i] - prev[i]) * this.H) / dt : 0;
      this.silV[i] += (clamp(v, -3000, 3000) - this.silV[i]) * 0.5;
    }
    this.sil = Float32Array.from(tops);
  }
  /** Person segmentation often swallows what is behind the person (a high chair back, a dark beam, a coat).
   *  The face box is far more reliable, so it bounds the outline: above the head at most a hair's margin,
   *  beside the head no higher than the chin. Columns with nobody (≥ 0.995) are left alone. */
  _constrainToFace(tops) {
    const f = this.face; if (!f) return tops;
    const n = tops.length, out = new Float32Array(n);
    const headTop = (f.cy - f.ry * 2.5) / this.H, chin = (f.cy + f.ry * 0.5) / this.H, wide = f.rx * 1.7;   // room for big hair, a bun or a cap
    for (let i = 0; i < n; i++) {
      const t = tops[i]; if (t >= 0.995) { out[i] = t; continue; }
      const dx = Math.abs(((i + 0.5) / n) * this.W - f.cx);
      // a rounded head cap inside the face width, the chin line outside it, blended over half a face width
      const cap = dx < wide ? headTop + (1 - Math.sqrt(Math.max(0, 1 - (dx / wide) ** 2))) * (chin - headTop) : chin;
      out[i] = Math.min(1, Math.max(t, cap));
    }
    return out;
  }
  get busy() { return this.state === 'bloom'; }

  _r(a = 1, b) { return b === undefined ? this.rand() * a : a + this.rand() * (b - a); }
  /** person's top edge (px) at screen x, or Infinity */
  _top(x) {
    if (this.sil) {
      const n = this.sil.length, f = clamp(x / this.W, 0, 0.9999) * n - 0.5, i = Math.floor(f), k = f - i;
      const a = this.sil[clamp(i, 0, n - 1)], b = this.sil[clamp(i + 1, 0, n - 1)];
      if (a >= 0.995 && b >= 0.995) return Infinity;
      return (a >= 0.995 ? b : b >= 0.995 ? a : a + (b - a) * k) * this.H;
    }
    if (this.face) { const dx = (x - this.face.cx) / (this.face.rx * 1.25); if (Math.abs(dx) < 1) return this.face.cy - this.face.ry * 1.25 * Math.sqrt(1 - dx * dx); }
    return Infinity;
  }
  _topVel(x) {
    if (this.sil && this.silV) { const n = this.sil.length; return this.silV[clamp(Math.floor((x / this.W) * n), 0, n - 1)]; }
    return this.faceV.y;
  }
  _span() {
    if (this.sil) { let a = -1, b = -1; for (let i = 0; i < this.sil.length; i++) if (this.sil[i] < 0.995) { if (a < 0) a = i; b = i; } if (a >= 0) return [(a / this.sil.length) * this.W, ((b + 1) / this.sil.length) * this.W]; }
    if (this.face) return [this.face.cx - this.face.rx * 2.4, this.face.cx + this.face.rx * 2.4];
    return null;
  }
  _headTop() {   // highest point of the person and its x
    if (this.sil) { let m = 1, mi = -1; for (let i = 0; i < this.sil.length; i++) if (this.sil[i] < m) { m = this.sil[i]; mi = i; } if (mi >= 0) return { x: ((mi + 0.5) / this.sil.length) * this.W, y: m * this.H }; }
    if (this.face) return { x: this.face.cx, y: this.face.cy - this.face.ry * 1.3 };
    return { x: this.W / 2, y: this.H * 0.35 };
  }

  // ---------- spawning ----------
  _spawn(anywhere = false) {
    const R = this.theme.rain, u = this.rand(), zp = this.zp, span = this._span();
    let z, x, band = false;
    if (u < R.near) z = u < R.near * 0.25 ? this._r(0.22, 0.34) : this._r(0.34, Math.max(0.36, zp - 0.1));   // between the lens and the person: drawn over them
    else if (u < R.near + R.onPerson && span) { z = this._r(zp - 0.08, zp + 0.18); band = true; x = this._r(span[0], span[1]); }
    else if (u < 0.7) z = this._r(zp + 0.3, 4.5);
    else z = this._r(4.5, Z_FAR);
    if (x === undefined) x = this._r(-0.05, 1.05) * this.W - (R.wind || 0) * this.H * 0.6;   // upwind start so the slant fills the frame
    const v = (this.f * FALL / z) * this._r(0.9, 1.1);
    const len = Math.min(v * SHUTTER, this.H * 0.32);   // a lens-hugging drop reads as a soft streak, not a scratch across the frame
    const w = clamp(this.f * R.dropWidth / z, 0.55 * this.S, 11 * this.S);
    const near = z < zp - 0.1;
    const a = near ? (z < 0.34 ? this._r(R.alphaNear[0], R.alphaNear[1]) : this._r(R.alphaFront[0], R.alphaFront[1])) : band ? R.alphaOnPerson : lerp(R.alphaFar[0], R.alphaFar[1], Math.pow(clamp(z / Z_FAR), 0.7));
    const y = anywhere ? this._r(-len, this.H) : -this._r(0, this.H * 0.25) - len * 0.2;
    this.drops.push({ x, y, z, v, len, w, a, band, near, glint: -9, ig: Infinity, h: this.rand() });
  }

  pulse(strength = 1) {
    if (this.state === 'bloom') return;
    const mx = this.mouth.x * this.W, my = this.mouth.y * this.H, lim = this.H * 0.55;
    for (const d of this.drops) { const dist = Math.hypot(d.x - mx, d.y - my); if (dist < lim) d.glint = this.time + dist / (1.4 * this.H) + this._r(0, 0.05); }
    this.glows.push({ x: mx, y: my, age: 0, life: 0.55, R: 0.16 * this.W, a: this.theme.mouthGlow.pulseAlpha * strength });
    this.onEvent('pulse', { x: this.mouth.x, y: this.mouth.y, strength });
  }

  trigger() {
    if (this.state === 'bloom') return false;
    this.state = 'bloom'; this.tau = 0;
    // a laugh with hardly any rain yet still needs something to ignite
    const need = Math.round(this.target * 0.6) - this.drops.length; for (let i = 0; i < need; i++) this._spawn(true);
    const mx = this.mouth.x * this.W, my = this.mouth.y * this.H;
    for (const d of this.drops) d.ig = 0.06 + Math.hypot(d.x - mx, d.y - my) / (0.85 * this.H) + this._r(0, 0.18) + (d.z > this.zp ? 0.04 : 0);
    this.glows.push({ x: mx, y: my, age: 0, life: 1.0, R: 0.32 * this.W, a: this.theme.mouthGlow.laughAlpha });
    // place each shell in the sky that is actually free above / beside this person
    const F = this.theme.fireworks, head = this._headTop();
    this.queue = F.plan.map(([dt, px, py, col, size, kind]) => {
      if (kind === 'cascade') {   // right above the head, in front of the person: its sparks land on them
        const y = Math.max(0.08 * this.H, head.y - 0.2 * this.H);
        return { t: dt, x: head.x, y, col: F.colors[col], size, kind, front: true };
      }
      if (px === 'main') {   // the big one: beside the head on its roomier side, opening partly behind the person
        const side = head.x < this.W / 2 ? 1 : -1;
        // the white-hot core sits in clear sky above the hair; only the lower rays pass behind the head
        const x = clamp(head.x + side * 0.14 * this.W, 0.3 * this.W, 0.7 * this.W);
        const y = clamp(Math.min(py * this.H, head.y - 0.07 * this.H), 0.12 * this.H, 0.32 * this.H);
        return { t: dt, x, y, col: F.colors[col], size, kind, front: false };
      }
      let x = px * this.W, top = this._top(x), y = py * this.H; const margin = 0.15 * this.H;
      if (top - margin < y) y = top - margin;
      if (y < 0.07 * this.H) { const alt = (1 - px) * this.W, t2 = this._top(alt); if (t2 - margin > y) { x = alt; y = Math.min(py * this.H, t2 - margin); } }
      y = Math.max(0.07 * this.H, y);
      const room = clamp((Math.min(top, this.H) - y) / (0.3 * this.H), 0.7, 1.1);
      return { t: dt, x, y, col: F.colors[col], size: size * room, kind, front: false };
    });
    this.onEvent('ignite', { x: this.mouth.x, y: this.mouth.y });
    return true;
  }

  _igniteDrop(d) {
    const E = this.theme.ember, Fl = this.theme.flare, S = this.S, zr = clamp(this.zp / d.z, 0.05, 3);
    this.flares.push({ x: d.x, y: d.y, z: d.z, age: 0, life: Fl.life * this._r(0.8, 1.2), r: clamp(Fl.size * zr, 1.5, 16) * S, v: (this.rand() * 3) | 0 });
    if (this.rand() > 0.35 + 0.65 * this.quality) return;   // fewer embers on slow devices
    this.embers.push({ x: d.x, y: d.y, z: d.z, vx: this._r(-25, 25) * S * zr, vy: -this._r(20, 90) * S * zr, age: 0, life: this._r(E.life[0], E.life[1]),
      col: E.colors[Math.floor(this.rand() * E.colors.length)], r: clamp(E.size * zr, 1.7, 26) * S, ph: this._r(0, 6.28), lift: this._r(80, 260) * S * zr });
  }
  _splash(x, y) {
    const S = this.S, n = 1 + Math.floor(this.rand() * 3);
    for (let k = 0; k < n; k++) this.splash.push({ x, y: y - 1, vx: this._r(-140, 140) * S, vy: -this._r(120, 320) * S, age: 0, life: this._r(0.18, 0.36), r: this._r(1.0, 2.0) * S, glint: false });
    if (this.rand() < 0.6) this.splash.push({ x, y: y - 1, vx: 0, vy: 0, age: 0, life: 0.12, r: this._r(2.2, 4) * S, glint: true });
  }
  _launch(s) {
    const S = this.S;
    const side = s.front ? (s.x < this.W / 2 ? 1 : -1) * 0.4 * this.W : 0;   // the cascade rises beside the person, never through the face
    this.rockets.push({ ...s, x0: s.x + side + this._r(-40, 40) * S, y0: this.H + 30 * S, age: 0, dur: s.front ? 0.6 : 0.8, cx: s.x, cy: this.H, tr: [] });
    this.onEvent('launch', { x: s.x / this.W, y: s.y / this.H });
  }
  _burst(r) {
    const F = this.theme.fireworks, S = this.S, { x, y, col, size, kind } = r, R = F.radius * this.W * size;
    if (kind === 'cascade') {   // golden rain that falls onto the person and bounces off
      const n = Math.round(150 * size * (0.4 + 0.6 * this.quality));
      for (let k = 0; k < n; k++) {
        const a = this._r(0, 6.283), s = this._r(0.2, 1) * 0.75 * R;
        this.debris.push({ x, y, px: x, py: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.5 - 90 * S, age: 0, life: this._r(2.6, 3.6), col: mix(col, F.colors.white, this._r(0, 0.4)), r: this._r(1.6, 2.8) * S, hits: 0, dep: this._r(0, 0.03) * this.H, e: this._r(0.3, 0.7), z: this._r(-0.7, 1) });
      }
      this.flashes.push({ x, y, col, age: 0, s: size * 0.8 });
      this.onEvent('burst', { x: x / this.W, y: y / this.H, size, kind });
      return;
    }
    const base = { grand: 330, brocade: 170, chrys: 150, peony: 120, willow: 200, ring: 100 }[kind] || 140;
    const dense = 1 + (((F.highTierDensity || {})[kind] || 1) - 1) * inv(0.75, 1, this.quality);
    const n = Math.round(base * (0.45 + 0.55 * this.quality) * dense);
    const grand = kind === 'grand', heavy = kind === 'willow' || kind === 'brocade';
    const drag = heavy ? 1.35 : grand ? 1.55 : 1.9, tilt = this._r(0.35, 0.8), rot = this._r(0, 3);
    const tl = Math.round((kind === 'willow' ? 26 : grand ? 18 : heavy ? 20 : kind === 'peony' ? 7 : 11) * (0.5 + 0.5 * this.quality));
    const fade = F.fade || col, share = (F.frontShare || {})[kind] || 0, nBack = Math.round(n * (1 - share));
    for (let k = 0; k < nBack; k++) {   // the rest of the shell (share) is spawned in front of the person, see _frontSparks
      let dx, dy;
      if (kind === 'ring') { const a = (k / n) * 6.283, px = Math.cos(a), py = Math.sin(a) * tilt; dx = px * Math.cos(rot) - py * Math.sin(rot); dy = px * Math.sin(rot) + py * Math.cos(rot); }
      else { const u = this._r(-1, 1), a = this._r(0, 6.283), rr = Math.sqrt(1 - u * u); dx = rr * Math.cos(a); dy = rr * Math.sin(a); }
      const s = R * drag * this._r(0.9, 1.04);
      this.stars.push({ x, y, vx: dx * s, vy: dy * s, drag, g: (heavy ? 160 : grand ? 120 : 100) * S, age: 0,
        life: kind === 'willow' ? this._r(3.2, 4.0) : heavy ? this._r(2.8, 3.8) : grand ? this._r(2.6, 3.3) : kind === 'peony' ? this._r(1.5, 2.1) : this._r(1.8, 2.5),
        col: kind === 'chrys' && this.rand() < 0.3 ? F.colors.white : col, fade: heavy || grand ? fade : null, tr: [], tl, w: (kind === 'peony' ? 3.0 : grand ? 2.8 : F.headSize) * S,
        dz: this._r(0.6, 1.45), glit: heavy || grand || kind === 'chrys', strobe: kind === 'chrys' && this.rand() < 0.4, k: this._r(0, 6.28) });
    }
    if (share) this._frontSparks(x, y, R, Math.round(n * share), col);
    if (grand && F.bloomGlow) this.glows.push({ x, y, age: 0, life: 1.8, R: 0.42 * this.W, a: F.bloomGlowAlpha, col: F.bloomGlow });
    if (grand) {   // white-hot pistil: a smaller, faster-fading inner sphere
      const m = Math.round(n * 0.3), pc = F.pistil || F.colors.white;
      for (let k = 0; k < m; k++) {
        const u = this._r(-1, 1), a = this._r(0, 6.283), rr = Math.sqrt(1 - u * u), s = R * 1.9 * 0.42 * this._r(0.85, 1.05);
        this.stars.push({ x, y, vx: rr * Math.cos(a) * s, vy: rr * Math.sin(a) * s, drag: 1.9, g: 80 * S, age: 0, life: this._r(1.1, 1.5),
          col: pc, fade: null, tr: [], tl: Math.max(4, Math.round(9 * this.quality)), w: 3.4 * S, glit: false, strobe: false, k: this._r(0, 6.28) });
      }
    }
    const puffs = this.quality > 0.6 ? 6 : 0;
    for (let k = 0; k < puffs; k++) this.smoke.push({ x: x + this._r(-0.5, 0.5) * R, y: y + this._r(-0.4, 0.5) * R, r: this._r(0.25, 0.55) * R, age: 0, life: this._r(5, 8), vx: this._r(-12, 22) * S, vy: this._r(-10, 6) * S });
    this.flashes.push({ x, y, col, age: 0, s: size });
    this.onEvent('burst', { x: x / this.W, y: y / this.H, size, kind });
  }

  // ---------- simulation ----------
  update(dt) {
    dt = Math.min(dt, 0.05); this.time += dt;
    const S = this.S, G = this.theme.grade;
    let gradeT = lerp(G.rainLevel * 0.6, G.rainLevel, this.rainLevel), want = smooth(inv(0.08, 0.4, this.mood));
    if (this.state === 'bloom') {
      this.tau += dt; const t = this.tau;
      this.ts = t < 1.1 ? lerp(1, 0.1, smooth(inv(0, 0.3, t))) : lerp(0.1, 1, smooth(inv(1.1, 1.6, t)));
      want = t < 0.3 ? 1 : t < 5.6 ? 0 : want * smooth(inv(5.6, 7.4, t));
      gradeT = t < 6.0 ? lerp(G.rainLevel, G.bloomLevel, smooth(inv(0, 0.6, t))) : lerp(G.bloomLevel, gradeT, smooth(inv(6.0, 7.6, t)));
      while (this.queue.length && this.queue[0].t - (this.queue[0].front ? 0.6 : 0.8) <= t) this._launch(this.queue.shift());
      if (t > SEQUENCE_LENGTH && this.rockets.length === 0) { this.state = 'rain'; this.queue = []; this.onEvent('done', {}); }
    } else this.ts = 1;
    this.rainLevel += (want - this.rainLevel) * Math.min(1, dt * (want > this.rainLevel ? 1.6 : this.state === 'bloom' ? 4 : 0.5));   // the sky clears quickly once the fireworks start
    this.gradeV += (gradeT - this.gradeV) * Math.min(1, dt * 4);

    // rain
    const goal = this.target * this.rainLevel;
    let budget = this.target * 5 * dt;
    while (this.drops.length < goal && budget-- > 0) this._spawn();
    const bloom = this.state === 'bloom';
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i], py = d.y;
      if (bloom && this.tau >= d.ig) { this._igniteDrop(d); drop(this.drops, i); continue; }
      d.y += d.v * dt * this.ts; d.x += d.v * dt * this.ts * (this.theme.rain.wind || 0);
      let gone = d.y - d.len > this.H;
      if (!gone && d.band) { const top = this._top(d.x); if (py < top && d.y >= top) { if (!bloom) this._splash(d.x, top); gone = true; } }
      if (!gone && !bloom && this.drops.length > goal * 1.05 && this.rand() < dt * 2) gone = true;   // rain easing off
      if (gone) drop(this.drops, i);
    }
    for (let i = this.splash.length - 1; i >= 0; i--) { const p = this.splash[i]; p.age += dt; if (p.age > p.life) { drop(this.splash, i); continue; } p.vy += 1600 * S * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    for (let i = this.flares.length - 1; i >= 0; i--) { this.flares[i].age += dt; if (this.flares[i].age > this.flares[i].life) drop(this.flares, i); }
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i]; e.age += dt; if (e.age > e.life) { drop(this.embers, i); continue; }
      e.vy -= e.lift * dt * smooth(inv(0.2, 1.2, e.age)); e.vx *= Math.exp(-1.0 * dt); e.vy *= Math.exp(-0.7 * dt);
      e.x += e.vx * dt + Math.sin(this.time * 2.6 + e.ph) * 10 * S * dt; e.y += e.vy * dt;
    }
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]; r.age += dt; const k = r.age / r.dur;
      if (k >= 1) { this._burst(r); drop(this.rockets, i); continue; }
      const e = 1 - Math.pow(1 - k, 2.2);
      r.cx = lerp(r.x0, r.x, e) + Math.sin(k * 11) * 2 * S; r.cy = lerp(r.y0, r.y, e);
      r.tr.push(r.cx, r.cy); if (r.tr.length > 26) r.tr.splice(0, 2);
    }
    const late = bloom && this.tau > 5.3;
    for (let i = this.stars.length - 1; i >= 0; i--) {
      const p = this.stars[i]; p.age += dt;
      if (p.age > p.life) { if (late && this.rand() < 0.3 && this.drops.length < this.target) this._spawn(); drop(this.stars, i); continue; }
      const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy = p.vy * k + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.tr.push(p.x, p.y); if (p.tr.length > p.tl * 2) p.tr.splice(0, 2);
    }
    this._debris(dt);
    this._lensUpdate(dt);
    for (let i = this.smoke.length - 1; i >= 0; i--) { const m = this.smoke[i]; m.age += dt; if (m.age > m.life) { drop(this.smoke, i); continue; } m.x += m.vx * dt; m.y += m.vy * dt; m.r += 6 * S * dt; }
    for (let i = this.flashes.length - 1; i >= 0; i--) { this.flashes[i].age += dt; if (this.flashes[i].age > 1.4) drop(this.flashes, i); }
    for (let i = this.glows.length - 1; i >= 0; i--) { this.glows[i].age += dt; if (this.glows[i].age > this.glows[i].life) drop(this.glows, i); }
  }

  /** Part of a big shell bursts on the near side of the person: those sparks fall with full physics and
   *  bounce off the head and shoulders (same collider as the cascade). */
  _frontSparks(x, y, R, m, col) {
    const S = this.S, F = this.theme.fireworks;
    for (let k = 0; k < m; k++) {
      const a = this._r(0, 6.283), s = this._r(0.35, 1) * 0.95 * R;
      this.debris.push({ x, y, px: x, py: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6 - 40 * S, age: 0, life: this._r(2.4, 3.4),
        col: mix(col, F.colors.white, this._r(0, 0.35)), r: this._r(1.8, 3.0) * S, hits: 0, wht: this.rand() < 0.25, dep: this._r(0, 0.03) * this.H, e: this._r(0.3, 0.7), z: this._r(-0.5, 1) });
    }
  }

  // golden cascade sparks: gravity, air drag, and collisions with the person's outline (which can move)
  _headBox() { const f = this.face; return f ? { cx: f.cx, cy: f.cy - f.ry * 0.35, a: f.rx * 1.35, b: f.ry * 1.7 } : null; }
  _overHead(x) { const h = this._headBox(); return !!h && Math.abs(x - h.cx) < h.a; }
  _head3d(x, z) {
    const h = this._headBox(); if (!h) return null;
    const s2 = 1 - z * z; if (s2 <= 0.04) return null;
    const s = Math.sqrt(s2), a = h.a * s, b = h.b * s, dx = x - h.cx;
    if (Math.abs(dx) >= a) return null;
    const top = h.cy - b * Math.sqrt(1 - (dx / a) ** 2);
    let nx = dx / (a * a), ny = (top - h.cy) / (b * b); const l = Math.hypot(nx, ny) || 1;
    return { top, nx: nx / l, ny: ny / l };
  }

  _debris(dt) {
    const S = this.S, g = 900 * S, e = 0.45, mu = 0.12;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const p = this.debris[i]; p.age += dt;
      if (p.age > p.life || p.y > this.H + 20 || p.x < -40 || p.x > this.W + 40) { drop(this.debris, i); continue; }
      p.px = p.x; p.py = p.y;
      const k = Math.exp(-0.9 * dt); p.vx *= k; p.vy = p.vy * k + g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      // 3D contact: each spark has a depth z (-1 back … +1 front, in head radii). The head is an ellipsoid built
      // from the face box; a spark at depth z meets the head's cross-section at that depth, so front sparks land
      // on the near side of the hair (inside the silhouette), sparks at the sides miss it, back ones hit the hidden
      // back of the head. Outside the head's width the person outline (shoulders) is used, for sparks not behind.
      const hd = this._head3d(p.x, p.z ?? 0.5);
      let top = Infinity, nx = 0, ny = -1;
      if (hd) { top = hd.top; nx = hd.nx; ny = hd.ny; }
      else if (!this._overHead(p.x) && (p.z ?? 0.5) > -0.3) {
        top = this._top(p.x) + (p.dep ?? 0);
        const h = 6 * S, slope = (this._top(p.x + h) - this._top(p.x - h)) / (2 * h);
        nx = slope; ny = -1; const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
        if (!Number.isFinite(nx)) { nx = 0; ny = -1; }
      }
      if (top !== Infinity && p.y >= top - 0.5) {
        const sv = { x: this.faceV.x * 0.6, y: Math.min(0, this._topVel(p.x)) };       // a rising head pushes sparks up
        const rvx = p.vx - sv.x, rvy = p.vy - sv.y, vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const tx = rvx - vn * nx, ty = rvy - vn * ny;
          const ei = p.e ?? e;   // hair is uneven: every spark bounces a little differently
          p.vx = sv.x + tx * (1 - mu) - ei * vn * nx + this._r(-1, 1) * 140 * S; p.vy = sv.y + ty * (1 - mu) - ei * vn * ny;
          if (!p.hits) p.life = Math.min(p.life, p.age + this._r(0.5, 1.1));   // a landed spark burns out soon after
          if (-vn > 180 * S && p.hits < 3 && this.splash.length < 400) this.splash.push({ x: p.x, y: top - 1, vx: 0, vy: 0, age: 0, life: 0.1, r: 2.6 * S, glint: true, warm: true });
          p.hits++;
        }
        p.y = top - 0.5;
      }
    }
  }

  // ---------- drawing ----------
  _sprite(kind, col) {   // pre-rendered textures, tinted per colour, cached
    const key = kind + col.join(',');
    let c = this._sprites.get(key); if (c) return c;
    c = document.createElement('canvas'); const x = c.getContext('2d');
    if (kind === 'streak') { c.width = 8; c.height = 128; const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, rgba(col, 0)); g.addColorStop(1, rgba(col, 1)); x.fillStyle = g; x.fillRect(2, 0, 4, 128); }
    else if (kind.startsWith('floret')) {   // tiny golden flower a raindrop opens into: rays + beads + hot centre
      const F = this.theme.flare, n = F.rays || 6, rot = Number(kind.slice(6)) * 0.37; c.width = c.height = 64;
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 30); g.addColorStop(0, rgba(F.core, 0.9)); g.addColorStop(0.18, rgba(col, 0.45)); g.addColorStop(1, rgba(col, 0));
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      x.strokeStyle = rgba(col, 0.95); x.lineWidth = 2.2; x.lineCap = 'round'; x.fillStyle = rgba(F.core, 1);
      for (let k = 0; k < n; k++) {
        const a = rot + (k / n) * 6.283, ca = Math.cos(a), sa = Math.sin(a);
        x.beginPath(); x.moveTo(32 + ca * 6, 32 + sa * 6); x.lineTo(32 + ca * 22, 32 + sa * 22); x.stroke();
        x.beginPath(); x.arc(32 + ca * 26, 32 + sa * 26, 2.6, 0, 6.283); x.fill();
      }
    }
    else { c.width = c.height = 64; const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      if (kind === 'glow') { g.addColorStop(0, rgba(col, 1)); g.addColorStop(0.25, rgba(col, 0.5)); g.addColorStop(1, rgba(col, 0)); }
      else if (kind === 'disc') { g.addColorStop(0, rgba(col, 0.5)); g.addColorStop(0.75, rgba(col, 0.38)); g.addColorStop(1, rgba(col, 0)); }
      else { g.addColorStop(0, rgba(col, 1)); g.addColorStop(1, rgba(col, 0)); }
      x.fillStyle = g; x.fillRect(0, 0, 64, 64); }
    this._sprites.set(key, c); return c;
  }

  /** Dusk grade for the camera image (tint + darker sky + vignette) in ONE full-screen multiply pass.
   *  The overlay is pre-rendered at quarter resolution for 16 grade levels and reused. */
  drawGrade(ctx) {
    const G = this.theme.grade;
    let flash = 0;   // each burst briefly lifts the darkening: the whole scene (and the person) lights up, at zero extra cost
    for (const f of this.flashes) flash += (f.age < 0.06 ? f.age / 0.06 : Math.pow(1 - f.age / 1.4, 2.4)) * Math.min(1.2, f.s) * this.theme.fireworks.flashAlpha * 2.2;
    const lvl = Math.round(clamp(this.gradeV - Math.min(0.45, flash)) * 15);
    if (!this._grade || this._grade.W !== this.W) this._grade = { W: this.W, cache: [] };
    let c = this._grade.cache[lvl];
    if (!c) {
      const g = lvl / 15, w = Math.ceil(this.W / 4), h = Math.ceil(this.H / 4);
      c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      x.fillStyle = `rgb(${Math.round(255 - G.tint[0] * g)},${Math.round(255 - G.tint[1] * g)},${Math.round(255 - G.tint[2] * g)})`; x.fillRect(0, 0, w, h);
      x.globalCompositeOperation = 'multiply';
      const sky = x.createLinearGradient(0, 0, 0, h * 0.75);
      sky.addColorStop(0, `rgb(${Math.round(255 - G.skyTint[0] * g)},${Math.round(255 - G.skyTint[1] * g)},${Math.round(255 - G.skyTint[2] * g)})`); sky.addColorStop(1, '#fff');
      x.fillStyle = sky; x.fillRect(0, 0, w, h * 0.75);
      const va = G.vignetteAlpha[0] + G.vignetteAlpha[1] * g, vc = G.vignette.map((v) => Math.round(255 - (255 - v) * va));
      const v = x.createRadialGradient(w / 2, h * 0.5, h * 0.3, w / 2, h * 0.5, h * 0.82);
      v.addColorStop(0, '#fff'); v.addColorStop(1, `rgb(${vc[0]},${vc[1]},${vc[2]})`); x.fillStyle = v; x.fillRect(0, 0, w, h);
      this._grade.cache[lvl] = c;
    }
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(c, 0, 0, this.W, this.H); ctx.restore();
  }

  draw(ctx) {
    const W = this.W, H = this.H, S = this.S, T = this.theme;
    ctx.save();
    // ---- behind the person: occlusion is analytic (each point / segment tested against the outline),
    //      which is far cheaper on phones than a canvas clip path ----
    for (const m of this.smoke) {
      if (this._hidden(m.x, m.y)) continue;
      const al = T.fireworks.smokeAlpha * Math.sin(Math.min(1, m.age / 0.8) * Math.PI / 2) * (1 - m.age / m.life);
      ctx.globalAlpha = al; ctx.drawImage(this._sprite('soft', T.fireworks.smoke), m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
    }
    ctx.globalAlpha = 1;
    this._drawRain(ctx, false);
    ctx.globalCompositeOperation = 'lighter';
    this._drawEmbers(ctx, false); this._drawFlares(ctx, false);
    for (const r of this.rockets) if (!r.front && !this._hidden(r.cx, r.cy)) this._drawRocket(ctx, r);
    this._drawStars(ctx);
    ctx.restore();

    // ---- in front of the person ----
    this._drawRain(ctx, true);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rockets) if (r.front) this._drawRocket(ctx, r);
    this._drawEmbers(ctx, true); this._drawFlares(ctx, true);
    this._drawDebris(ctx);
    this._drawGlow(ctx);
    for (const p of this.splash) {
      const f = 1 - p.age / p.life;
      if (p.glint) { ctx.globalAlpha = (p.warm ? 0.9 : T.splash.glintAlpha) * f; const s = p.r * 6; ctx.drawImage(this._sprite('glow', p.warm ? T.fireworks.colors.gold : T.splash.color), p.x - s / 2, p.y - s / 2, s, s); ctx.globalAlpha = 1; }
      else { ctx.strokeStyle = rgba(T.splash.color, T.splash.alpha * f); ctx.lineWidth = p.r * 0.8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    }
    for (const gl of this.glows) {
      if (!gl.a) continue;
      const k = gl.age / gl.life, al = gl.a * (k < 0.15 ? k / 0.15 : Math.pow(1 - (k - 0.15) / 0.85, 1.6));
      ctx.globalAlpha = al; ctx.drawImage(this._sprite('glow', gl.col || T.mouthGlow.color), gl.x - gl.R, gl.y - gl.R, gl.R * 2, gl.R * 2);
    }
    // burst light on the scene and the person: only the two freshest flashes, smaller on slow devices
    // burst light: the scene-wide part is folded into the grade (see flashLevel); here only a local glow
    if (this.quality > 0.6) for (const f of this.flashes) {
      const k = f.age / 1.4, al = (f.age < 0.06 ? f.age / 0.06 : Math.pow(1 - k, 2.4)) * T.fireworks.flashAlpha * Math.min(1.2, f.s);
      const R = W * 0.38 * Math.min(1.15, f.s); ctx.globalAlpha = al; ctx.drawImage(this._sprite('soft', f.col), f.x - R, f.y - R, R * 2, R * 2);
    }
    ctx.restore();
    this._drawLens(ctx);
  }

  _hidden(x, y) { return y > this._top(x) + 2 * this.S; }
  /** Behind-the-person test with a soft edge: within a band above the outline a point disappears with a
   *  probability that grows toward the outline (h = stable 0..1 hash per point), so far sparks dissolve
   *  into the person instead of being cut along a hard line (which reads as a cut-out mask). */
  _behind(x, y, h) {
    const t = this._top(x); if (t === Infinity) return false;
    // hair is not a clean curve: a wavy, slowly drifting edge plus a per-point dissolve (h^0.7 pushes more points deep)
    const wob = (Math.sin(x * 0.045 / this.S + this.time * 1.3) + Math.sin(x * 0.11 / this.S - this.time * 0.7) * 0.6) * 9 * this.S;
    return y > t + wob - this.theme.fireworks.behindFade * this.H * Math.pow(h, 0.7);
  }

  _drawRocket(ctx, r) {
    const S = this.S, tr = r.tr; if (tr.length < 4) return;
    // Trail is capped by on-screen length (not frame count) so it stays a short comet at any fps,
    // and it is never drawn over the person: rockets rise behind the body and appear above it.
    ctx.lineCap = 'round'; ctx.lineWidth = 2.4 * S;
    const maxLen = 0.12 * this.H; let len = 0;
    for (let j = tr.length - 2; j >= 2; j -= 2) {
      const x0 = tr[j - 2], y0 = tr[j - 1], x1 = tr[j], y1 = tr[j + 1];
      len += Math.hypot(x1 - x0, y1 - y0); if (len > maxLen) break;
      if (this._hidden(x1, y1)) continue;
      ctx.strokeStyle = `rgba(255,215,160,${(1 - len / maxLen) * 0.8})`; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    if (this._hidden(r.cx, r.cy)) return;
    const s = 14 * S; ctx.drawImage(this._sprite('glow', [255, 236, 205]), r.cx - s / 2, r.cy - s / 2, s, s);
  }

  _drawRain(c, front) {
    const R = this.theme.rain, S = this.S, slow = 1 - this.ts;
    const dim = this.state === 'bloom' ? 1 - (this.theme.rain.bloomDim || 0) * smooth(inv(0.2, 0.8, this.tau)) * (1 - smooth(inv(5.4, 7.2, this.tau))) : 1;   // rain steps back while fireworks play
    const thin = new Map(), halo = [], wd = R.wind || 0, M = c.getTransform();
    const streak = this._sprite('streak', R.color), glintS = this._sprite('streak', R.glint);
    for (const d of this.drops) {
      if (d.near !== front) continue;
      const len = Math.max(d.w * 2, d.len * (1 - slow * 0.85));
      const gl = this.time - d.glint, glint = gl > 0 && gl < 0.22 ? 1 - gl / 0.22 : 0;
      if (front) { c.globalAlpha = d.a * dim; c.setTransform(M); c.transform(1, 0, wd, 1, -wd * d.y, 0); c.drawImage(streak, d.x - d.w * 1.2, d.y - len, d.w * 2.4, len); continue; }
      const tp = this._top(d.x), bottom = Math.min(d.y, d.band ? tp : tp - this.theme.fireworks.behindFade * this.H * d.h * 0.6), top = d.y - len;   // far rain fades out at varied heights above the person, no hard line   // the part behind the person is not drawn
      if (bottom <= top) continue;
      const xt = d.x - wd * (d.y - top), xb = d.x - wd * (d.y - bottom);
      if (d.z < 3 && !d.band) halo.push(xt, top, xb, bottom);
      if (!glint && d.w < 1.4 * S) { const k = Math.round(d.a * dim * 12); let arr = thin.get(k); if (!arr) thin.set(k, (arr = [])); arr.push(xt, top, xb, bottom); continue; }
      c.globalAlpha = Math.min(1, d.a + glint * 0.5) * dim;
      const w = d.w * (1 + glint * 0.8) * 1.6, sh = (bottom - top) / len;
      c.setTransform(M); c.transform(1, 0, wd, 1, -wd * bottom, 0); c.drawImage(glint ? glintS : streak, 0, 0, 8, 128 * sh, xb - w / 2, top, w, bottom - top);
    }
    c.setTransform(M); c.globalAlpha = 1; c.lineCap = 'round';
    if (halo.length) {
      c.strokeStyle = `rgba(8,12,26,${R.darkHalo})`; c.lineWidth = 2.2 * S; c.beginPath();
      for (let i = 0; i < halo.length; i += 4) { c.moveTo(halo[i] + 1.2 * S, halo[i + 1]); c.lineTo(halo[i + 2] + 1.2 * S, halo[i + 3]); }
      c.stroke();
    }
    for (const [k, arr] of thin) {
      c.strokeStyle = rgba(R.color, k / 12); c.lineWidth = 1 * S; c.beginPath();
      for (let i = 0; i < arr.length; i += 4) { c.moveTo(arr[i], arr[i + 1]); c.lineTo(arr[i + 2], arr[i + 3]); }
      c.stroke();
    }
  }

  _drawStars(L) {
    const F = this.theme.fireworks, S = this.S, white = F.colors.white;
    const beads = F.beads && this.quality >= 0.45, bs = (F.beadSize || 2.4) * S;
    const buckets = new Map();
    for (const p of this.stars) {
      const f = 1 - p.age / p.life;
      let al = Math.pow(f, 1.1); if (p.strobe && p.age > 0.9) al *= Math.sin(this.time * 40 + p.k) > 0.2 ? 1 : 0.1;
      // white-hot at birth → its own colour → cools to ember red at the end (quantised so draws stay batched)
      let c = p.age < 0.25 ? mix(white, p.col, Math.round((p.age / 0.25) * 3) / 3) : p.col;
      if (p.fade && f < 0.45) c = mix(p.col, p.fade, Math.round(((0.45 - f) / 0.45) * 3) / 3);
      const key = `${c[0] | 0},${c[1] | 0},${c[2] | 0}|${Math.min(4, Math.floor(al * 5))}`;
      let arr = buckets.get(key); if (!arr) buckets.set(key, (arr = [])); arr.push(p);
    }
    for (const [key, arr] of buckets) {
      const [cs, ab] = key.split('|'), col = cs.split(',').map(Number), al = (Number(ab) + 0.5) / 5;
      L.beginPath();
      for (const p of arr) {
        const t = p.tr; if (t.length < 4) continue; let pen = false;
        const step = this.quality > 0.7 ? 2 : 4;
        for (let j = 0; j < t.length; j += step) { if (this._behind(t[j], t[j + 1], frac(p.k + j * 0.618))) { pen = false; continue; } if (pen) L.lineTo(t[j], t[j + 1]); else { L.moveTo(t[j], t[j + 1]); pen = true; } }
      }
      if (this.quality > 0.85) { L.strokeStyle = rgba(col, al * 0.14); L.lineWidth = F.trailGlowWidth * S; L.stroke(); }
      L.strokeStyle = rgba(col, al * (beads ? 0.3 : 0.55)); L.lineWidth = F.trailWidth * S; L.stroke();
      if (beads) {   // dotted trail: one bead per sampled position; fast stars leave sparse beads, slow ones dense
        const step = this.quality > 0.7 ? 2 : 4;
        for (let half = 0; half < (this.quality >= 0.6 ? 2 : 1); half++) {   // newer half bright and full size, older half dimmer and smaller (high tiers only)
          const r = bs * (half ? 0.32 : 0.5);
          L.fillStyle = rgba(col, Math.min(1, al * (half ? 0.45 : 0.95))); L.beginPath();
          for (const p of arr) {
            const t = p.tr, n = t.length, mid = (n >> 2) << 1; if (n < 6) continue;
            for (let j = half ? 0 : mid; j < (half ? mid : n - 2); j += step) { const hb = frac(p.k + j * 0.618); if (frac(hb * 5.3 + this.time * 2.2) < 0.22) continue;   // beads twinkle
              if (!this._behind(t[j], t[j + 1], hb)) { const rb = r * (p.dz || 1); L.rect(t[j] - rb, t[j + 1] - rb, rb * 2, rb * 2); } }
          }
          L.fill();
        }
      }
      L.fillStyle = rgba(col, Math.min(1, al * 1.3)); L.beginPath();
      for (const p of arr) { if (this._behind(p.x, p.y, frac(p.k * 7.31))) continue; const rr = p.w * (p.dz || 1) * (p.age < 0.12 ? 1.3 : 1); L.rect(p.x - rr * 0.9, p.y - rr * 0.9, rr * 1.8, rr * 1.8); }
      L.fill();
    }
    if (F.headGlow && this.quality > 0.6) {   // soft bloom around young star heads only
      const gs = this._sprite('glow', F.colors.gold), ws = this._sprite('glow', white);
      for (const p of this.stars) {
        if (p.age > 0.7 || this._behind(p.x, p.y, frac(p.k * 7.31))) continue;
        const s = p.w * F.headGlow * 2; L.globalAlpha = 0.45 * smooth(p.age / 0.18) * (1 - p.age / 0.7);   // fades in so a fresh burst never saturates into a white disc
        L.drawImage(p.col === F.colors.gold ? gs : ws, p.x - s / 2, p.y - s / 2, s, s);
      }
      L.globalAlpha = 1;
    }
    if (this.glitter) {
      L.fillStyle = 'rgba(255,250,235,0.9)';
      for (const p of this.stars) if (p.glit && p.tr.length > 6 && this.rand() < 0.3) { const j = 2 * Math.floor(this.rand() * (p.tr.length / 2)); if (!this._behind(p.tr[j], p.tr[j + 1], frac(p.k + j * 0.618))) L.fillRect(p.tr[j] - S, p.tr[j + 1] - S, 2 * S, 2 * S); }
    }
  }

  /** Cheap bloom: star heads and front sparks drawn as big soft dots into a quarter-resolution buffer,
   *  then stretched over the frame additively; the upscale itself blurs it into a halo. Mid/high tiers only. */
  _drawGlow(ctx) {
    const F = this.theme.fireworks; if (!F.glowAlpha || this.quality < 0.6 || (!this.stars.length && !this.debris.length)) return;
    const k = 0.125, w = Math.ceil(this.W * k), h = Math.ceil(this.H * k);
    if (!this._gl || this._gl.width !== w || this._gl.height !== h) { this._gl = document.createElement('canvas'); this._gl.width = w; this._gl.height = h; this._glx = this._gl.getContext('2d'); }
    const g = this._glx; g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h); g.globalCompositeOperation = 'lighter';
    for (const [col, list] of [[F.colors.gold, 0], [F.colors.white, 1]]) {
      g.fillStyle = rgba(col, 0.55); g.beginPath();
      for (const p of this.stars) {
        if ((p.col === F.colors.white || p.col === F.pistil) !== !!list || this._behind(p.x, p.y, frac(p.k * 7.31))) continue;
        const f = 1 - p.age / p.life; if (f < 0.15 || p.age < 0.2) continue; const r = Math.max(1, p.w * (p.dz || 1) * 3.2 * k * f);   // fresh bursts skip the glow: no white disc
        g.rect(p.x * k - r, p.y * k - r, r * 2, r * 2);
      }
      if (!list) for (const p of this.debris) { if (p.hid) continue; const r = Math.max(1, p.r * 3.2 * k); g.rect(p.x * k - r, p.y * k - r, r * 2, r * 2); }
      g.fill();
    }
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = F.glowAlpha; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._gl, 0, 0, this.W, this.H); ctx.restore();
  }

  _drawDebris(c) {   // sparks in front of the person: streaks batched by brightness, then a glow per spark
    if (!this.debris.length) return;
    const F = this.theme.fireworks, S = this.S, L = 4, paths = [];
    for (let i = 0; i < L; i++) paths.push([]);
    for (const p of this.debris) {
      p.hid = (p.z ?? 0.5) < 0 && this._hidden(p.x, p.y);   // behind the head / body: covered by the person
      if (p.hid) continue;
      const f = 1 - p.age / p.life; p.a = Math.min(1, f * 1.4) * (0.7 + 0.3 * Math.sin(this.time * 25 + p.x));
      paths[Math.min(L - 1, Math.floor(p.a * L))].push(p);
    }
    c.lineCap = 'round'; c.lineWidth = 2.2 * S;
    for (let i = 0; i < L; i++) {
      const arr = paths[i]; if (!arr.length) continue;
      c.strokeStyle = rgba(F.colors.gold, ((i + 0.5) / L) * 0.6); c.beginPath();
      for (const p of arr) { c.moveTo(p.px - (p.x - p.px) * 2, p.py - (p.y - p.py) * 2); c.lineTo(p.x, p.y); }
      c.stroke();
    }
    const gs = this._sprite('glow', F.colors.gold), ws = this._sprite('glow', F.colors.white);
    for (const p of this.debris) { if (p.hid) continue; c.globalAlpha = p.a; const s = p.r * (4 + 1.6 * (p.z ?? 0.5)); c.drawImage(p.wht ? ws : gs, p.x - s / 2, p.y - s / 2, s, s); }
    c.globalAlpha = 1;
  }

  _drawEmbers(c, front) {
    const E = this.theme.ember;
    for (const e of this.embers) {
      if ((e.z < this.zp) !== front || (!front && this._behind(e.x, e.y, frac(e.ph * 3.7)))) continue;
      const f = 1 - e.age / e.life, tw = 0.6 + 0.4 * Math.sin(this.time * 12 + e.ph * 3), al = Math.min(1, e.age / 0.12) * f * tw * this._skyFade(e.y);
      if (e.r > 7 * this.S) { c.globalAlpha = al; c.drawImage(this._sprite('disc', e.col), e.x - e.r, e.y - e.r, e.r * 2, e.r * 2); continue; }
      const s = e.r * E.halo * 2; c.globalAlpha = al; c.drawImage(this._sprite('glow', e.col), e.x - s / 2, e.y - s / 2, s, s);
    }
    c.globalAlpha = 1;
  }
  /** Ignition sparkles live in the sky: full strength high up, gone by the lower part of the frame (no glitter on the face or chest). */
  // ---- water on the lens: a handful of drops that stick, then slide down leaving a faint trail ----
  _lensUpdate(dt) {
    const L = this.theme.lens; if (!L || !L.max) return;
    if (!this.lens) this.lens = [];
    const S = this.S, wet = this.state === 'bloom' ? 0 : this.rainLevel, cap = Math.round(L.max * (0.4 + 0.6 * this.quality));
    if (this.lens.length < cap && this.rand() < dt * L.rate * wet) {
      this.lens.push({ x: this._r(0.04, 0.96) * this.W, y: this._r(0.02, 0.7) * this.H, y0: 0, r: this._r(L.size[0], L.size[1]) * S, age: 0, stick: this._r(0.6, 2.4), v: 0, ph: this._r(0, 6.28), out: 0 });
      const d = this.lens[this.lens.length - 1]; d.y0 = d.y;
    }
    for (let i = this.lens.length - 1; i >= 0; i--) {
      const d = this.lens[i]; d.age += dt;
      if (d.age > d.stick) { d.v = Math.min(d.v + 260 * S * dt, (90 + d.r * 6) * S); d.y += d.v * dt; d.x += Math.sin(d.age * 3 + d.ph) * 6 * S * dt; }
      if (wet < 0.05 || this.state === 'bloom') d.out += dt;   // dries off when the rain stops or the fireworks start
      if (d.y - d.r > this.H || d.out > 1) drop(this.lens, i);
    }
  }
  _drawLens(c) {
    if (!this.lens || !this.lens.length) return;
    const sp = this._lensSprite();
    c.save(); c.lineCap = 'round';
    for (const d of this.lens) {
      const a = Math.min(1, d.age / 0.25) * (1 - d.out);
      if (d.y - d.y0 > d.r) {   // trail: thin wet streak above the moving drop
        c.globalAlpha = a * 0.5; c.strokeStyle = 'rgba(210,225,245,0.18)'; c.lineWidth = d.r * 0.5;
        c.beginPath(); c.moveTo(d.x, d.y0); c.lineTo(d.x, d.y - d.r * 0.6); c.stroke();
      }
      c.globalAlpha = a; c.drawImage(sp, d.x - d.r, d.y - d.r * 1.1, d.r * 2, d.r * 2.2);
    }
    c.restore();
  }
  _lensSprite() {   // drop on glass: clear body, darker rim, bright highlight (rendered once)
    if (this._lensSp) return this._lensSp;
    const c = document.createElement('canvas'); c.width = 64; c.height = 70; const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 38, 4, 32, 36, 30);
    g.addColorStop(0, 'rgba(235,242,255,0.10)'); g.addColorStop(0.7, 'rgba(200,215,235,0.12)'); g.addColorStop(0.88, 'rgba(10,16,30,0.32)'); g.addColorStop(1, 'rgba(10,16,30,0)');
    x.fillStyle = g; x.beginPath(); x.ellipse(32, 36, 30, 33, 0, 0, 6.283); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.75)'; x.beginPath(); x.ellipse(23, 24, 6, 4, -0.6, 0, 6.283); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.beginPath(); x.ellipse(40, 52, 7, 2.5, 0.3, 0, 6.283); x.fill();
    return (this._lensSp = c);
  }

  _skyFade(y) { const E = this.theme.ember; return 1 - smooth(inv(E.skyFade[0] * this.H, E.skyFade[1] * this.H, y)); }

  _drawFlares(c, front) {
    const F = this.theme.flare;
    for (const fl of this.flares) {
      if ((fl.z < this.zp) !== front || (!front && this._hidden(fl.x, fl.y))) continue;
      // opens fast, then fades while the rays drift outward a little
      const k = fl.age / fl.life, r = fl.r * (0.6 + 1.6 * Math.sqrt(k)) * 2.5;
      const sf = this._skyFade(fl.y); if (sf < 0.02) continue;
      c.globalAlpha = Math.min(1, k * 8) * Math.pow(1 - k, 1.4) * sf; c.drawImage(this._sprite('floret' + (fl.v || 0), F.mid), fl.x - r, fl.y - r, r * 2, r * 2);
    }
    c.globalAlpha = 1;
  }
}
