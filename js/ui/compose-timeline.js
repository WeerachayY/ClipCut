// Timeline of step "แต่ง", on the program clock (what the viewer gets, after cuts and speed changes).
// Rows top to bottom: ruler, overlay tracks (text, pictures, video; the top track is drawn on top),
// the main track (the edited recording, piece by piece, with speed badges), then music and voice tracks.
// Everything is painted on one canvas covering the visible stretch, so any zoom costs the same.
import { h } from './dom.js';
import { formatTime } from '../core/time.js';
import { locate } from '../core/program.js';
import { tracksOf, DUCK } from '../core/compose.js';
import { speedLabel, isNormal } from '../core/speed.js';

const RULER = 24;
const TRACK = 34;
const HINT = 28;
const GAP = 4;
const EDGE = 7; // px: grab zone of a clip's edge
const SNAP = 8; // px
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const KIND_COLOR = { text: '#7759D0', image: '#2B8A7C', video: '#3B6CC2', audio: '#3D9353' };
const KIND_LABEL = { text: 'ข้อความ', image: 'ภาพ', video: 'วิดีโอ', audio: 'เสียง' };

export class ComposeTimeline {
  /**
   * @param {object} cb
   * @param {(T:number)=>void} cb.onSeek
   * @param {(sel:{type:'clip',id}|{type:'piece',key}|null)=>void} cb.onSelect
   * @param {(id, start, trackId)=>void} cb.onMove         live while dragging
   * @param {(id, side:'start'|'end', t)=>void} cb.onTrim  live while dragging
   * @param {()=>void} cb.onDragEnd
   * @param {(files:File[], T:number)=>void} cb.onDropFiles
   */
  constructor(cb) {
    this.cb = cb;
    this.zoom = 1;
    this.data = null;
    this.T = 0;
    this.follow = true;
    this.rows = [];
    this.thumbs = new Map();

    this.canvas = h('canvas.ctl-canvas');
    this.playhead = h('div.ctl-playhead', h('span.ctl-playhead-cap'));
    this.guide = h('div.ctl-guide');
    this.inner = h('div.ctl-inner', this.canvas, this.guide, this.playhead);
    this.scroll = h('div.ctl-scroll', this.inner);
    this.zoomLabel = h('span.tl-zoom-label', '1×');
    this.el = h('div.ctl', this.scroll);
    this.zoomBox = h('span.tl-zoom',
      h('button.ghost.small', { type: 'button', onclick: () => this.zoomOut(), 'aria-label': 'ซูมออก', 'data-tip': 'ซูมออก · Ctrl −' }, '−'),
      this.zoomLabel,
      h('button.ghost.small', { type: 'button', onclick: () => this.zoomIn(), 'aria-label': 'ซูมเข้า', 'data-tip': 'ซูมเข้า · Ctrl + (หรือ Ctrl + ล้อเมาส์)' }, '+'),
      h('button.ghost.small', { type: 'button', onclick: () => this.setZoom(1), 'data-tip': 'พอดีจอ · Ctrl 0' }, 'พอดีจอ'));

    this.inner.addEventListener('pointerdown', (e) => this.#down(e));
    this.inner.addEventListener('pointermove', (e) => { if (!this.drag) this.#hover(e); });
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.5 : 1 / 1.5), { t: this.#timeAt(e.clientX), clientX: e.clientX });
    }, { passive: false });
    let raf = 0;
    this.scroll.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.draw()); });
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.stopPropagation(); this.el.classList.add('drop'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.remove('drop');
      this.cb.onDropFiles([...e.dataTransfer.files], this.#timeAt(e.clientX));
    });
  }

  /**
   * @param {object} d
   * @param {object} d.program
   * @param {object} d.compose
   * @param {import('../render/assets.js').AssetLibrary} d.assets
   * @param {import('../media/frames.js').FrameSource|null} d.frames
   * @param {{rate,peaks}|null} d.layer      waveform of the recordings (source time)
   * @param {'video'|'audio'} d.kind
   * @param {object|null} d.selection
   */
  set(d) {
    if (d.frames !== this.data?.frames) { this.unFrames?.(); this.unFrames = d.frames?.onFrame(() => this.redrawSoon()); }
    this.data = d;
    this.#layout();
    this.redrawSoon();
  }

  get kind() { return this.data?.kind || 'video'; }
  get mainH() { return this.kind === 'audio' ? 72 : 64; }
  /** Length shown: the program, or further when a clip runs past its end. */
  get length() {
    const d = this.data;
    if (!d) return 1;
    if (this.drag && this.dragLen) return this.dragLen; // steady scale while a clip is dragged past the end
    const end = Math.max(d.program.duration, ...d.compose.clips.map((c) => c.start + c.duration));
    return Math.max(1, end + Math.max(2, end * 0.04));
  }
  get pps() { return Math.max(0.0001, ((this.scroll.clientWidth || 800) - 2) / this.length) * this.zoom; }

  #layout() {
    const d = this.data;
    const rows = [{ type: 'ruler', y: 0, h: RULER }];
    let y = RULER + GAP;
    const add = (r) => { rows.push({ ...r, y }); y += r.h + GAP; };
    const over = tracksOf(d.compose, 'overlay');
    if (d.kind !== 'audio') {
      if (!over.length) add({ type: 'hint', lane: 'overlay', h: HINT, text: 'ข้อความ hook · โลโก้ · วิดีโอซ้อน: กดปุ่มด้านบน หรือลากไฟล์ภาพ/วิดีโอมาวางที่นี่' });
      over.forEach((t) => add({ type: 'track', lane: 'overlay', id: t.id, h: TRACK }));
    }
    add({ type: 'main', h: this.mainH });
    const aud = tracksOf(d.compose, 'audio');
    aud.forEach((t) => add({ type: 'track', lane: 'audio', id: t.id, h: TRACK }));
    if (!aud.length) add({ type: 'hint', lane: 'audio', h: HINT, text: 'เพลงประกอบ · เสียงบรรยาย: กดปุ่ม “เพลง / เสียง” หรือลากไฟล์เสียงมาวางที่นี่' });
    this.rows = rows;
    this.height = y;
    this.inner.style.height = `${y}px`;
    this.inner.style.width = `${Math.ceil(this.length * this.pps)}px`;
  }

  resize() { if (this.data) { this.#layout(); this.draw(); this.setTime(this.T); } }

  setZoom(z, { t = this.T, clientX = null } = {}) {
    const old = this.scroll.getBoundingClientRect();
    const anchor = clientX == null ? (t * this.pps - this.scroll.scrollLeft) : clientX - old.left;
    this.zoom = Math.max(1, Math.min(4000, z));
    this.zoomLabel.textContent = `${this.zoom < 10 ? +this.zoom.toFixed(1) : Math.round(this.zoom)}×`;
    if (!this.data) return;
    this.#layout();
    this.scroll.scrollLeft = Math.max(0, t * this.pps - anchor);
    this.draw();
    this.setTime(this.T);
  }
  zoomIn() { this.setZoom(this.zoom * 2); }
  zoomOut() { this.setZoom(this.zoom / 2); }

  /** Move the playhead; while following, keep it in view. */
  setTime(T, { playing = false } = {}) {
    this.T = T;
    const x = T * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    const sl = this.scroll.scrollLeft;
    const vw = this.scroll.clientWidth;
    if (this.follow && !this.drag && (x < sl || x > sl + vw - 30)) this.scroll.scrollLeft = playing ? x - 40 : x - vw / 2;
  }

  redrawSoon() {
    if (this.rafDraw) return;
    this.rafDraw = requestAnimationFrame(() => { this.rafDraw = 0; this.draw(); });
  }

  #timeAt(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / this.pps);
  }

  #rowAt(clientY) {
    const y = clientY - this.inner.getBoundingClientRect().top;
    return this.rows.find((r) => y >= r.y - GAP / 2 && y < r.y + r.h + GAP / 2) || null;
  }

  // ---------- picking and dragging ----------
  #clipAt(row, T) {
    if (row?.type !== 'track') return null;
    return this.data.compose.clips.find((c) => c.track === row.id && T >= c.start && T < c.start + c.duration) || null;
  }

  #edgeOf(c, T) {
    const px = (T - c.start) * this.pps;
    const w = c.duration * this.pps;
    if (w > EDGE * 3 && px <= EDGE) return 'start';
    if (w > EDGE * 3 && w - px <= EDGE) return 'end';
    if (px <= Math.min(EDGE, w / 3)) return 'start';
    if (w - px <= Math.min(EDGE, w / 3)) return 'end';
    return null;
  }

  #hover(e) {
    const T = this.#timeAt(e.clientX);
    const row = this.#rowAt(e.clientY);
    const c = this.#clipAt(row, T);
    this.inner.style.cursor = c ? (this.#edgeOf(c, T) ? 'ew-resize' : 'grab') : row?.type === 'ruler' ? 'col-resize' : 'default';
  }

  /** Times worth snapping to: playhead, file and piece boundaries, other clips' edges. */
  #snapPoints(ignore) {
    const d = this.data;
    const pts = [0, this.T, d.program.duration];
    for (const p of d.program.parts) {
      pts.push(p.start, p.start + p.duration);
      let key = null;
      for (const s of p.segments) { if (s.pieceKey !== key) pts.push(s.progStart); key = s.pieceKey; }
    }
    for (const c of d.compose.clips) if (c.id !== ignore) pts.push(c.start, c.start + c.duration);
    return pts;
  }

  #snap(t, pts) {
    let best = null;
    const lim = SNAP / this.pps;
    for (const p of pts) { const dd = Math.abs(p - t); if (dd <= lim && (!best || dd < best.d)) best = { d: dd, p }; }
    return best ? best.p : null;
  }

  #showGuide(t) {
    if (t == null) { this.guide.classList.remove('on'); return; }
    this.guide.style.transform = `translateX(${t * this.pps}px)`;
    this.guide.classList.add('on');
  }

  #down(e) {
    if (e.button !== 0 || !this.data) return;
    const T = this.#timeAt(e.clientX);
    const row = this.#rowAt(e.clientY);
    const finish = (fn) => {
      this.inner.setPointerCapture(e.pointerId);
      const move = (ev) => fn(ev);
      const up = () => {
        this.inner.removeEventListener('pointermove', move);
        this.inner.removeEventListener('pointerup', up);
        this.inner.removeEventListener('pointercancel', up);
        const was = this.drag;
        this.drag = null;
        this.dragLen = 0;
        this.#layout();
        this.#showGuide(null);
        if (was?.moved) this.cb.onDragEnd();
        this.redrawSoon();
      };
      this.inner.addEventListener('pointermove', move);
      this.inner.addEventListener('pointerup', up);
      this.inner.addEventListener('pointercancel', up);
    };

    const c = this.#clipAt(row, T);
    this.dragLen = this.length;
    if (c) {
      e.preventDefault();
      this.cb.onSelect({ type: 'clip', id: c.id });
      const edge = this.#edgeOf(c, T);
      const pts = this.#snapPoints(c.id);
      this.drag = { id: c.id, edge, grab: T - c.start, x0: e.clientX, moved: false };
      finish((ev) => {
        const dr = this.drag;
        if (!dr) return;
        if (!dr.moved && Math.abs(ev.clientX - dr.x0) < 3 && !(dr.edge == null && this.#rowAt(ev.clientY) !== row)) return;
        dr.moved = true;
        const t = this.#timeAt(ev.clientX);
        const cur = this.data.compose.clips.find((x) => x.id === dr.id);
        if (!cur) return;
        if (dr.edge) {
          const s = this.#snap(t, pts);
          this.#showGuide(s);
          this.cb.onTrim(dr.id, dr.edge, s ?? t);
        } else {
          let start = t - dr.grab;
          const s1 = this.#snap(start, pts);
          const s2 = this.#snap(start + cur.duration, pts);
          if (s1 != null && (s2 == null || Math.abs(s1 - start) <= Math.abs(s2 - start - cur.duration))) { start = s1; this.#showGuide(s1); }
          else if (s2 != null) { start = s2 - cur.duration; this.#showGuide(s2); }
          else this.#showGuide(null);
          const r = this.#rowAt(ev.clientY);
          const lane = this.rows.find((x) => x.id === cur.track)?.lane;
          this.cb.onMove(dr.id, Math.max(0, start), r?.type === 'track' && r.lane === lane ? r.id : null);
        }
      });
      return;
    }
    if (row?.type === 'main') {
      const loc = locate(this.data.program, T);
      if (loc && T <= this.data.program.duration) this.cb.onSelect(loc.seg.pieceKey ? { type: 'piece', key: loc.seg.pieceKey } : null);
      else this.cb.onSelect(null);
    } else if (row?.type !== 'ruler') this.cb.onSelect(null);
    // scrub
    this.drag = { scrub: true };
    this.cb.onSeek(Math.min(T, this.data.program.duration));
    finish((ev) => this.cb.onSeek(Math.min(this.#timeAt(ev.clientX), this.data.program.duration)));
  }

  // ---------- drawing ----------
  #colors() {
    const cs = getComputedStyle(this.el);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: v('--panel'), lane: v('--talk'), laneAlt: v('--talk-2'), rule: v('--rule'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'),
      accent: v('--accent'), wave: v('--wave'), waveBg: v('--wave-bg'), check: v('--check'), font: v('--font'), mono: v('--mono'),
    };
  }

  draw() {
    const d = this.data;
    if (!d) return;
    const vw = this.scroll.clientWidth;
    if (!vw) return;
    const H = this.height;
    const dpr = window.devicePixelRatio || 1;
    const left = this.scroll.scrollLeft;
    const cw = Math.round(vw * dpr);
    const ch = Math.round(H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    Object.assign(this.canvas.style, { width: `${vw}px`, height: `${H}px`, transform: `translateX(${left}px)` });
    const g = this.canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = this.#colors();
    const pps = this.pps;
    const t0 = left / pps;
    const t1 = (left + vw) / pps;
    const X = (t) => (t - t0) * pps;
    g.clearRect(0, 0, vw, H);
    g.textBaseline = 'middle';

    for (const r of this.rows) {
      if (r.type === 'ruler') this.#ruler(g, r, C, t0, t1, X, vw);
      else if (r.type === 'hint') {
        g.fillStyle = C.bg;
        g.fillRect(0, r.y, vw, r.h);
        g.setLineDash([4, 4]);
        g.strokeStyle = C.rule;
        g.strokeRect(0.5, r.y + 0.5, vw - 1, r.h - 1);
        g.setLineDash([]);
        g.fillStyle = C.ink3;
        g.font = `12px ${C.font}`;
        g.textAlign = 'left';
        g.fillText(r.text, 10, r.y + r.h / 2);
      } else if (r.type === 'main') this.#main(g, r, C, t0, t1, X, vw);
      else this.#track(g, r, C, t0, t1, X, vw);
    }
    // file boundaries across every row
    g.fillStyle = C.ink;
    for (const p of d.program.parts.slice(1)) {
      const x = Math.round(X(p.start));
      if (x < -2 || x > vw + 2) continue;
      g.fillRect(x - 1, RULER, 2, H - RULER);
    }
    // beyond the end of the program: dimmed
    const xe = X(d.program.duration);
    if (xe < vw) { g.fillStyle = 'rgba(128,128,128,0.16)'; g.fillRect(Math.max(0, xe), RULER, vw - Math.max(0, xe), H - RULER); }
  }

  #ruler(g, r, C, t0, t1, X, vw) {
    const d = this.data;
    g.fillStyle = C.bg;
    g.fillRect(0, r.y, vw, r.h);
    g.fillStyle = C.rule;
    g.fillRect(0, r.y + r.h - 1, vw, 1);
    const step = TICKS.find((s) => s * this.pps >= 80) || 3600;
    const short = this.length < 3600;
    g.font = `11px ${C.mono}`;
    g.textAlign = 'left';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(X(t)) + 0.5;
      g.fillStyle = C.ink3;
      g.fillRect(x, r.y + r.h - 8, 1, 7);
      g.fillStyle = C.ink2;
      g.fillText(formatTime(t, { short, decimals: step < 1 ? 1 : 0 }), x + 4, r.y + 9);
      for (let k = 1; k < 5; k++) { const xm = Math.round(X(t + (step * k) / 5)) + 0.5; g.fillStyle = C.rule; g.fillRect(xm, r.y + r.h - 4, 1, 3); }
    }
    // file labels
    if (d.program.parts.length > 1) {
      g.font = `600 11px ${C.font}`;
      d.program.parts.forEach((p, i) => {
        const x = X(p.start);
        if (x > vw || X(p.start + p.duration) < 0) return;
        const label = `ไฟล์ ${i + 1}${p.label ? ` · ${p.label}` : ''}`;
        const w = g.measureText(label).width + 10;
        const xx = Math.max(0, x + 2);
        g.fillStyle = C.ink;
        g.fillRect(xx, r.y + 13, w, 11);
        g.fillStyle = C.bg;
        g.fillText(label, xx + 5, r.y + 18.5);
      });
    }
  }

  #main(g, r, C, t0, t1, X, vw) {
    const d = this.data;
    const { program } = d;
    g.save();
    g.beginPath();
    g.rect(0, r.y, vw, r.h);
    g.clip();
    g.fillStyle = C.lane;
    g.fillRect(0, r.y, Math.min(vw, X(program.duration)), r.h);

    const video = d.kind !== 'audio' && d.frames;
    const waveTop = video ? r.y + r.h - 22 : r.y;
    const waveH = video ? 22 : r.h;

    // stills: one slot after another on the program clock, each showing the recording at its middle
    if (video) {
      const fh = r.h - 22;
      const w = Math.max(24, Math.round(fh * d.frames.aspect()));
      const slot = w / this.pps;
      const wanted = [];
      for (let k = Math.max(0, Math.floor(t0 / slot)); k * slot < Math.min(t1, program.duration); k++) {
        const a = k * slot;
        const loc = locate(program, Math.min(program.duration - 1e-3, a + slot / 2));
        if (!loc) continue;
        const x = Math.round(X(a));
        const bmp = d.frames.get(loc.src);
        const shown = bmp || d.frames.nearest(loc.src, slot * 3 * (loc.speed || 1));
        if (shown) g.drawImage(shown, x, r.y, w, fh);
        else { g.fillStyle = C.laneAlt; g.fillRect(x, r.y, w - 1, fh); }
        if (!bmp) wanted.push({ t: loc.src, tol: (slot * (loc.speed || 1)) / 2 });
        g.fillStyle = C.bg;
        g.fillRect(x + w - 1, r.y, 1, fh);
      }
      const mid = (t0 + t1) / 2;
      wanted.sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid));
      d.frames.want(wanted);
    }

    // loudness, read through the speed changes (one source stretch per pixel)
    g.fillStyle = C.waveBg;
    g.fillRect(0, waveTop, Math.min(vw, X(program.duration)), waveH);
    const L = d.layer;
    if (L?.peaks) {
      g.fillStyle = C.wave;
      const mid = waveTop + waveH / 2;
      const half = waveH / 2 - 1;
      let prev = locate(program, Math.max(0, t0));
      for (let x = 0; x < vw; x++) {
        const T = t0 + (x + 1) / this.pps;
        if (t0 + x / this.pps >= program.duration) break;
        const loc = locate(program, Math.min(T, program.duration));
        if (!loc || !prev) { prev = loc; continue; }
        let a = prev.src;
        let b = loc.src;
        if (loc.seg !== prev.seg || b < a) { a = loc.src; b = loc.src + 1 / this.pps; }
        const i0 = Math.max(0, Math.floor(a * L.rate));
        const i1 = Math.min(L.peaks.length, Math.max(i0 + 1, Math.ceil(b * L.rate)), i0 + 4000);
        let m = 0;
        for (let i = i0; i < i1; i++) if (L.peaks[i] > m) m = L.peaks[i];
        const hh = Math.max(0.5, (m / 255) * half);
        g.fillRect(x, mid - hh, 1, hh * 2);
        prev = loc;
      }
    }

    // pieces: boundaries, speed badges and the speed line, the selected one outlined
    const groups = [];
    for (const p of program.parts) {
      for (const s of p.segments) {
        const last = groups[groups.length - 1];
        if (last && last.key === s.pieceKey && last.part === p.index && Math.abs(last.end - s.progStart) < 1e-6) { last.end = s.progStart + s.duration; last.segs.push(s); } else groups.push({ key: s.pieceKey, part: p.index, start: s.progStart, end: s.progStart + s.duration, segs: [s] });
      }
    }
    const sel = d.selection?.type === 'piece' ? d.selection.key : null;
    g.font = `600 11px ${C.font}`;
    g.textAlign = 'left';
    for (const gr of groups) {
      const xa = X(gr.start);
      const xb = X(gr.end);
      if (xb < 0 || xa > vw) continue;
      g.fillStyle = C.bg;
      g.fillRect(Math.round(xa), r.y, 2, r.h);
      const sp = d.compose.speed?.[gr.key];
      if (sp && !isNormal(sp)) {
        // speed over the piece: a line from 0.1× (bottom) to 10× (top), log scale
        const s0 = gr.segs[0];
        const yOf = (v) => r.y + r.h - 4 - ((Math.log10(v) + 1) / 2) * (r.h - 8);
        g.strokeStyle = '#FFD60A';
        g.lineWidth = 2;
        g.beginPath();
        for (let x = Math.max(0, Math.floor(xa)); x <= Math.min(vw, Math.ceil(xb)); x += 2) {
          const T = t0 + x / this.pps;
          const seg = gr.segs.find((s) => T >= s.progStart && T <= s.progStart + s.duration + 1e-6) || s0;
          const inPiece = seg.map.toSrc(seg.outOffset + Math.max(0, T - seg.progStart));
          const y = yOf(Math.max(0.1, Math.min(10, seg.map.speed(inPiece))));
          if (x <= Math.max(0, Math.floor(xa))) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        const label = speedLabel(sp);
        const w = g.measureText(label).width + 12;
        const bx = Math.max(xa + 4, 4);
        if (bx + w < xb - 2) {
          g.fillStyle = 'rgba(0,0,0,0.72)';
          g.fillRect(bx, r.y + 4, w, 17);
          g.fillStyle = '#FFD60A';
          g.fillText(label, bx + 6, r.y + 12.5);
        }
      }
      if (gr.key && gr.key === sel) {
        g.strokeStyle = C.accent;
        g.lineWidth = 3;
        g.strokeRect(Math.max(-2, xa) + 1.5, r.y + 1.5, Math.min(vw + 4, xb) - Math.max(-2, xa) - 3, r.h - 3);
      }
    }
    g.restore();
  }

  #track(g, r, C, t0, t1, X, vw) {
    const d = this.data;
    g.fillStyle = C.bg;
    g.fillRect(0, r.y, vw, r.h);
    g.fillStyle = C.rule;
    g.fillRect(0, r.y + r.h - 1, vw, 1);
    const selId = d.selection?.type === 'clip' ? d.selection.id : null;
    for (const c of d.compose.clips) {
      if (c.track !== r.id) continue;
      const xa = X(c.start);
      const xb = X(c.start + c.duration);
      if (xb < 0 || xa > vw) continue;
      const x = Math.max(-4, xa);
      const w = Math.min(vw + 4, xb) - x;
      const y = r.y + 2;
      const hh = r.h - 5;
      const col = KIND_COLOR[c.kind];
      g.save();
      g.beginPath();
      g.roundRect ? g.roundRect(x, y, w, hh, 5) : g.rect(x, y, w, hh);
      g.fillStyle = col;
      g.globalAlpha = 0.9;
      g.fill();
      g.globalAlpha = 1;
      g.clip();
      const a = c.asset ? d.assets.get(c.asset) : null;
      if (c.kind === 'audio' && a?.envelope) {
        // the sound itself, at its clip volume
        const env = a.envelope;
        const vol = Math.min(2, c.volume ?? 1);
        g.fillStyle = 'rgba(255,255,255,0.38)';
        const mid = y + hh / 2;
        for (let px = Math.max(0, Math.floor(xa)); px < Math.min(vw, xb); px++) {
          const tm = (c.offset || 0) + (t0 + px / this.pps - c.start);
          const i = Math.floor(tm * env.rate);
          const i1 = Math.max(i + 1, Math.floor((tm + 1 / this.pps) * env.rate));
          let m = 0;
          for (let k = Math.max(0, i); k < Math.min(env.peaks.length, i1, i + 2000); k++) if (env.peaks[k] > m) m = env.peaks[k];
          const v = Math.max(0.5, (m / 255) * (hh / 2 - 2) * Math.min(1, vol));
          g.fillRect(px, mid - v, 1, v * 2);
        }
      }
      if (c.kind === 'image' && a) {
        const bmp = this.thumbs.get(c.asset);
        if (bmp) { const tw = (hh * a.width) / a.height; g.drawImage(bmp, xa + 3, y + 2, Math.min(tw, 60), hh - 4); }
        else if (!this.thumbs.has(c.asset)) { this.thumbs.set(c.asset, null); d.assets.bitmap(c.asset).then((b) => { this.thumbs.set(c.asset, b); this.redrawSoon(); }).catch(() => {}); }
      }
      // fades
      g.fillStyle = 'rgba(0,0,0,0.28)';
      if (c.fadeIn > 0) { g.beginPath(); g.moveTo(xa, y); g.lineTo(xa + c.fadeIn * this.pps, y); g.lineTo(xa, y + hh); g.fill(); }
      if (c.fadeOut > 0) { g.beginPath(); g.moveTo(xb, y); g.lineTo(xb - c.fadeOut * this.pps, y); g.lineTo(xb, y + hh); g.fill(); }
      // label
      const name = c.kind === 'text' ? String(c.text || '').split('\n')[0] : a ? a.name : `${KIND_LABEL[c.kind]} (หาไฟล์ไม่เจอ)`;
      const tags = [];
      if (c.kind === 'audio' && DUCK[c.duck]) tags.push('ลดเสียงเมื่อพูด');
      if (c.kind === 'video' && !(c.volume > 0)) tags.push('ปิดเสียง');
      g.fillStyle = '#fff';
      g.font = `600 12px ${C.font}`;
      g.textAlign = 'left';
      const tx = Math.max(xa, 0) + (c.kind === 'image' && a ? Math.min(60, (hh * a.width) / a.height) + 8 : 7);
      g.fillText(`${c.kind === 'text' ? 'T  ' : ''}${name}${tags.length ? `  ·  ${tags.join(' · ')}` : ''}`, tx, y + hh / 2 + 0.5);
      g.restore();
      if (c.id === selId) {
        g.strokeStyle = C.ink;
        g.lineWidth = 2;
        g.strokeRect(x + 1, y + 1, w - 2, hh - 2);
        g.fillStyle = C.ink;
        g.fillRect(xa, y, 5, hh);
        g.fillRect(xb - 5, y, 5, hh);
      }
    }
  }

  dispose() { this.unFrames?.(); cancelAnimationFrame(this.rafDraw); }
}
