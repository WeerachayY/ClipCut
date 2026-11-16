// One frame of the program: the main picture, then overlays from the bottom track up.
// Used by the live preview (with <video>/<img> sources) and by the export (with decoded frames).
import { drawTextClip } from './text.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Where a picture of size w×h goes when fitted inside W×H (letterboxed). */
export function containRect(w, h, W, H) {
  if (!w || !h) return { x: 0, y: 0, w: W, h: H };
  const s = Math.min(W / w, H / h);
  return { x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s };
}

/** Box of a picture overlay: centred at box.x/box.y, box.w of the frame wide, its own shape. */
export function mediaRect(clip, srcW, srcH, W, H) {
  const w = (clip.box?.w ?? 0.5) * W;
  const h = srcW && srcH ? (w * srcH) / srcW : w * 9 / 16;
  return { x: (clip.box?.x ?? 0.5) * W - w / 2, y: (clip.box?.y ?? 0.5) * H - h / 2, w, h };
}

/**
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} g
 * @param {number} W
 * @param {number} H
 * @param {object} o
 * @param {CanvasImageSource|null} o.main           picture of the main track at this moment
 * @param {number} o.mainW, o.mainH                 its size
 * @param {object[]} o.clips                        visual clips active now, in drawing order (compose.drawOrder)
 * @param {(clip)=>{src:CanvasImageSource,w:number,h:number}|null} o.media   picture of an image/video clip now
 * @param {number} o.T                              program time
 * @returns {{id, x, y, w, h}[]} where each overlay landed (for picking in the preview)
 */
export function drawFrame(g, W, H, { main, mainW, mainH, clips = [], media, T }) {
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  if (main) {
    const r = containRect(mainW, mainH, W, H);
    g.drawImage(main, r.x, r.y, r.w, r.h);
  }
  const hits = [];
  for (const c of clips) {
    const t = T - c.start;
    if (c.kind === 'text') {
      hits.push({ id: c.id, ...drawTextClip(g, c, t, W, H) });
      continue;
    }
    const m = media?.(c);
    const r = mediaRect(c, m?.w, m?.h, W, H);
    hits.push({ id: c.id, ...r });
    if (!m?.src) continue;
    let a = c.opacity ?? 1;
    if (c.fadeIn > 0) a *= clamp01(t / c.fadeIn);
    if (c.fadeOut > 0) a *= clamp01((c.duration - t) / c.fadeOut);
    if (a <= 0.002) continue;
    g.globalAlpha = a;
    g.drawImage(m.src, r.x, r.y, r.w, r.h);
    g.globalAlpha = 1;
  }
  return hits;
}
