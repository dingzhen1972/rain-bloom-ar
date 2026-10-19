import { THEME } from './theme.js';
// Minimal on-screen UI, drawn into the canvas so it is also in recordings.
// A short hint at the top, a five-bar laugh level at the bottom that turns gold when the laugh lands.
const SANS = '"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif';
const MONO = 'ui-monospace,"SF Mono","DejaVu Sans Mono",Menlo,monospace';
const WORD = THEME.hud.words;
const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function drawHUD(ctx, W, H, o) {
  const S = Math.min(W, H) / 1080, t = o.time || 0;
  const hot = o.state === 'laugh' || o.state === 'bloom';
  ctx.save();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  // hint pill
  if (o.hint && o.hintAlpha > 0.01) {
    ctx.globalAlpha = o.hintAlpha;
    ctx.font = `500 ${30 * S}px ${SANS}`;
    const tw = ctx.measureText(o.hint).width + 56 * S, y = 150 * S;
    ctx.fillStyle = 'rgba(10,14,26,0.42)'; pill(ctx, W / 2 - tw / 2, y - 30 * S, tw, 60 * S); ctx.fill();
    ctx.fillStyle = 'rgba(248,250,255,0.95)'; ctx.fillText(o.hint, W / 2, y + 1 * S);
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
  ctx.font = `500 ${24 * S}px ${SANS}`; ctx.fillStyle = hot ? 'rgba(255,215,150,0.95)' : 'rgba(240,246,255,0.8)';
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8 * S;
  ctx.fillText(WORD[o.state] || WORD.still, cx, by + 32 * S);
  ctx.shadowBlur = 0;
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
