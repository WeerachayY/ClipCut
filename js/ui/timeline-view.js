// The editing strip. Cut points (marks) slice the timeline into pieces; thrown-away pieces carry the
// hatched "splice tape" across every lane. Marks have a handle above the lanes that can be clicked or dragged.
// Lanes (filmstrip, waveform, …) are track plugins (core/registry.js) drawn on a canvas that covers only
// the visible stretch, so any zoom level costs the same. A small command bar floats under the selection.
import { h, clear } from './dom.js';
import { formatTime, formatTimecode } from '../core/time.js';
import { tracks } from '../core/registry.js';

const LANES_TOP = 44;
const LANE_GAP = 3;
const PREFS = 'clipcut.tracks.hidden';
const loadHidden = () => { try { return new Set(JSON.parse(localStorage.getItem(PREFS) || '[]')); } catch { return new Set(); } };
const hasPrefs = () => { try { return localStorage.getItem(PREFS) != null; } catch { return false; } };
const saveHidden = (set) => { try { localStorage.setItem(PREFS, JSON.stringify([...set])); } catch { /* private mode */ } };

const ZOOMS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];

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

    this.media = { frames: null, layers: {}, progress: {}, analysis: {} };
    this.hidden = loadHidden();
    if (!hasPrefs()) for (const t of tracks()) if (t.enabledByDefault === false) this.hidden.add(t.id);
    this.lanes = h('div.tl-lanes');
    this.laneList = [];
    this.trackToggles = h('span.tl-tracks');
    this.ruler = h('div.tl-ruler');
    this.pins = h('div.tl-pins');
    this.track = h('div.tl-track');
    this.lines = h('div.tl-lines');
    this.playhead = h('div.tl-playhead', h('span.tl-playhead-cap'));
    this.hover = h('div.tl-hover');
    this.toolbarSlot = h('div.tl-toolbar-slot');
    this.inner = h('div.tl-inner', this.ruler, this.lanes, this.track, this.lines, this.pins, this.playhead, this.hover, this.toolbarSlot);
    this.scroll = h('div.tl-scroll', this.inner);
    this.zoomLabel = h('span.tl-zoom-label', '1×');
    this.el = h('div.tl',
      h('div.tl-bar',
        h('span.tl-legend',
          h('span.sw.delete'), 'ทิ้ง', h('span.sw.high'), 'แนะนำให้ทิ้ง', h('span.sw.check'), 'ควรเช็ค', h('span.sw.mark'), 'จุดตัด', h('span.sw.split'), 'แยกไฟล์'),
        this.trackToggles,
        h('span.tl-zoom',
          h('button.ghost.small', { type: 'button', onclick: () => this.zoomOut(), 'aria-label': 'ซูมออก', 'data-tip': 'ซูมออก · Ctrl −' }, '−'),
          this.zoomLabel,
          h('button.ghost.small', { type: 'button', onclick: () => this.zoomIn(), 'aria-label': 'ซูมเข้า', 'data-tip': 'ซูมเข้า · Ctrl + (หรือ Ctrl + ล้อเมาส์)' }, '+'),
          h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(0), 'data-tip': 'พอดีจอ · Ctrl 0' }, 'พอดีจอ'))),
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
    // Ctrl + wheel zooms around the pointer, like most editors
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.setZoom(this.zoomIndex + (e.deltaY < 0 ? 1 : -1), { t: this.#timeAt(e.clientX), clientX: e.clientX });
    }, { passive: false });
    let raf = 0;
    this.scroll.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { this.#renderRuler(); this.#placeToolbar(); this.#drawLanes(); });
    });
    this.#buildLanes();
  }

  /** Frames for the filmstrip, media layers (e.g. waveform), their build progress (0..1 per layer id), detector results. */
  setMedia({ frames, layers, progress, analysis } = {}) {
    if (frames !== undefined && frames !== this.media.frames) {
      this.unFrames?.();
      this.media.frames = frames;
      this.unFrames = frames?.onFrame(() => this.redrawSoon());
    }
    if (layers !== undefined) this.media.layers = layers || {};
    if (progress !== undefined) this.media.progress = progress || {};
    if (analysis !== undefined) this.media.analysis = analysis || {};
    this.redrawSoon();
  }

  #renderToggles() {
    clear(this.trackToggles, tracks().map((t) => {
      const on = !this.hidden.has(t.id);
      return h(`button.tl-track-toggle${on ? '.on' : ''}`, {
        type: 'button', 'aria-pressed': String(on), 'data-tip': on ? `ซ่อนแทร็ก${t.label}` : `แสดงแทร็ก${t.label}`,
        onclick: () => { if (on) this.hidden.add(t.id); else this.hidden.delete(t.id); saveHidden(this.hidden); this.#buildLanes(); },
      }, t.label);
    }));
  }

  /** One lane per visible track; everything else (pieces, marks, playhead, command bar) stretches to fit. */
  #buildLanes() {
    this.#renderToggles();
    let y = 0;
    this.laneList = tracks().filter((t) => !this.hidden.has(t.id)).map((t) => {
      const canvas = h('canvas.tl-canvas');
      const el = h('div.tl-lane', { dataset: { track: t.id }, style: { top: `${y}px`, height: `${t.height}px` } }, canvas);
      const lane = { t, el, canvas };
      y += t.height + LANE_GAP;
      return lane;
    });
    const H = Math.max(28, y - LANE_GAP);
    clear(this.lanes, this.laneList.map((l) => l.el));
    this.lanes.style.height = `${H}px`;
    this.track.style.height = `${H}px`;
    this.lines.style.height = `${H + 12}px`;
    this.playhead.style.height = `${LANES_TOP - 18 + H}px`;
    this.toolbarSlot.style.top = `${LANES_TOP + H + 8}px`;
    this.inner.style.height = `${LANES_TOP + H + 52}px`;
    this.#drawLanes();
  }

  redrawSoon() {
    if (this.rafDraw) return;
    this.rafDraw = requestAnimationFrame(() => { this.rafDraw = 0; this.#drawLanes(); });
  }

  #colors() {
    const cs = getComputedStyle(this.el);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { lane: v('--talk'), laneAlt: v('--talk-2'), gap: v('--panel'), wave: v('--wave') || v('--ink-2'), waveBg: v('--wave-bg') || v('--talk'), muted: v('--ink-3'), font: v('--font') };
  }

  #drawLanes() {
    if (!this.data || !this.laneList.length) return;
    const vw = this.scroll.clientWidth;
    const W = this.inner.clientWidth;
    if (!vw || !W) return;
    const pxPerSec = W / this.duration;
    const left = this.scroll.scrollLeft;
    const t0 = left / pxPerSec;
    const t1 = Math.min(this.duration, (left + vw) / pxPerSec);
    const dpr = window.devicePixelRatio || 1;
    const colors = this.#colors();
    for (const { t, canvas } of this.laneList) {
      const cw = Math.max(1, Math.round(vw * dpr));
      const ch = Math.round(t.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      Object.assign(canvas.style, { width: `${vw}px`, height: `${t.height}px`, left: `${left}px` });
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, vw, t.height);
      try {
        t.draw({
          g, width: vw, height: t.height, t0, t1, pxPerSec, duration: this.duration, x: (s) => (s - t0) * pxPerSec,
          timeline: this.data.timeline, frames: this.media.frames, analysis: this.media.analysis, colors,
          layer: t.layer ? this.media.layers?.[t.layer] || null : null,
          progress: t.layer ? this.media.progress?.[t.layer] ?? null : null,
          redraw: () => this.redrawSoon(),
        });
      } catch (e) { console.warn(`track ${t.id}`, e); }
    }
  }

  dispose() { this.unFrames?.(); cancelAnimationFrame(this.rafDraw); }

  get fps() { return this.data?.timeline.fps || 30; }
  zoomIn() { this.setZoom(this.zoomIndex + 1, { t: this.lastT }); }
  zoomOut() { this.setZoom(this.zoomIndex - 1, { t: this.lastT }); }

  #timeAt(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((clientX - r.left) / r.width) * this.duration));
  }

  #pieceAt(t) { return this.data?.pieces.find((p) => t >= p.start && t < p.end) || this.data?.pieces[this.data.pieces.length - 1]; }

  #pct(t) { return `${(t / this.duration) * 100}%`; }

  #showHover(t) {
    this.hover.textContent = formatTimecode(t, this.fps, { short: this.duration < 3600 });
    this.hover.style.left = this.#pct(t);
    // keep the label inside the strip at both ends, or it widens the scroll area
    const r = t / this.duration;
    this.hover.style.transform = r > 0.97 ? 'translateX(-100%)' : r < 0.03 ? 'none' : '';
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
      t = Math.min(hi, Math.max(lo, Math.round(this.#timeAt(ev.clientX) * this.fps) / this.fps));
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

  /** Change zoom; keeps `anchor.t` under `anchor.clientX` (or centred) so the view does not jump. */
  setZoom(i, anchor = null) {
    const prev = this.zoomIndex;
    this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, i));
    if (this.zoomIndex === prev && anchor) return;
    const z = ZOOMS[this.zoomIndex];
    this.inner.style.width = `${z * 100}%`;
    this.zoomLabel.textContent = `${z}×`;
    const t = anchor?.t ?? this.lastT;
    const w = this.inner.clientWidth;
    const viewX = anchor?.clientX != null ? anchor.clientX - this.scroll.getBoundingClientRect().left : this.scroll.clientWidth / 2;
    this.scroll.scrollLeft = (t / this.duration) * w - viewX;
    if (this.data) this.#renderRuler();
    this.#placeToolbar();
    this.#drawLanes();
  }

  /**
   * @param {{timeline, pieces, marks, selection, anchorsG:number[], ticks:number[]}} d
   *   pieces/marks from core/cuts.js (marks sorted), ticks = where lossless cuts really land
   */
  render(d) {
    this.data = d;
    this.duration = Math.max(1, d.timeline.duration);
    const sel = d.selection || {};
    const files = d.timeline.files.length > 1 ? d.timeline.files.map((f, i) => h('div.tl-file', { style: { left: this.#pct(f.start), width: this.#pct(f.duration) } },
      h('span.tl-file-name', `ไฟล์ ${i + 1}`))) : [];
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
    this.#drawLanes();
  }

  #renderRuler() {
    const width = this.inner.clientWidth || 800;
    const secPerPx = this.duration / width;
    const frame = 1 / this.fps;
    const steps = [frame, ...TICKS.filter((t) => t > frame)];
    const step = steps.find((t) => t / secPerPx >= 90) || 3600;
    // only the visible stretch (plus one screen either side) gets tick labels
    const view = this.scroll.clientWidth || width;
    const from = Math.max(0, (this.scroll.scrollLeft - view) * secPerPx);
    const to = Math.min(this.duration, (this.scroll.scrollLeft + 2 * view) * secPerPx);
    const ticks = [];
    const short = this.duration < 3600;
    for (let k = Math.floor(from / step); k * step <= to + 1e-9; k++) {
      const t = k * step;
      const label = step < 1 ? formatTimecode(t, this.fps, { short }) : formatTime(t, { short });
      ticks.push(h('span.tl-tick', { style: { left: this.#pct(t) } }, label));
    }
    clear(this.ruler, ticks);
  }

  /** Float `el` under time t (or hide when el is null). */
  showToolbar(el, t) {
    clear(this.toolbarSlot);
    this.toolbar = el ? { el, t } : null;
    if (!el) return;
    this.toolbarSlot.append(el);
    el.style.left = this.#pct(t);
    requestAnimationFrame(() => this.#placeToolbar());
  }

  /** Keep the floating bar inside the visible part of the strip. */
  #placeToolbar() {
    if (!this.toolbar) return;
    const { el, t } = this.toolbar;
    const w = el.offsetWidth;
    const innerW = this.inner.clientWidth;
    const lo = this.scroll.scrollLeft + w / 2 + 4;
    const hi = this.scroll.scrollLeft + this.scroll.clientWidth - w / 2 - 4;
    const x = (t / this.duration) * innerW;
    el.style.left = `${Math.max(lo, Math.min(hi, x))}px`;
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

  resize() { if (this.data) { this.#renderRuler(); this.#drawLanes(); } }
}
