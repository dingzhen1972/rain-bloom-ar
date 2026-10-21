// Device tiers + a runtime governor that keeps the frame rate up.
// The tier decides the canvas size, how often the face/person models run, and particle budgets.
// The governor watches real frame times and steps quality down (fast) or back up (slowly, with hysteresis).

export const TIERS = {
  high: { name: 'high', res: 1080, detectHz: 30, segEvery: 2, quality: 1.0, glitter: true, fpsCap: 60 },
  mid:  { name: 'mid',  res: 720,  detectHz: 24, segEvery: 3, quality: 0.75, glitter: true, fpsCap: 60 },
  low:  { name: 'low',  res: 540,  detectHz: 15, segEvery: 4, quality: 0.5, glitter: false, fpsCap: 30 },
};

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  } catch (_) { return 'unknown'; }
}

/** Pick a starting tier from what the device tells us. `?tier=high|mid|low` overrides. */
export function detectTier(override) {
  if (override && TIERS[override]) return { ...TIERS[override], reason: 'override' };
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;                       // not exposed on iOS / Firefox → assume 4
  const mobile = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
  const gpu = gpuName();
  const weakGpu = /Mali-(4|T6|T7|G5[12])|Adreno \(TM\) [345]\d\d|PowerVR|SwiftShader|llvmpipe|none/i.test(gpu);
  let t;
  if (weakGpu || mem <= 2 || cores <= 2) t = 'low';
  else if (mobile) t = mem >= 6 && cores >= 8 ? 'mid' : (cores <= 4 ? 'low' : 'mid');
  else t = cores >= 6 ? 'high' : 'mid';
  // phones: even good ones draw at 540 px (the screen is small, the GPU is shared with the camera and the model)
  if (mobile && t === 'mid') return { ...TIERS.mid, res: 540, detectHz: 20, reason: `phone, cores ${cores}, mem ${mem}GB, gpu ${gpu}` };
  return { ...TIERS[t], reason: `cores ${cores}, mem ${mem}GB, ${mobile ? 'mobile' : 'desktop'}, gpu ${gpu}` };
}

/** Adaptive quality: call frame(dt) every frame; it returns the quality scalar (0.3 … tier quality). */
export class Governor {
  constructor(tier, onChange = () => {}) {
    this.tier = tier; this.q = tier.quality; this.onChange = onChange;
    this.ema = 1 / 60; this.slow = 0; this.fast = 0; this.cool = 0;
    this.budget = 1 / Math.min(tier.fpsCap, 60) * 1.45;   // tolerate ~45 fps on a 60 fps cap, ~20 fps on a 30 fps cap
  }
  frame(dt) {
    if (dt <= 0 || dt > 0.5) return this.q;                // tab switch / breakpoint: ignore
    this.ema += (dt - this.ema) * 0.08; this.cool -= dt;
    if (this.ema > this.budget) { this.slow += dt; this.fast = 0; } else { this.slow = Math.max(0, this.slow - dt * 0.5); }
    if (this.ema < this.budget * 0.6) this.fast += dt; else this.fast = 0;
    if (this.slow > 1.0 && this.q > 0.3 && this.cool <= 0) { this.set(this.q - 0.15); this.slow = 0; this.cool = 1.0; }
    else if (this.fast > 6 && this.q < this.tier.quality && this.cool <= 0) { this.set(this.q + 0.1); this.fast = 0; this.cool = 4; }
    return this.q;
  }
  set(q) { this.q = Math.max(0.3, Math.min(this.tier.quality, +q.toFixed(2))); this.onChange(this.q); }
  get fps() { return 1 / this.ema; }
}
