// Speed curve editor (like CapCut's): speed over the clip, 0.1× at the bottom to 10× at the top on a log
// scale, 1× in the middle. Drag points up and down (and sideways, between their neighbours);
// double-click the line to add a point, double-click a point to remove it.
import { SPEED_MIN, SPEED_MAX } from '../core/speed.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 320;
const H = 150;
const PAD = { l: 34, r: 10, t: 10, b: 10 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;
const yOf = (v) => PAD.t + IH * (1 - (Math.log10(v) + 1) / 2);
const vOf = (y) => 10 ** ((1 - (y - PAD.t) / IH) * 2 - 1);
const xOf = (u) => PAD.l + u * IW;
const uOf = (x) => (x - PAD.l) / IW;
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A small picture of a preset curve (for the preset buttons). */
export function curveThumb(points, w = 56, h = 28) {
  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  const y = (v) => h - 3 - ((Math.log10(v) + 1) / 2) * (h - 6);
  svg.append(el('line', { x1: 0, x2: w, y1: y(1), y2: y(1), class: 'se-one' }));
  svg.append(el('polyline', { points: points.map(([px, py]) => `${(px * (w - 4) + 2).toFixed(1)},${y(py).toFixed(1)}`).join(' '), class: 'se-thumb' }));
  return svg;
}

/**
 * @param {{points:{x,y}[], onChange:(points, {live:boolean})=>void, marker?:number}} o
 * @returns {{el:SVGElement, set:(points)=>void, mark:(u:number|null)=>void}}
 */
export function speedEditor({ points, onChange }) {
  let pts = points.map((p) => ({ ...p }));
  const svg = el('svg', { class: 'speed-editor', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'กราฟความเร็วของชิ้นนี้' });
  const grid = el('g');
  for (const v of [0.1, 0.2, 0.5, 1, 2, 5, 10]) {
    grid.append(el('line', { x1: PAD.l, x2: W - PAD.r, y1: yOf(v), y2: yOf(v), class: v === 1 ? 'se-one' : 'se-grid' }));
    const t = el('text', { x: PAD.l - 6, y: yOf(v) + 3.5, class: 'se-label', 'text-anchor': 'end' });
    t.textContent = `${v}×`;
    grid.append(t);
  }
  const area = el('rect', { x: PAD.l, y: PAD.t, width: IW, height: IH, class: 'se-area' });
  const line = el('polyline', { class: 'se-line' });
  const marker = el('line', { y1: PAD.t, y2: H - PAD.b, class: 'se-marker', visibility: 'hidden' });
  const dots = el('g');
  svg.append(grid, area, marker, line, dots);

  const toLocal = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  function paint() {
    line.setAttribute('points', pts.map((p) => `${xOf(p.x).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' '));
    dots.replaceChildren(...pts.map((p, i) => {
      const c = el('circle', { cx: xOf(p.x), cy: yOf(p.y), r: 6, class: 'se-dot', tabindex: '0', 'aria-label': `จุดที่ ${i + 1} ความเร็ว ${p.y.toFixed(2)}×` });
      c.addEventListener('pointerdown', (e) => grab(e, i));
      c.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (i === 0 || i === pts.length - 1 || pts.length <= 2) return;
        pts.splice(i, 1);
        paint();
        onChange(pts.map((q) => ({ ...q })), { live: false });
      });
      c.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        e.stopPropagation();
        pts[i] = { ...pts[i], y: clamp(pts[i].y * (e.key === 'ArrowUp' ? 1.1 : 1 / 1.1), SPEED_MIN, SPEED_MAX) };
        paint();
        onChange(pts.map((q) => ({ ...q })), { live: false });
      });
      const tip = el('title');
      tip.textContent = `${p.y.toFixed(2)}× · ลากขึ้นลงเพื่อเปลี่ยนความเร็ว · ดับเบิลคลิกเพื่อลบจุด`;
      c.append(tip);
      return c;
    }));
  }

  function grab(e, i) {
    e.preventDefault();
    e.stopPropagation();
    svg.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const p = toLocal(ev);
      const y = clamp(vOf(p.y), SPEED_MIN, SPEED_MAX);
      // snap to 1× near the middle line
      const yy = Math.abs(Math.log10(y)) < 0.03 ? 1 : y;
      let x = pts[i].x;
      if (i > 0 && i < pts.length - 1) x = clamp(uOf(p.x), pts[i - 1].x + 0.02, pts[i + 1].x - 0.02);
      pts[i] = { x, y: +yy.toFixed(3) };
      paint();
      onChange(pts.map((q) => ({ ...q })), { live: true });
    };
    const up = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
      onChange(pts.map((q) => ({ ...q })), { live: false });
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  }

  svg.addEventListener('dblclick', (e) => {
    const p = toLocal(e);
    const u = uOf(p.x);
    if (u <= 0.01 || u >= 0.99 || pts.length >= 12) return;
    const at = pts.findIndex((q) => q.x > u);
    if (at <= 0) return;
    if (u - pts[at - 1].x < 0.03 || pts[at].x - u < 0.03) return;
    pts.splice(at, 0, { x: u, y: +clamp(vOf(p.y), SPEED_MIN, SPEED_MAX).toFixed(3) });
    paint();
    onChange(pts.map((q) => ({ ...q })), { live: false });
  });

  paint();
  return {
    el: svg,
    set(next) { pts = next.map((p) => ({ ...p })); paint(); },
    /** Where the playhead is inside the piece (0..1), or null to hide. */
    mark(u) {
      if (u == null) { marker.setAttribute('visibility', 'hidden'); return; }
      marker.setAttribute('x1', xOf(u));
      marker.setAttribute('x2', xOf(u));
      marker.setAttribute('visibility', 'visible');
    },
  };
}
