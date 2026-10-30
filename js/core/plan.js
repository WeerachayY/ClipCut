// Turns the reviewed decisions (accepted cuts + split markers) into an export plan:
// a list of output parts, each made of per-file segments with in/out points.
//
// Lossless export (stream copy) can only start a segment on a keyframe. To never lose
// content, every segment START is snapped DOWN to the previous keyframe, so a cut may keep
// a second or two more of the break than requested, but never removes speech.
// Segment ENDS do not need snapping.

const EPS = 0.05;

/** Merge overlapping/adjacent ranges. Input items need {start,end}. */
export function mergeRanges(ranges, gap = EPS) {
  const s = ranges.filter((r) => r.end - r.start > 0).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Where a cut really ends after keyframe snapping.
 * @returns {{start:number,end:number,effectiveEnd:number,shifted:number,ineffective:boolean}}
 */
export function effectiveCut(timeline, cut, { snap = true } = {}) {
  const start = Math.max(0, Math.min(cut.start, timeline.duration));
  const end = Math.max(start, Math.min(cut.end, timeline.duration));
  const effectiveEnd = snap ? Math.max(start, timeline.snapDown(end)) : end;
  return {
    start,
    end,
    effectiveEnd,
    shifted: end - effectiveEnd,
    ineffective: effectiveEnd - start < EPS * 2,
  };
}

/**
 * @param {import('./timeline.js').Timeline} timeline
 * @param {{start:number,end:number,status:string}[]} cuts  only status==='accepted' are applied
 * @param {{at:number,label?:string}[]} splits
 * @param {{snap?:boolean, minPart?:number}} opts
 */
export function buildPlan(timeline, cuts, splits = [], { snap = true, minPart = 0.5 } = {}) {
  const D = timeline.duration;
  const warnings = [];

  const accepted = cuts.filter((c) => c.status === 'accepted');
  const eff = [];
  for (const c of accepted) {
    const e = effectiveCut(timeline, c, { snap });
    if (e.ineffective) {
      warnings.push({ type: 'ineffective-cut', cutId: c.id, message: 'ช่วงตัดสั้นกว่าระยะ keyframe จึงตัดไม่ได้แบบไม่ encode ใหม่' });
      continue;
    }
    eff.push({ start: e.start, end: e.effectiveEnd });
  }
  const removed = mergeRanges(eff);

  // keep = complement of removed
  const keep = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start - cursor > EPS) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (D - cursor > EPS) keep.push({ start: cursor, end: D });

  // split points, snapped to keyframes so neighbouring parts neither overlap nor lose frames
  const snappedSplits = [];
  for (const s of [...splits].sort((a, b) => a.at - b.at)) {
    const at = snap ? timeline.snapDown(s.at) : s.at;
    if (at <= minPart || at >= D - minPart) continue;
    if (snappedSplits.length && at - snappedSplits[snappedSplits.length - 1].at < minPart) continue;
    snappedSplits.push({ at, label: s.label || '', id: s.id, requested: s.at });
  }

  const bounds = [0, ...snappedSplits.map((s) => s.at), D];
  const parts = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const p0 = bounds[k];
    const p1 = bounds[k + 1];
    const ranges = keep
      .map((r) => ({ start: Math.max(r.start, p0), end: Math.min(r.end, p1) }))
      .filter((r) => r.end - r.start > EPS);
    const segments = [];
    for (const r of ranges) {
      for (const piece of timeline.splitRange(r.start, r.end)) {
        const atFileEnd = piece.outpoint >= piece.file.duration - 0.01;
        segments.push({
          fileIndex: piece.index,
          fileId: piece.file.id,
          fileName: piece.file.name,
          inpoint: piece.inpoint,
          outpoint: atFileEnd ? null : piece.outpoint,
          duration: piece.outpoint - piece.inpoint,
          globalStart: piece.file.start + piece.inpoint,
        });
      }
    }
    const duration = segments.reduce((acc, s) => acc + s.duration, 0);
    const label = k === 0 ? (snappedSplits.length ? 'เริ่มต้น' : '') : snappedSplits[k - 1].label;
    if (duration < minPart) {
      if (bounds.length > 2) warnings.push({ type: 'empty-part', message: `ช่วงที่ ${k + 1} ไม่มีเนื้อหาเหลือหลังตัด จึงข้ามไป` });
      continue;
    }
    parts.push({ index: parts.length, label, from: p0, to: p1, ranges, segments, duration });
  }

  const keptDuration = parts.reduce((a, p) => a + p.duration, 0);
  return {
    parts,
    removed,
    keep,
    splits: snappedSplits,
    keptDuration,
    removedDuration: removed.reduce((a, r) => a + (r.end - r.start), 0),
    totalDuration: D,
    snapped: snap && timeline.hasKeyframes,
    warnings,
  };
}

/** ffconcat text for one part. pathFor(fileIndex) -> path inside the ffmpeg filesystem. */
export function buildConcatList(part, pathFor) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  // Round the in point UP to the millisecond so it is never before the keyframe it was snapped to.
  const up = (t) => (Math.ceil(t * 1000 - 1e-6) / 1000).toFixed(3);
  const down = (t) => (Math.floor(t * 1000 + 1e-6) / 1000).toFixed(3);
  const lines = ['ffconcat version 1.0'];
  for (const s of part.segments) {
    lines.push(`file ${q(pathFor(s.fileIndex))}`);
    if (s.inpoint > 0.0005) lines.push(`inpoint ${up(s.inpoint)}`);
    if (s.outpoint != null) lines.push(`outpoint ${down(s.outpoint)}`);
  }
  return lines.join('\n') + '\n';
}

/** Rough output size from the source bitrate (stream copy). */
export function estimatePartBytes(part, timeline) {
  let bytes = 0;
  for (const s of part.segments) {
    const f = timeline.files[s.fileIndex];
    if (f && f.size && f.duration) bytes += (f.size / f.duration) * s.duration;
  }
  return bytes;
}
