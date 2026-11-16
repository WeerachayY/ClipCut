// The program: what the viewer gets, on its own clock. It is the export plan (after cuts and arrangement)
// with every main-track piece's speed applied. Overlays (text, pictures, music) are placed on this clock.
//
// program = { duration, parts: [part] }   one part per output file, back to back on the clock
// part    = { index, label, start, duration, segments: [segment] }
// segment = { fileIndex, inpoint, outpoint, srcStart, srcEnd (global source time), pieceKey, pieceStart,
//             map (core/speed.js), outOffset (where this segment starts inside its piece's output),
//             progStart, partStart, duration (on the program clock) }
import { speedMap } from './speed.js';

const EPS = 1e-6;

/**
 * @param {object} plan   from buildPlan / buildClipPlan (core/plan.js)
 * @param {{pieces?:{key,start,end}[], speed?:object}} o  pieces from cuts.piecesOf; speed = {pieceKey: setting}
 */
export function buildProgram(plan, { pieces = [], speed = {} } = {}) {
  const maps = new Map();
  const infoFor = (p, a, b) => {
    const key = p ? p.key : `@${a}`;
    if (!maps.has(key)) {
      const start = p ? p.start : a;
      const end = p ? p.end : b;
      maps.set(key, { start, end, map: speedMap(p ? speed[p.key] : null, end - start) });
    }
    return maps.get(key);
  };
  let clock = 0;
  const parts = plan.parts.map((part) => {
    const segments = [];
    let t = 0;
    for (const s of part.segments) {
      const g0 = s.globalStart;
      const g1 = s.globalStart + s.duration;
      const edges = [g0, ...pieces.map((p) => p.end).filter((x) => x > g0 + EPS && x < g1 - EPS), g1];
      for (let k = 0; k < edges.length - 1; k++) {
        const a = edges[k];
        const b = edges[k + 1];
        const mid = (a + b) / 2;
        const p = pieces.find((x) => mid >= x.start && mid < x.end) || null;
        const info = infoFor(p, a, b);
        const outOffset = info.map.toOut(a - info.start);
        const duration = info.map.toOut(b - info.start) - outOffset;
        segments.push({
          fileIndex: s.fileIndex, fileName: s.fileName,
          inpoint: s.inpoint + (a - g0),
          outpoint: b >= g1 - EPS ? s.outpoint : s.inpoint + (b - g0),
          srcStart: a, srcEnd: b,
          pieceKey: p ? p.key : null, pieceStart: info.start, map: info.map,
          outOffset, duration, progStart: clock + t, partStart: t,
        });
        t += duration;
      }
    }
    const out = { index: part.index, label: part.label, from: part.from, to: part.to, start: clock, duration: t, segments };
    clock += t;
    return out;
  });
  const changed = [...maps.values()].some((i) => i.map.mode !== 'normal');
  return { parts, duration: clock, speedChanged: changed };
}

function segmentAt(list, T) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (list[m].progStart <= T) lo = m; else hi = m - 1; }
  return list[lo];
}

/** Where program time T comes from: {part, seg, src (global source time), local (time in its file), speed}. */
export function locate(program, T) {
  if (!program.parts.length) return null;
  const t = Math.max(0, Math.min(T, program.duration));
  let part = program.parts[program.parts.length - 1];
  for (const p of program.parts) if (t < p.start + p.duration) { part = p; break; }
  if (!part.segments.length) return null;
  return at(segmentAt(part.segments, t), t, part);
}

/** Same as locate, for a known segment (cheaper inside a loop over frames). */
export function at(seg, T, part) {
  const inPiece = seg.map.toSrc(seg.outOffset + Math.max(0, Math.min(seg.duration, T - seg.progStart)));
  const src = Math.min(seg.srcEnd, Math.max(seg.srcStart, seg.pieceStart + inPiece));
  return { part, seg, src, local: seg.inpoint + (src - seg.srcStart), speed: seg.map.speed(inPiece) };
}

/** First program time showing source time g, or null when g was cut. */
export function toProgram(program, g) {
  for (const p of program.parts) {
    for (const s of p.segments) {
      if (g >= s.srcStart - EPS && g < s.srcEnd - EPS) return s.progStart + s.map.toOut(g - s.pieceStart) - s.outOffset;
    }
  }
  return null;
}

/** Overlay clips that touch [start, end) of the program clock, cut to fit and moved onto that part's own clock. */
export function clipsInWindow(clips, start, end) {
  const out = [];
  for (const c of clips) {
    const a = Math.max(start, c.start);
    const b = Math.min(end, c.start + c.duration);
    if (b - a < 1e-3) continue;
    out.push({ ...c, start: a - start, duration: b - a, offset: (c.offset || 0) + (a - c.start), cutHead: a - c.start, cutTail: c.start + c.duration - b });
  }
  return out;
}
