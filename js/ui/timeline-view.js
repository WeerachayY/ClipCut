// The editing strip. Cut points (marks) slice the track into pieces; thrown-away pieces carry the
// hatched "splice tape". Marks have a handle above the track that can be clicked or dragged.
// A small command bar floats under whatever is selected.
import { h, clear } from './dom.js';
import { formatTime } from '../core/time.js';

const ZOOMS = [1, 2, 4, 8, 16, 32, 64, 128];
const TICKS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];

export class TimelineView {
  /**
   * @param {{onSeek:(t)=>void, onSelectPiece:(key,t)=>void, onActivatePiece:(key)=>void,
   *          onSelectMark:(id)=>void, onMoveMark:(id,t)=>void, getPlayhead:()=>number}} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.zoomIndex = 0;
    this.duration = 1;
    this.data = null;
    this.lastT = 0;

    this.ruler = h('div.tl-ruler');
    this.pins = h('div.tl-pins');
    this.track = h('div.tl-track');
    this.lines = h('div.tl-lines');
    this.playhead = h('div.tl-playhead', h('span.tl-playhead-cap'));
    this.hover = h('div.tl-hover');
    this.toolbarSlot = h('div.tl-toolbar-slot');
    this.inner = h('div.tl-inner', this.ruler, this.track, this.lines, this.pins, this.playhead, this.hover, this.toolbarSlot);
    this.scroll = h('div.tl-scroll', this.inner);
    this.zoomLabel = h('span.tl-zoom-label', '1×');
    this.el = h('div.tl',
      h('div.tl-bar',
        h('span.tl-legend',
          h('span.sw.delete'), 'ทิ้ง', h('span.sw.high'), 'แนะนำให้ทิ้ง', h('span.sw.check'), 'ควรเช็ค', h('span.sw.mark'), 'จุดตัด', h('span.sw.split'), 'แยกไฟล์'),
        h('span.tl-zoom',
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(this.zoomIndex - 1), 'aria-label': 'ซูมออก' }, '−'),
          this.zoomLabel,
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(this.zoomIndex + 1), 'aria-label': 'ซูมเข้า' }, '+'),
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(0) }, 'พอดีจอ'))),
      this.scroll);

    this.inner.addEventListener('pointerdown', (e) => this.#down(e));
    this.inner.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tl-mark-h, .tl-toolbar-slot')) return;
      const p = this.#pieceAt(this.#timeAt(e.clientX));
      if (p) this.cb.onActivatePiece(p.key);
    });
    this.inner.addEventListener('pointermove', (e) => {
      if (this.drag) return;
      if (e.target.closest('.tl-toolbar-slot')) { this.hover.classList.remove('on'); return; }
      this.#showHover(this.#timeAt(e.clientX));
    });
    this.inner.addEventListener('pointerleave', () => { if (!this.drag) this.hover.classList.remove('on'); });
  }

  #timeAt(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((clientX - r.left) / r.width) * this.duration));
  }

  #pieceAt(t) { return this.data?.pieces.find((p) => t >= p.start && t < p.end) || this.data?.pieces[this.data.pieces.length - 1]; }

  #pct(t) { return `${(t / this.duration) * 100}%`; }

  #showHover(t) {
    this.hover.textContent = formatTime(t, { decimals: this.zoomIndex >= 3 ? 1 : 0 });
    this.hover.style.left = this.#pct(t);
    this.hover.classList.add('on');
  }

  #down(e) {
    if (e.button !== 0 || e.target.closest('.tl-toolbar-slot')) return;
    const handle = e.target.closest('.tl-mark-h');
    if (handle) { this.#startDrag(e, handle.dataset.id); return; }
    const t = this.#timeAt(e.clientX);
    this.cb.onSeek(t);
    const p = this.#pieceAt(t);
    if (p) this.cb.onSelectPiece(p.key, t);
  }

  #startDrag(e, id) {
    const marks = this.data.marks;
    const i = marks.findIndex((m) => m.id === id);
    if (i < 0) return;
    const lo = (i > 0 ? marks[i - 1].at : 0) + 0.1;
    const hi = (i < marks.length - 1 ? marks[i + 1].at : this.duration) - 0.1;
    const startX = e.clientX;
    const els = [...this.inner.querySelectorAll(`[data-mark="${id}"]`)];
    let t = marks[i].at;
    let moved = false;
    this.drag = true;
    e.target.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      t = Math.min(hi, Math.max(lo, this.#timeAt(ev.clientX)));
      // snap to the playhead when close (8 px)
      const ph = this.cb.getPlayhead?.();
      const pxPerSec = this.inner.getBoundingClientRect().width / this.duration;
      if (ph != null && Math.abs(ph - t) * pxPerSec < 8 && ph > lo && ph < hi) t = ph;
      for (const el of els) el.style.left = this.#pct(t);
      this.#showHover(t);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.drag = false;
      this.hover.classList.remove('on');
      if (moved) this.cb.onMoveMark(id, t);
      else this.cb.onSelectMark(id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  setZoom(i) {
    this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, i));
    const z = ZOOMS[this.zoomIndex];
    this.inner.style.width = `${z * 100}%`;
    this.zoomLabel.textContent = `${z}×`;
    if (this.data) this.#renderRuler();
    this.#follow(this.lastT, true);
  }

  /**
   * @param {{timeline, pieces, marks, selection, anchorsG:number[], ticks:number[]}} d
   *   pieces/marks from core/cuts.js (marks sorted), ticks = where lossless cuts really land
   */
  render(d) {
    this.data = d;
    this.duration = Math.max(1, d.timeline.duration);
    const sel = d.selection || {};
    const files = d.timeline.files.map((f, i) => h(`div.tl-file${i % 2 ? '.alt' : ''}`, { style: { left: this.#pct(f.start), width: this.#pct(f.duration) } },
      h('span.tl-file-name', d.timeline.files.length > 1 ? `ไฟล์ ${i + 1}` : '')));
    const seams = d.timeline.seams.map((s) => h('div.tl-seam', { style: { left: this.#pct(s) }, title: 'รอยต่อระหว่างไฟล์' }));
    const pieces = d.pieces.map((p) => {
      const cls = p.status === 'delete' ? 'delete' : p.status === 'suggested' ? (p.confidence === 'high' ? 'high' : 'check') : 'keep';
      const selected = sel.type === 'piece' && sel.key === p.key;
      if (cls === 'keep' && !selected) return null;
      return h(`div.tl-piece.${cls}${selected ? '.selected' : ''}`, { style: { left: this.#pct(p.start), width: this.#pct(p.end - p.start) } });
    });
    const ticks = d.ticks.map((t) => h('div.tl-kf', { style: { left: this.#pct(t) }, title: `แบบไม่บีบอัด วิดีโอจะกลับมาเล่นที่ ${formatTime(t, { decimals: 1 })} (keyframe)` }));
    clear(this.track, files, pieces, seams, ticks);

    const markLines = d.marks.map((m) => h(`div.tl-mark${m.split ? '.split' : ''}${sel.type === 'mark' && sel.id === m.id ? '.selected' : ''}`, { dataset: { mark: m.id }, style: { left: this.#pct(m.at) } }));
    clear(this.lines, markLines);
    const handles = d.marks.map((m) => h(`div.tl-mark-h${m.split ? '.split' : ''}${sel.type === 'mark' && sel.id === m.id ? '.selected' : ''}`, {
      dataset: { id: m.id, mark: m.id },
      style: { left: this.#pct(m.at) },
      title: `${m.split ? 'แยกไฟล์' : 'จุดตัด'} ${formatTime(m.at, { decimals: 1 })} — คลิกเพื่อดูคำสั่ง ลากเพื่อขยับ`,
    }, m.split ? h('span.tl-split-label', m.label || 'ไฟล์ใหม่') : null));
    const anchors = d.anchorsG.map((g) => h('div.tl-anchor', { style: { left: this.#pct(g) }, title: `หมุดเวลา ${formatTime(g)}` }));
    clear(this.pins, handles, anchors);
    this.#renderRuler();
  }

  #renderRuler() {
    const width = this.scroll.clientWidth * ZOOMS[this.zoomIndex] || 800;
    const secPerPx = this.duration / width;
    const step = TICKS.find((t) => t / secPerPx >= 90) || 3600;
    const ticks = [];
    for (let t = 0; t <= this.duration + 1e-9; t += step) {
      ticks.push(h('span.tl-tick', { style: { left: this.#pct(t) } }, formatTime(t, { short: this.duration < 3600 })));
    }
    clear(this.ruler, ticks);
  }

  /** Float `el` under time t (or hide when el is null). */
  showToolbar(el, t) {
    clear(this.toolbarSlot);
    if (!el) return;
    this.toolbarSlot.append(el);
    el.style.left = this.#pct(t);
    requestAnimationFrame(() => {
      const w = el.offsetWidth;
      const innerW = this.inner.clientWidth;
      const x = (t / this.duration) * innerW;
      const left = Math.max(w / 2 + 4, Math.min(innerW - w / 2 - 4, x));
      el.style.left = `${left}px`;
    });
  }

  setTime(t) {
    this.lastT = t;
    this.playhead.style.left = this.#pct(t);
    this.#follow(t, false);
  }

  #follow(t, center) {
    if (this.zoomIndex === 0 || this.drag) return;
    const w = this.inner.clientWidth;
    const x = (t / this.duration) * w;
    const { scrollLeft, clientWidth } = this.scroll;
    if (center || x < scrollLeft + 20 || x > scrollLeft + clientWidth - 20) this.scroll.scrollLeft = x - clientWidth * (center ? 0.5 : 0.2);
  }

  resize() { if (this.data) this.#renderRuler(); }
}
