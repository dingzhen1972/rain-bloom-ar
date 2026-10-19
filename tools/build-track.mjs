// Turn the per-frame analysis of a clip (tools/analyze_clip.py) into a render track:
// runs the app's own LaughController over the detected expression signals, so the "ha" pulses and the
// trigger moment in the demo renders come from detection, not from hand-placed timestamps.
//   node tools/build-track.mjs signals.json track.json
import fs from 'node:fs';
import { LaughController } from '../src/laugh.js';
const [inp, out] = process.argv.slice(2);
const sig = JSON.parse(fs.readFileSync(inp, 'utf8'));
const FPS = 30, clamp = (x) => Math.max(0, Math.min(1, x));
const pulses = []; let trigger = null; const scores = [], moods = [];
let t = 0;
const ctrl = new LaughController({ onPulse: () => pulses.push(+t.toFixed(3)), onTrigger: () => { if (trigger == null) trigger = +t.toFixed(3); } });
let busyUntil = -1;
sig.frames.forEach((f, i) => {
  t = i / FPS;
  // FaceMesh geometry → blendshape-like signals (0..1); the controller's per-person baseline removes each face's resting shape
  const jaw = clamp((f.gap - 0.008) / 0.09);
  const smile = clamp((f.mw - 0.30) / 0.14) * 0.6 + clamp((f.lift + 0.01) / 0.05) * 0.4;
  const sample = f.found ? { face: true, smile, jaw, squint: smile * 0.5 } : null;
  ctrl.update(sample, 1 / FPS, trigger != null && t < trigger + 7.8);
  scores.push(+ctrl.score.toFixed(3)); moods.push(+ctrl.rel.smile.toFixed(3));
});
const track = { ...sig, pulses: pulses.filter((p) => trigger == null || p < trigger), trigger, scores, moods };
fs.writeFileSync(out, JSON.stringify(track));
console.log(`pulses at ${track.pulses.join(', ')} s; laugh detected at ${trigger} s`);
