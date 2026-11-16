// Live preview of the program (core/program.js) for step "แต่ง". The recordings play in hidden <video>
// elements at each piece's speed (the video element is the clock, so sound and picture stay together);
// every frame is drawn on a canvas by render/draw.js, the same code the export uses, so what is seen here
// is what will be exported. Music and overlay videos play alongside and follow the clock; music is ducked
// under speech from the main track's loudness, like the export (an approximation, close enough to judge).
import { locate } from '../core/program.js';
import { drawFrame } from '../render/draw.js';
import { drawOrder, activeAt, DUCK } from '../core/compose.js';
import { ensureFonts } from '../render/text.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const RATE_MIN = 0.0625; // what browsers allow for playbackRate
const RATE_MAX = 16;
const SPEECH = 40;       // waveform level (0–255, loud speech ≈ 230) that counts as someone speaking

export class ProgramPlayer extends EventTarget {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas
   * @param {HTMLElement} o.host      hidden box for the media elements
   * @param {string[]} o.urls         recordings, by fileIndex
   * @param {boolean} o.audioOnly
   */
  constructor({ canvas, host, urls, audioOnly = false }) {
    super();
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.host = host;
    this.audioOnly = audioOnly;
    this.program = { parts: [], duration: 0 };
    this.compose = { tracks: [], clips: [], speed: {}, mainVolume: 1 };
    this.assets = null;
    this.layer = null;
    this.T = 0;
    this.playing = false;
    this.cur = null;     // {k: index into this.segs}
    this.segs = [];
    this.hits = [];
    this.clipEls = new Map(); // clip id -> {el, asset}
    this.images = new Map();  // asset id -> HTMLImageElement
    this.duck = new Map();    // clip id -> current gain
    this.speechAt = -1e9;
    this.raf = 0;
    this.lastTick = 0;

    this.mains = urls.map((url) => {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.src = url;
      v.addEventListener('seeked', () => { if (!this.playing) this.draw(); });
      v.addEventListener('loadeddata', () => { this.#emit('size'); if (!this.playing) this.draw(); });
      host.append(v);
      return v;
    });
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Size of the main picture (first recording that knows it). */
  get size() {
    const v = this.mains.find((m) => m.videoWidth);
    return v ? { width: v.videoWidth, height: v.videoHeight } : null;
  }

  get duration() { return this.program.duration; }

  setProgram(program) {
    const was = this.playing;
    if (was) this.#halt();
    this.program = program;
    this.segs = program.parts.flatMap((p) => p.segments);
    this.T = clamp(this.T, 0, program.duration);
    this.#enter(this.T);
    if (was) this.play(); else this.draw();
  }

  /** The composition and the media it uses (render/assets.js). Waveform layer of the main track for ducking. */
  setCompose(compose, assets, layer = null) {
    this.compose = compose;
    this.assets = assets;
    this.layer = layer;
    const keep = new Set();
    for (const c of compose.clips) {
      if (c.kind === 'image') { this.#image(c.asset); continue; }
      if (c.kind !== 'video' && c.kind !== 'audio') continue;
      const a = assets.get(c.asset);
      if (!a) continue;
      keep.add(c.id);
      let rec = this.clipEls.get(c.id);
      if (rec && rec.asset !== c.asset) { this.#dropEl(c.id); rec = null; }
      if (!rec) {
        const el = document.createElement(c.kind === 'video' ? 'video' : 'audio');
        el.preload = 'auto';
        el.src = a.url;
        if (c.kind === 'video') { el.playsInline = true; el.addEventListener('seeked', () => { if (!this.playing) this.draw(); }); el.addEventListener('loadeddata', () => { if (!this.playing) this.draw(); }); }
        this.host.append(el);
        this.clipEls.set(c.id, { el, asset: c.asset });
      }
    }
    for (const id of [...this.clipEls.keys()]) if (!keep.has(id)) this.#dropEl(id);
    ensureFonts(compose.clips).then(() => { if (!this.playing) this.draw(); });
    this.#syncClips(false);
    if (!this.playing) this.draw();
  }

  #dropEl(id) {
    const r = this.clipEls.get(id);
    if (!r) return;
    r.el.pause();
    r.el.removeAttribute('src');
    r.el.load();
    r.el.remove();
    this.clipEls.delete(id);
  }

  #image(id) {
    if (!id || this.images.has(id) || !this.assets?.get(id)) return;
    const img = new Image();
    img.onload = () => { if (!this.playing) this.draw(); };
    img.src = this.assets.get(id).url;
    this.images.set(id, img);
  }

  // ---------- clock ----------
  #segIndexAt(T) {
    const s = this.segs;
    if (!s.length) return -1;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].progStart <= T + 1e-9) lo = m; else hi = m - 1; }
    return lo;
  }

  /** Point the right recording at program time T (seeks; does not start playing). */
  #enter(T) {
    const k = this.#segIndexAt(T);
    if (k < 0) { this.cur = null; return; }
    const seg = this.segs[k];
    const loc = locate(this.program, T);
    this.cur = { k };
    const el = this.mains[seg.fileIndex];
    for (const m of this.mains) if (m !== el && !m.paused) m.pause();
    if (el && loc) {
      const local = loc.local;
      if (Math.abs(el.currentTime - local) > 0.002) el.currentTime = local;
      this.#rate(el, seg, loc.src - seg.pieceStart);
    }
  }

  #rate(el, seg, inPiece) {
    const r = clamp(seg.map.speed(inPiece), RATE_MIN, RATE_MAX);
    if (Math.abs(el.playbackRate - r) > 0.005) el.playbackRate = r;
    const keep = !seg.map.pitch;
    if (el.preservesPitch !== keep) el.preservesPitch = keep;
    el.volume = clamp(this.compose.mainVolume ?? 1, 0, 1);
  }

  get main() { return this.cur ? this.mains[this.segs[this.cur.k].fileIndex] : null; }

  seek(T) {
    this.T = clamp(T, 0, this.program.duration);
    this.speechAt = -1e9;
    this.#enter(this.T);
    if (this.playing) this.main?.play().catch(() => {});
    this.#syncClips(this.playing, true);
    if (!this.playing) this.draw();
    this.#emit('time', { t: this.T });
  }

  play() {
    if (!this.segs.length) return;
    if (this.T >= this.program.duration - 0.04) this.seek(0);
    this.playing = true;
    this.#enter(this.T);
    this.main?.play().catch(() => {});
    this.lastTick = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = () => { if (!this.playing) return; this.#tick(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    this.#emit('state');
  }

  #halt() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const m of this.mains) m.pause();
    for (const { el } of this.clipEls.values()) el.pause();
  }

  pause() {
    if (!this.playing) return;
    this.#halt();
    this.draw();
    this.#emit('state');
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  #tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (!this.cur) { this.pause(); return; }
    let seg = this.segs[this.cur.k];
    const el = this.mains[seg.fileIndex];
    const src = seg.srcStart + (el.currentTime - seg.inpoint);
    if (src >= seg.srcEnd - 1e-3 || el.ended) {
      const next = this.segs[this.cur.k + 1];
      if (!next) { this.#halt(); this.T = this.program.duration; this.draw(); this.#emit('time', { t: this.T }); this.#emit('state'); return; }
      if (next.fileIndex === seg.fileIndex && Math.abs(next.inpoint - el.currentTime) < 0.06 && !el.ended) {
        this.cur = { k: this.cur.k + 1 }; // carries straight on (only the speed changes)
      } else {
        this.#enter(next.progStart);
        this.main?.play().catch(() => {});
      }
      seg = this.segs[this.cur.k];
      this.T = seg.progStart;
    } else {
      const inPiece = src - seg.pieceStart;
      this.T = clamp(seg.progStart + seg.map.toOut(inPiece) - seg.outOffset, seg.progStart, seg.progStart + seg.duration);
      this.#rate(el, seg, inPiece);
    }
    this.#speech(src);
    this.#syncClips(true, false, dt);
    this.draw();
    this.#emit('time', { t: this.T });
  }

  /** Is someone speaking at source time g (from the main waveform)? Remembers when speech was last heard. */
  #speech(g) {
    const L = this.layer;
    if (!L?.peaks) return;
    const i0 = Math.max(0, Math.floor((g - 0.02) * L.rate));
    const i1 = Math.min(L.peaks.length, Math.ceil((g + 0.02) * L.rate));
    for (let i = i0; i < i1; i++) if (L.peaks[i] > SPEECH) { this.speechAt = this.T; return; }
  }

  // ---------- music and overlay videos ----------
  #syncClips(playing, hard = false, dt = 0) {
    const T = this.T;
    for (const c of this.compose.clips) {
      const rec = this.clipEls.get(c.id);
      if (!rec) continue;
      const { el } = rec;
      const on = T >= c.start - 1e-3 && T < c.start + c.duration - 1e-3;
      if (!on) { if (!el.paused) el.pause(); continue; }
      const t = T - c.start;
      const want = (c.offset || 0) + t;
      const tol = playing && !hard ? 0.3 : 0.03;
      if (Math.abs(el.currentTime - want) > tol && el.readyState >= 1) el.currentTime = want;
      if (playing && el.paused) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
      // level: clip volume × fades × ducking (the browser stops at 100%)
      let v = c.volume ?? 1;
      if (c.fadeIn > 0) v *= clamp(t / c.fadeIn, 0, 1);
      if (c.fadeOut > 0) v *= clamp((c.duration - t) / c.fadeOut, 0, 1);
      if (c.kind === 'audio' && DUCK[c.duck]) {
        const talking = T - this.speechAt < 0.4;
        const target = talking ? DUCK[c.duck].gain : 1;
        let gnow = this.duck.get(c.id) ?? 1;
        const tau = target < gnow ? 0.03 : 0.25;
        gnow += (target - gnow) * (dt > 0 ? clamp(dt / tau, 0, 1) : 1);
        this.duck.set(c.id, gnow);
        v *= gnow;
      }
      el.volume = clamp(v, 0, 1);
    }
  }

  // ---------- picture ----------
  /** Match the canvas to its box on screen (sharp on high-density screens, capped at 1920 wide). */
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(Math.min(1920, r.width * dpr));
    const h = Math.round(w * (r.height / r.width));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.draw();
  }

  draw() {
    const { canvas, g } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return;
    const T = this.T;
    const el = this.main;
    const main = !this.audioOnly && el && el.readyState >= 2 ? el : null;
    const clips = this.audioOnly ? [] : drawOrder(this.compose, activeAt(this.compose, T));
    const media = (c) => {
      const a = this.assets?.get(c.asset);
      if (!a) return null;
      if (c.kind === 'image') { const img = this.images.get(c.asset); return img?.complete && img.naturalWidth ? { src: img, w: a.width, h: a.height } : { src: null, w: a.width, h: a.height }; }
      const r = this.clipEls.get(c.id);
      return { src: r && r.el.readyState >= 2 ? r.el : null, w: a.width, h: a.height };
    };
    this.hits = drawFrame(g, W, H, { main, mainW: main?.videoWidth, mainH: main?.videoHeight, clips, media, T });
    this.#emit('draw');
  }

  dispose() {
    this.#halt();
    for (const id of [...this.clipEls.keys()]) this.#dropEl(id);
    for (const m of this.mains) { m.removeAttribute('src'); m.load(); m.remove(); }
  }
}
