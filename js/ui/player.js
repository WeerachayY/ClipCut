// Plays several local video files as one continuous timeline using a single <video> element.
// Also implements "listen to the seam" (play just before and just after a cut) and
// "preview result" (skip accepted cuts while playing).
export class MultiPlayer extends EventTarget {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    super();
    this.video = video;
    this.timeline = null;
    this.urls = [];
    this.index = -1;
    this.pendingLocal = null;
    this.previewState = null;
    this.skipRanges = null; // () => [{start,end}] or null
    this.raf = 0;
    this._t = 0;

    video.addEventListener('loadedmetadata', () => {
      if (this.pendingLocal != null) { video.currentTime = this.pendingLocal; this.pendingLocal = null; }
    });
    video.addEventListener('ended', () => {
      if (this.timeline && this.index < this.timeline.files.length - 1) this.#switchTo(this.index + 1, 0, true);
      else this.#emit('state');
    });
    video.addEventListener('play', () => { this.#loop(); this.#emit('state'); });
    video.addEventListener('pause', () => this.#emit('state'));
    video.addEventListener('seeked', () => this.#tick());
    video.addEventListener('timeupdate', () => { if (video.paused) this.#tick(); });
  }

  load(timeline, urls) {
    this.timeline = timeline;
    this.urls = urls;
    this.index = -1;
    this.seek(Math.min(this._t, timeline.duration));
  }

  get time() {
    if (!this.timeline || this.index < 0) return this._t;
    if (this.pendingLocal != null) return this.timeline.files[this.index].start + this.pendingLocal;
    return this.timeline.files[this.index].start + this.video.currentTime;
  }

  get playing() { return !this.video.paused && !this.video.ended; }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  #switchTo(index, local, autoplay) {
    const wasPlaying = autoplay ?? this.playing;
    if (index !== this.index) {
      this.index = index;
      this.pendingLocal = local;
      this.video.src = this.urls[index];
      this.#emit('file', { index });
    } else if (this.pendingLocal != null) {
      this.pendingLocal = local;
    } else {
      this.video.currentTime = local;
    }
    if (wasPlaying) this.video.play().catch(() => {});
    this.#tick();
  }

  seek(g, { play } = {}) {
    if (!this.timeline) return;
    const t = Math.max(0, Math.min(g, this.timeline.duration - 0.05));
    const { index, local } = this.timeline.locate(t);
    this._t = t;
    this.#switchTo(index, local, play);
  }

  /** Move by whole frames (pauses first, like every editor). */
  stepFrames(n) {
    if (!this.timeline) return;
    const fps = this.timeline.fps || 30;
    this.video.pause();
    this.previewState = null;
    const frame = Math.round(this.time * fps) + n;
    // aim a little inside the frame so the decoder shows that frame, not the one before
    this.seek(Math.max(0, frame / fps + 0.25 / fps));
  }

  /** Jump by seconds, keeping play/pause state. */
  jump(seconds) { this.seek(this.time + seconds); }

  play() { this.video.play().catch(() => {}); }
  pause() { this.video.pause(); this.previewState = null; }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  setRate(r) { this.video.playbackRate = r; }

  /** Play `before` seconds up to the cut, jump to where the kept video resumes, play `after` seconds, stop. */
  previewSeam(cutStart, resumeAt, { before = 5, after = 5 } = {}) {
    this.previewState = { phase: 'before', cutStart, resumeAt, stopAt: resumeAt + after };
    this.seek(Math.max(0, cutStart - before), { play: true });
    this.#emit('preview', { active: true });
  }

  #loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      this.#tick();
      if (this.playing) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  #tick() {
    const t = this.time;
    this._t = t;
    const p = this.previewState;
    if (p && this.playing) {
      if (p.phase === 'before' && t >= p.cutStart - 0.03) {
        p.phase = 'after';
        this.seek(p.resumeAt, { play: true });
        return;
      }
      if (p.phase === 'after' && t >= p.stopAt) {
        this.previewState = null;
        this.video.pause();
        this.#emit('preview', { active: false });
      }
    } else if (!p && this.playing && this.skipRanges) {
      const r = this.skipRanges().find((x) => t >= x.start && t < x.end - 0.05);
      if (r) { this.seek(r.end, { play: true }); return; }
    }
    this.#emit('time', { t });
  }
}
