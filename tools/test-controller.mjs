// Sanity test for LaughController with synthetic blendshape signals:  node tools/test-controller.mjs
import { LaughController } from '../src/laugh.js';
const cases = {
  neutral: (t) => ({ smile: 0.05, jaw: 0.03, squint: 0.05 }),
  bigSmile: (t) => ({ smile: 0.85, jaw: 0.06, squint: 0.4 }),
  talking: (t) => ({ smile: 0.1, jaw: 0.15 + 0.15 * Math.max(0, Math.sin(t * 9)), squint: 0.05 }),
  yawn: (t) => ({ smile: 0.02, jaw: t > 1 && t < 3 ? 0.85 : 0.05, squint: 0.1 }),
  laugh: (t) => (t < 1.5 ? { smile: 0.1, jaw: 0.05, squint: 0.05 } : { smile: 0.75, jaw: 0.2 + 0.25 * Math.max(0, Math.sin(t * 13)), squint: 0.5 }),
  smileAfterNeutral: (t) => (t < 1.5 ? { smile: 0.05, jaw: 0.03, squint: 0.05 } : { smile: 0.9, jaw: 0.08, squint: 0.5 }),
  wideRestingMouth: (t) => ({ smile: 0.4, jaw: 0.12, squint: 0.2 }),
  wideRestingThenLaugh: (t) => (t < 1.5 ? { smile: 0.4, jaw: 0.12, squint: 0.2 } : { smile: 0.85, jaw: 0.3 + 0.25 * Math.max(0, Math.sin(t * 13)), squint: 0.6 }),
  giggle: (t) => (t < 1 ? { smile: 0.3, jaw: 0.05, squint: 0.2 } : { smile: 0.55, jaw: 0.05 + 0.3 * Math.max(0, Math.sin(t * 14)), squint: 0.3 }),
};
let fail = 0;
for (const [name, f] of Object.entries(cases)) {
  const ev = []; const c = new LaughController({ onPulse: () => ev.push('pulse'), onTrigger: () => ev.push('TRIGGER') });
  let firstTrig = null;
  for (let i = 0; i < 4 * 30; i++) { const t = i / 30; c.update({ face: true, ...f(t) }, 1 / 30, false); if (!firstTrig && ev.includes('TRIGGER')) firstTrig = t; }
  const trig = ev.includes('TRIGGER'), want = ['laugh', 'giggle', 'wideRestingThenLaugh'].includes(name);
  if (trig !== want) fail++;
  console.log(`${trig === want ? 'ok  ' : 'FAIL'} ${name.padEnd(9)} pulses=${ev.filter((e) => e === 'pulse').length} trigger=${trig}${firstTrig ? ' @' + firstTrig.toFixed(2) + 's' : ''}`);
}
process.exit(fail ? 1 : 0);
