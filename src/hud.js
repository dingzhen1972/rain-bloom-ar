import { THEME } from './theme.js';
// Minimal on-screen UI, drawn into the canvas so it is also in recordings.
// A short hint at the top, a five-bar laugh level at the bottom that turns gold when the laugh lands.
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Noto Sans CJK SC", sans-serif';
const MONO = 'ui-monospace,"SF Mono","DejaVu Sans Mono",Menlo,monospace';
const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Line icons, one stroke weight and colour: 'smile' (closed smile) and 'laugh' (open, filled mouth). */
function face(ctx, x, y, r, kind, S) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 4.5 * S; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.stroke();
  const ex = r * 0.36, ey = y - r * 0.22, er = r * 0.085;
  ctx.beginPath(); ctx.arc(x - ex, ey, er, 0, 6.283); ctx.arc(x + ex, ey, er, 0, 6.283); ctx.fill();
  if (kind === 'laugh') { ctx.beginPath(); ctx.moveTo(x - r * 0.5, y + r * 0.1); ctx.lineTo(x + r * 0.5, y + r * 0.1); ctx.arc(x, y + r * 0.1, r * 0.5, 0, Math.PI); ctx.closePath(); ctx.fill(); }
  else { ctx.beginPath(); ctx.arc(x, y + r * 0.02, r * 0.48, 0.18 * Math.PI, 0.82 * Math.PI); ctx.stroke(); }
  ctx.restore();
}

export function drawHUD(ctx, W, H, o) {
  const S = Math.min(W, H) / 1080, t = o.time || 0;
  const hot = o.state === 'laugh' || o.state === 'bloom';
  ctx.save();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  // hint pill
  if (o.hint && o.hintAlpha > 0.01) {
    ctx.globalAlpha = o.hintAlpha;
    // plain text, no box (Apple-like): light weight, wide tracking, soft shadow for legibility on any background
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 14 * S;
    let ty = 170 * S;
    if (o.icon) { face(ctx, W / 2, 150 * S, 44 * S, o.icon, S); ty = 236 * S; }   // icon above, small caption below
    ctx.font = `500 ${(o.icon ? 26 : 30) * S}px ${SANS}`; if ('letterSpacing' in ctx) ctx.letterSpacing = `${3 * S}px`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(o.hint, W / 2, ty);
    ctx.shadowBlur = 0; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.globalAlpha = 1;
  }
  // laugh level: five bars
  const n = 5, bw = 9 * S, gap = 10 * S, maxH = 46 * S, cx = W / 2, by = H - 330 * S;
  const lvl = hot ? 1 : Math.max(0, Math.min(1, (o.score || 0) / (o.threshold || 0.55)));
  for (let i = 0; i < n; i++) {
    const on = lvl * n - i, h = maxH * (0.35 + 0.65 * Math.max(0.15, Math.min(1, on))) * (hot ? 0.75 + 0.25 * Math.sin(t * 9 + i * 1.3) : 1);
    const x = cx + (i - (n - 1) / 2) * (bw + gap) - bw / 2;
    ctx.fillStyle = on > 0 ? (hot ? rgb(THEME.hud.barHot, 0.98) : rgb(THEME.hud.bar, 0.95)) : rgb(THEME.hud.bar, 0.28);
    pill(ctx, x, by - h, bw, h); ctx.fill();
  }
  if (o.rec) {
    ctx.textAlign = 'right'; ctx.font = `600 ${22 * S}px ${MONO}`; ctx.fillStyle = '#fff'; ctx.fillText(o.rec, W - 84 * S, 96 * S);
    ctx.fillStyle = 'rgba(255,70,80,0.95)'; ctx.beginPath(); ctx.arc(W - 62 * S, 96 * S, 9 * S, 0, 6.283); ctx.fill();
  }
  ctx.restore();
}

function pill(ctx, x, y, w, h) {
  const r = Math.min(w, h) / 2;
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
