// Still frames for the filmstrip track, decoded by the browser (hardware video decoder) from hidden
// <video> elements, one per file. Requests are served newest first, one at a time, and kept in a small
// LRU cache of ImageBitmaps. Times are global (timeline) seconds.
export class FrameSource {
  /** @param {{timeline, videos:{url:string}[], height?:number, max?:number}} o */
  constructor({ timeline, videos, height = 96, max = 360 }) {
    this.timeline = timeline;
    this.videos = videos;
    this.height = height;
    this.max = max;
    this.cache = new Map();     // key(ms) -> ImageBitmap
    this.wanted = new Map();    // key -> {t, tol}
    this.els = [];              // per file: {el, ready:Promise}
    this.aspects = [];
    this.busy = false;
    this.listeners = new Set();
    this.disposed = false;
  }

  static key(t) { return Math.round(t * 1000); }

  /** Width / height of file i's picture (16:9 until known). */
  aspect(i = 0) { return this.aspects[i] || this.aspects.find(Boolean) || 16 / 9; }

  get(t) {
    const k = FrameSource.key(t);
    const b = this.cache.get(k);
    if (b) { this.cache.delete(k); this.cache.set(k, b); }
    return b || null;
  }

  /** Closest cached frame within `window` seconds, to show while the exact one decodes. */
  nearest(t, window) {
    let best = null;
    let bestD = window * 1000;
    const k = FrameSource.key(t);
    for (const [ck, b] of this.cache) {
      const d = Math.abs(ck - k);
      if (d <= bestD) { best = b; bestD = d; }
    }
    return best;
  }

  /** Replace the wish list with what is visible now (newest first). `tol` lets a request use a nearby keyframe. */
  want(list) {
    this.wanted = new Map(list.filter((x) => !this.cache.has(FrameSource.key(x.t))).map((x) => [FrameSource.key(x.t), x]));
    this.#pump();
  }

  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async #pump() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      while (this.wanted.size && !this.disposed) {
        const [k, req] = this.wanted.entries().next().value;
        this.wanted.delete(k);
        if (this.cache.has(k)) continue;
        const bmp = await this.#decode(req.t, req.tol || 0).catch(() => null);
        if (!bmp || this.disposed) continue;
        this.cache.set(k, bmp);
        while (this.cache.size > this.max) {
          const [old, ob] = this.cache.entries().next().value;
          this.cache.delete(old);
          ob.close?.();
        }
        this.listeners.forEach((fn) => fn(req.t));
      }
    } finally { this.busy = false; }
  }

  #element(i) {
    if (!this.els[i]) {
      const el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      el.playsInline = true;
      const ready = new Promise((resolve, reject) => {
        el.addEventListener('loadedmetadata', () => { this.aspects[i] = el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 16 / 9; resolve(); }, { once: true });
        el.addEventListener('error', () => reject(new Error('decode')), { once: true });
      });
      el.src = this.videos[i].url;
      this.els[i] = { el, ready };
    }
    return this.els[i];
  }

  async #decode(t, tol) {
    const { index, local } = this.timeline.locate(t);
    const f = this.timeline.files[index];
    let at = Math.min(Math.max(0, local), Math.max(0, (f.duration || 0) - 0.05));
    // a keyframe close enough decodes much faster than a frame in the middle of a group of pictures
    const kfs = f.keyframes;
    if (kfs?.length && tol > 0) {
      let lo = 0;
      let hi = kfs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (kfs[mid] <= at) lo = mid; else hi = mid - 1; }
      const near = [kfs[lo], kfs[lo + 1]].filter((x) => x != null).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
      if (near != null && Math.abs(near - at) <= tol) at = near;
    }
    const { el, ready } = this.#element(index);
    await ready;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { el.removeEventListener('seeked', done); reject(new Error('seek timeout')); }, 5000);
      function done() { clearTimeout(timer); resolve(); }
      el.addEventListener('seeked', done, { once: true });
      el.currentTime = at + 0.001;
    });
    const h = this.height;
    const w = Math.round(h * this.aspect(index));
    return createImageBitmap(el, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  }

  dispose() {
    this.disposed = true;
    this.wanted.clear();
    this.cache.forEach((b) => b.close?.());
    this.cache.clear();
    for (const x of this.els) { if (!x) continue; x.el.removeAttribute('src'); x.el.load(); }
    this.els = [];
  }
}
