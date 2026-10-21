// Procedural sound for the effect (no audio files). Must be started from a user gesture.
export class Sfx {
  constructor() { this.ctx = null; this.on = false; }

  async start() {
    if (this.ctx) { await this.ctx.resume(); this.on = true; return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = (this.ctx = new AC());
    this.master = c.createGain(); this.master.gain.value = 0.9;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
    this.master.connect(comp); comp.connect(c.destination);
    this.dest = c.createMediaStreamDestination(); comp.connect(this.dest);
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // rain bed: a real recording if assets/rain.mp3 exists (loaded after Start, never blocks loading); otherwise silence
    this.rainGain = c.createGain(); this.rainGain.gain.value = 0.0; this.rainGain.connect(this.master);
    fetch(new URL('./assets/rain.mp3', document.baseURI)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && c.decodeAudioData(b)).then((ab) => {
      if (!ab) return; const s = c.createBufferSource(); s.buffer = ab; s.loop = true; s.connect(this.rainGain); s.start();
    }).catch(() => {});
    this.on = true;
    this.setRain(0.6);
  }
  stop() { if (this.ctx) this.ctx.suspend(); this.on = false; }
  /** app in the background: silence everything; back in front: resume (only if it was on) */
  pause() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.on) this.ctx.resume(); }
  get stream() { return this.dest ? this.dest.stream : null; }

  setRain(level) { if (this.rainGain) this.rainGain.gain.setTargetAtTime(0.5 * level, this.ctx.currentTime, 0.4); }

  _noise(t, dur, type, f, q, gain, attack = 0.003, pan = 0) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noise; s.playbackRate.value = 0.7 + Math.random() * 0.6;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = g; if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p); out = p; }
    s.connect(fl); fl.connect(g); out.connect(this.master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
    return fl;
  }
  _tone(t, f, dur, gain) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  _crackle(t, dur, n, pan = 0) { for (let i = 0; i < n; i++) this._noise(t + Math.random() * dur * Math.random(), 0.015, 'highpass', 3500, 0.7, 0.06 + Math.random() * 0.12, 0.0005, pan + (Math.random() - 0.5) * 0.8); }

  /** Feed ChainRainEffect.onEvent straight into this. */
  handle(type, data = {}) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime + 0.01, pan = data.x != null ? data.x * 2 - 1 : 0;
    const PENTA = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];
    if (type === 'pulse') { this._noise(t, 0.3, 'bandpass', 1800, 1, 0.05); }
    else if (type === 'ignite') {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(36, t + 1.2);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 1.7);
      this._noise(t, 0.5, 'highpass', 2500, 0.7, 0.35);
      this._crackle(t + 0.1, 2.4, 240);
    } else if (type === 'launch') { const f = this._noise(t, 0.75, 'bandpass', 900, 3, 0.12, 0.25, pan); f.frequency.linearRampToValueAtTime(3200, t + 0.7); }
    else if (type === 'burst') {
      const s = data.size || 1;
      this._noise(t, 1.4 + 0.6 * s, 'lowpass', 160 + 80 * s, 1, 0.9 * Math.min(1.2, s), 0.004, pan);
      this._noise(t, 0.12, 'bandpass', 2500, 0.8, 0.3, 0.001, pan);
      this._noise(t + 0.22, 1.0, 'lowpass', 300, 1, 0.2, 0.01, -pan);
      if (data.kind !== 'peony') this._crackle(t + 0.3, 1.6, 90, pan);

    }
  }
}
