// The editing strip: files as a continuous track, cuts as hatched "splice tape",
// split markers as pins, sync anchors as ticks, and the playhead.
import { h, clear } from './dom.js';
import { formatTime } from '../core/time.js';

const ZOOMS = [1, 2, 4, 8, 16, 32, 64];
const TICKS = [5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];

export class TimelineView {
  constructor({ onSeek, onSelectCut }) {
    this.onSeek = onSeek;
    this.onSelectCut = onSelectCut;
    this.zoomIndex = 0;
    this.duration = 1;
    this.data = null;

    this.ruler = h('div.tl-ruler');
    this.track = h('div.tl-track');
    this.pins = h('div.tl-pins');
    this.playhead = h('div.tl-playhead', h('span.tl-playhead-cap'));
    this.hover = h('div.tl-hover');
    this.inner = h('div.tl-inner', this.ruler, this.pins, this.track, this.playhead, this.hover);
    this.scroll = h('div.tl-scroll', this.inner);
    this.zoomLabel = h('span.tl-zoom-label', '1×');
    this.el = h('div.tl',
      h('div.tl-bar',
        h('span.tl-legend',
          h('span.sw.accepted'), 'ตัด', h('span.sw.high'), 'แนะนำให้ตัด', h('span.sw.check'), 'ควรเช็ค', h('span.sw.rejected'), 'เก็บไว้', h('span.sw.split'), 'จุดแบ่งไฟล์'),
        h('span.tl-zoom',
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(this.zoomIndex - 1), 'aria-label': 'ซูมออก' }, '−'),
          this.zoomLabel,
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(this.zoomIndex + 1), 'aria-label': 'ซูมเข้า' }, '+'),
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(0) }, 'พอดีจอ'))),
      this.scroll);

    this.inner.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const cutEl = e.target.closest('.tl-cut');
      if (cutEl) { this.onSelectCut(cutEl.dataset.id); return; }
      this.onSeek(this.#timeAt(e.clientX));
    });
    this.inner.addEventListener('pointermove', (e) => {
      const t = this.#timeAt(e.clientX);
      this.hover.textContent = formatTime(t);
      this.hover.style.left = `${(t / this.duration) * 100}%`;
      this.hover.classList.add('on');
    });
    this.inner.addEventListener('pointerleave', () => this.hover.classList.remove('on'));
  }

  #timeAt(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((clientX - r.left) / r.width) * this.duration));
  }

  setZoom(i) {
    this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, i));
    const z = ZOOMS[this.zoomIndex];
    this.inner.style.width = `${z * 100}%`;
    this.zoomLabel.textContent = `${z}×`;
    if (this.data) this.#renderRuler();
    this.#follow(this.lastT || 0, true);
  }

  /** @param {{timeline, cuts, splits, anchorsG:number[], selectedCutId, effectiveEnd:(cut)=>number}} d */
  render(d) {
    this.data = d;
    this.duration = Math.max(1, d.timeline.duration);
    const pct = (t) => `${(t / this.duration) * 100}%`;
    const files = d.timeline.files.map((f, i) => h(`div.tl-file${i % 2 ? '.alt' : ''}`, { style: { left: pct(f.start), width: pct(f.duration) } },
      h('span.tl-file-name', d.timeline.files.length > 1 ? `ไฟล์ ${i + 1}` : '')));
    const seams = d.timeline.seams.map((s) => h('div.tl-seam', { style: { left: pct(s) }, title: 'รอยต่อระหว่างไฟล์' }));
    const cuts = d.cuts.map((c) => {
      const cls = c.status === 'suggested' ? (c.confidence === 'high' ? 'high' : 'check') : c.status;
      const eff = d.effectiveEnd(c);
      const el = h(`div.tl-cut.${cls}${c.id === d.selectedCutId ? '.selected' : ''}`, {
        dataset: { id: c.id },
        style: { left: pct(c.start), width: pct(Math.max(0, c.end - c.start)) },
        title: `${formatTime(c.start)} – ${formatTime(c.end)}`,
      });
      if (c.status === 'accepted' && eff < c.end - 0.05) {
        el.append(h('span.tl-cut-kept', { style: { width: `${((c.end - eff) / (c.end - c.start)) * 100}%` }, title: 'ส่วนนี้จะยังอยู่ในไฟล์ (ปรับตาม keyframe)' }));
      }
      return el;
    });
    clear(this.track, files, cuts, seams);
    const pins = [
      ...d.splits.map((s) => h('div.tl-pin.split', { style: { left: pct(s.at) }, title: `แบ่งไฟล์: ${s.label || ''} ${formatTime(s.at)}` }, h('span', s.label || 'แบ่ง'))),
      ...d.anchorsG.map((g) => h('div.tl-pin.anchor', { style: { left: pct(g) }, title: `หมุดเวลา ${formatTime(g)}` })),
    ];
    clear(this.pins, pins);
    this.#renderRuler();
  }

  #renderRuler() {
    const width = this.scroll.clientWidth * ZOOMS[this.zoomIndex] || 800;
    const secPerPx = this.duration / width;
    const step = TICKS.find((t) => t / secPerPx >= 90) || 3600;
    const ticks = [];
    for (let t = 0; t <= this.duration; t += step) {
      ticks.push(h('span.tl-tick', { style: { left: `${(t / this.duration) * 100}%` } }, formatTime(t, { short: this.duration < 3600 })));
    }
    clear(this.ruler, ticks);
  }

  setTime(t) {
    this.lastT = t;
    this.playhead.style.left = `${(t / this.duration) * 100}%`;
    this.#follow(t, false);
  }

  #follow(t, center) {
    if (this.zoomIndex === 0) return;
    const w = this.inner.clientWidth;
    const x = (t / this.duration) * w;
    const { scrollLeft, clientWidth } = this.scroll;
    if (center || x < scrollLeft + 20 || x > scrollLeft + clientWidth - 20) this.scroll.scrollLeft = x - clientWidth * (center ? 0.5 : 0.2);
  }

  resize() { if (this.data) this.#renderRuler(); }
}
