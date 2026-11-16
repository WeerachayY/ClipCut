// Text clips drawn on a canvas, the same way in the live preview and in the exported video.
// Sizes are fractions of the picture, so a hook looks the same at 720p and 4K.
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
const words = (s) => (seg ? [...seg.segment(s)].map((x) => x.segment) : s.split(/(\s+)/));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p) => { const c = 1.70158; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; };

export const fontString = (style, px) => `${style.weight || 600} ${px}px "${style.font || 'Plex Thai'}", "Plex Thai", "Leelawadee UI", sans-serif`;

/** Make sure the fonts used by these clips are ready (canvas draws with a fallback font otherwise). */
export async function ensureFonts(clips) {
  if (typeof document === 'undefined' || !document.fonts) return;
  const want = new Set(clips.filter((c) => c.kind === 'text').map((c) => fontString(c.style || {}, 40)));
  await Promise.all([...want].map((f) => document.fonts.load(f, 'กขค ABC').catch(() => null)));
}

const cache = new Map();
/** Line breaks for a text clip at this size (Thai breaks between words, not inside them). */
function layout(g, clip, W, H) {
  const st = clip.style || {};
  const px = Math.max(8, Math.round((st.size || 0.05) * H));
  const pad = st.bg && st.bg !== 'none' ? px * 0.42 : 0;
  const maxW = Math.max(px * 2, (clip.box?.w ?? 0.9) * W - pad * 2);
  const key = `${clip.text}|${fontString(st, px)}|${maxW}`;
  const hit = cache.get(key);
  if (hit) return hit;
  g.font = fontString(st, px);
  const lines = [];
  for (const para of String(clip.text ?? '').split('\n')) {
    let cur = '';
    for (const w of words(para)) {
      const next = cur + w;
      if (cur && g.measureText(next).width > maxW) { lines.push(cur.trimEnd()); cur = w.trimStart(); } else cur = next;
    }
    lines.push(cur);
  }
  const widths = lines.map((l) => g.measureText(l).width);
  const lineH = px * 1.32;
  const out = { px, pad, lines, widths, lineH, textW: Math.max(1, ...widths), textH: lineH * lines.length };
  if (cache.size > 400) cache.clear();
  cache.set(key, out);
  return out;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Draw a text clip `t` seconds after it starts. Returns its box on the canvas {x, y, w, h} (without animation),
 * used to pick and drag it in the preview.
 */
export function drawTextClip(g, clip, t, W, H) {
  const st = clip.style || {};
  const L = layout(g, clip, W, H);
  const { px, pad, lines, widths, lineH } = L;
  const bw = L.textW + pad * 2;
  const bh = L.textH + (pad ? px * 0.36 : 0);
  const cx = (clip.box?.x ?? 0.5) * W;
  const cy = (clip.box?.y ?? 0.5) * H;
  const x0 = cx - bw / 2;
  const y0 = cy - bh / 2;
  const box = { x: x0, y: y0, w: bw, h: bh };

  // animation
  const anim = clip.anim || {};
  const dIn = Math.max(0.05, anim.dur || 0.35);
  const pIn = clamp01(t / dIn);
  const tLeft = clip.duration - t;
  const pOut = clamp01(tLeft / 0.3);
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  let reveal = Infinity;
  if (anim.in === 'fade') alpha *= pIn;
  if (anim.in === 'pop') { scale *= 0.55 + 0.45 * easeOutBack(pIn); alpha *= clamp01(pIn * 2.5); }
  if (anim.in === 'slide') { dy += (1 - easeOutCubic(pIn)) * bh * 0.9; alpha *= pIn; }
  if (anim.in === 'type') reveal = pIn;
  if (anim.out === 'fade') alpha *= pOut;
  if (anim.out === 'pop') { scale *= 0.6 + 0.4 * pOut; alpha *= pOut; }
  if (alpha <= 0.002) return box;

  g.save();
  g.globalAlpha = alpha;
  g.translate(cx, cy + dy);
  g.scale(scale, scale);
  g.translate(-cx, -cy);

  if (st.bg === 'box') {
    g.fillStyle = st.bgColor || '#000';
    roundRect(g, x0, y0, bw, bh, px * 0.28);
    g.fill();
  } else if (st.bg === 'bar') {
    g.fillStyle = st.bgColor || 'rgba(0,0,0,.8)';
    g.fillRect(x0, y0, bw, bh);
    g.fillStyle = st.accent || '#FFD60A';
    g.fillRect(x0, y0, Math.max(3, px * 0.14), bh);
  }

  g.font = fontString(st, px);
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const align = st.align || 'center';
  // how much of the text shows ("type" animation reveals it letter by letter)
  let budget = Infinity;
  if (reveal !== Infinity) {
    const total = lines.reduce((a, l) => a + (graphemes ? [...graphemes.segment(l)].length : l.length), 0);
    budget = Math.floor(total * reveal);
  }
  lines.forEach((line, i) => {
    if (budget <= 0) return;
    let shown = line;
    if (budget !== Infinity) {
      const gs = graphemes ? [...graphemes.segment(line)].map((x) => x.segment) : [...line];
      shown = gs.slice(0, budget).join('');
      budget -= gs.length;
    }
    const y = y0 + (pad ? px * 0.18 : 0) + lineH * (i + 0.5);
    let x;
    if (align === 'left') { g.textAlign = 'left'; x = x0 + pad + (st.bg === 'bar' ? px * 0.2 : 0); }
    else if (align === 'right') { g.textAlign = 'right'; x = x0 + bw - pad; }
    else { g.textAlign = 'left'; x = cx - widths[i] / 2; }
    if (st.shadow) { g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = px * 0.18; g.shadowOffsetY = px * 0.06; }
    if (st.stroke && st.strokeWidth) {
      g.strokeStyle = st.stroke;
      g.lineWidth = st.strokeWidth * px * 2;
      g.strokeText(shown, x, y);
      g.shadowColor = 'transparent';
    }
    g.fillStyle = st.color || '#fff';
    g.fillText(shown, x, y);
    g.shadowColor = 'transparent';
  });
  g.restore();
  return box;
}
