// A virtual timeline that joins several video files end to end.
// "Global time" (g) runs from 0 to the sum of all durations.
// Each file may carry a sorted list of keyframe times (local seconds) so that
// cut points can be snapped to places where a lossless (stream copy) cut is clean.

export class Timeline {
  /** @param {{id:string,name:string,duration:number,keyframes?:number[]|null}[]} files in playback order */
  constructor(files) {
    this.files = files.map((f, index) => ({ ...f, index }));
    let acc = 0;
    for (const f of this.files) {
      f.start = acc;
      acc += f.duration || 0;
      f.end = acc;
    }
    this.duration = acc;
    // frame rate used for stepping and timecodes (first file that knows it; common rates rounded)
    const raw = this.files.find((f) => f.fps > 0)?.fps || 30;
    const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
      .map((r) => ({ r, d: Math.abs(r - raw) })).sort((x, y) => x.d - y.d).find((x) => x.d < 0.01)?.r;
    this.fps = common || Math.round(raw * 100) / 100;
  }

  /** Global times where one file ends and the next begins. */
  get seams() {
    return this.files.slice(0, -1).map((f) => f.end);
  }

  /** File that contains global time g. A time exactly on a seam belongs to the next file. */
  locate(g) {
    const t = Math.max(0, Math.min(g, this.duration));
    for (const f of this.files) {
      if (t < f.end || f === this.files[this.files.length - 1]) {
        return { file: f, index: f.index, local: Math.max(0, t - f.start) };
      }
    }
    return { file: null, index: -1, local: 0 };
  }

  toGlobal(index, local) {
    const f = this.files[index];
    return f ? f.start + local : NaN;
  }

  /** True when every file has keyframe data. */
  get hasKeyframes() {
    return this.files.length > 0 && this.files.every((f) => Array.isArray(f.keyframes) && f.keyframes.length > 0);
  }

  /**
   * Largest keyframe time <= g, as a global time. When the file has no keyframe data
   * the time is returned unchanged. Seams and 0 are always clean cut points.
   */
  snapDown(g) {
    if (g <= 0) return 0;
    if (g >= this.duration) return this.duration;
    const { file, local } = this.locate(g);
    if (!file) return g;
    const kf = file.keyframes;
    if (!Array.isArray(kf) || kf.length === 0) return g;
    // binary search: last keyframe <= local (+1ms tolerance for float noise)
    let lo = 0;
    let hi = kf.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kf[mid] <= local + 0.001) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const k = best >= 0 ? Math.max(0, kf[best]) : 0;
    return file.start + k;
  }

  /** Split a global range into per-file pieces in local time. */
  splitRange(a, b) {
    const out = [];
    for (const f of this.files) {
      const s = Math.max(a, f.start);
      const e = Math.min(b, f.end);
      if (e - s > 0.04) out.push({ index: f.index, file: f, inpoint: s - f.start, outpoint: e - f.start });
    }
    return out;
  }
}
