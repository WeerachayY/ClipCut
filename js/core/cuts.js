// The edit model: "cut points" (marks) slice the joined video into pieces, like the razor/blade
// tool in a video editor. Every piece is kept unless it is marked to be thrown away.
//
//   edit = {
//     marks:  [{ id, at, origin: 'manual'|'auto', moved, split, label }]   // split = a new output file starts here
//     pieces: { [key]: { status: 'keep'|'delete'|'suggested', decided, confidence, reasons, origin } }
//   }
//
// A piece is identified by the mark on its left edge (START for the first piece), so its state
// survives when marks elsewhere change. Pieces without a record are plain "keep".
// Every function returns a new edit object; nothing is mutated.
import { newId } from './id.js';

export const START = '_start';
const MIN_GAP = 0.1;   // s between two marks
const SNAP = 0.05;     // s: a new mark this close to an existing one reuses it

export const emptyEdit = () => ({ marks: [], pieces: {} });

const sortMarks = (marks) => [...marks].sort((a, b) => a.at - b.at);
const round = (t) => Math.round(t * 1000) / 1000;

/** Pieces in time order: [{key, start, end, status, decided, confidence, reasons, origin, leftMark, rightMark}] */
export function piecesOf(edit, duration) {
  const marks = sortMarks(edit.marks).filter((m) => m.at > 0 && m.at < duration);
  const out = [];
  let start = 0;
  let key = START;
  let leftMark = null;
  for (let i = 0; i <= marks.length; i++) {
    const rightMark = marks[i] || null;
    const end = rightMark ? rightMark.at : duration;
    const rec = edit.pieces[key] || null;
    out.push({
      key, index: out.length, start, end, leftMark, rightMark,
      status: rec?.status || 'keep',
      decided: !!rec?.decided,
      confidence: rec?.confidence || null,
      reasons: rec?.reasons || [],
      origin: rec?.origin || null,
      hasRecord: !!rec,
    });
    if (rightMark) { start = rightMark.at; key = rightMark.id; leftMark = rightMark; }
  }
  return out;
}

export const pieceAt = (edit, duration, t) => piecesOf(edit, duration).find((p) => t >= p.start && t < p.end) || null;

/** Add a cut point. The new right-hand piece inherits the state of the piece it was cut from. */
export function addMark(edit, at, duration, { origin = 'manual', split = false, label = '' } = {}) {
  const t = round(at);
  if (t <= SNAP || t >= duration - SNAP) return { edit, id: null };
  const near = edit.marks.find((m) => Math.abs(m.at - t) <= SNAP);
  if (near) {
    if (split && !near.split) return { edit: { ...edit, marks: edit.marks.map((m) => (m === near ? { ...m, split: true, label: m.label || label } : m)) }, id: near.id };
    return { edit, id: near.id };
  }
  const host = pieceAt(edit, duration, t);
  const id = newId('m');
  const pieces = { ...edit.pieces };
  if (host && edit.pieces[host.key]) pieces[id] = { ...edit.pieces[host.key] };
  return { edit: { marks: sortMarks([...edit.marks, { id, at: t, origin, moved: false, split, label }]), pieces }, id };
}

/**
 * Throw away everything between a and b (e.g. selected transcript lines): cut points at both ends,
 * every piece inside set to `status`. Returns the keys of those pieces.
 */
export function deleteRange(edit, a, b, duration, status = 'delete') {
  if (!(b - a >= 0.1)) return { edit, keys: [] };
  let e = addMark(edit, a, duration).edit;
  e = addMark(e, b, duration).edit;
  const keys = [];
  for (const p of piecesOf(e, duration)) {
    if (p.start >= a - SNAP && p.end <= b + SNAP) { e = setPieceStatus(e, p.key, status); keys.push(p.key); }
  }
  return { edit: e, keys };
}

/** Bring back thrown-away pieces that lie mostly inside a..b (cut points stay; join them to tidy up). */
export function keepRange(edit, a, b, duration) {
  let e = edit;
  for (const p of piecesOf(edit, duration)) {
    const inside = Math.max(0, Math.min(b, p.end) - Math.max(a, p.start));
    if (p.status === 'delete' && inside >= (p.end - p.start) * 0.5) e = setPieceStatus(e, p.key, 'keep');
  }
  return e;
}

/** Remove a cut point ("join"). The merged piece is always kept: joining never deletes content. */
export function removeMark(edit, id) {
  const marks = sortMarks(edit.marks);
  const i = marks.findIndex((m) => m.id === id);
  if (i < 0) return edit;
  const leftKey = i === 0 ? START : marks[i - 1].id;
  const pieces = { ...edit.pieces };
  delete pieces[id];
  delete pieces[leftKey];
  return { marks: marks.filter((m) => m.id !== id), pieces };
}

/** Move a cut point, kept strictly between its neighbours. */
export function moveMark(edit, id, at, duration) {
  const marks = sortMarks(edit.marks);
  const i = marks.findIndex((m) => m.id === id);
  if (i < 0) return edit;
  const lo = (i > 0 ? marks[i - 1].at : 0) + MIN_GAP;
  const hi = (i < marks.length - 1 ? marks[i + 1].at : duration) - MIN_GAP;
  if (hi < lo) return edit;
  const t = round(Math.min(hi, Math.max(lo, at)));
  return { ...edit, marks: marks.map((m) => (m.id === id ? { ...m, at: t, moved: true } : m)) };
}

export const nudgeMark = (edit, id, delta, duration) => {
  const m = edit.marks.find((x) => x.id === id);
  return m ? moveMark(edit, id, m.at + delta, duration) : edit;
};

export function setSplit(edit, id, split, label) {
  return { ...edit, marks: edit.marks.map((m) => (m.id === id ? { ...m, split, label: label ?? m.label } : m)) };
}

export const setMarkLabel = (edit, id, label) => ({ ...edit, marks: edit.marks.map((m) => (m.id === id ? { ...m, label } : m)) });

/** 'keep' | 'delete' — a decision the user made, so re-running detection leaves it alone. */
export function setPieceStatus(edit, key, status) {
  const rec = edit.pieces[key] || { origin: 'manual' };
  return { ...edit, pieces: { ...edit.pieces, [key]: { ...rec, status, decided: true } } };
}

export const togglePiece = (edit, key) => {
  const cur = edit.pieces[key]?.status || 'keep';
  return setPieceStatus(edit, key, cur === 'delete' ? 'keep' : 'delete');
};

export function deleteAllSuggested(edit, { onlyHigh = true } = {}) {
  const pieces = { ...edit.pieces };
  for (const [k, r] of Object.entries(pieces)) {
    if (r.status === 'suggested' && !r.decided && (!onlyHigh || r.confidence === 'high')) pieces[k] = { ...r, status: 'delete', decided: true };
  }
  return { ...edit, pieces };
}

/**
 * Fold detector suggestions into the edit. Untouched automatic suggestions from an earlier run are
 * removed first; anything the user decided, moved or added by hand stays exactly as it is.
 * @param {{start,end,confidence,reasons}[]} suggestions
 */
export function applySuggestions(edit, suggestions, duration) {
  let e = edit;
  // 1. drop undecided suggestions from the previous run
  const pieces = { ...e.pieces };
  for (const [k, r] of Object.entries(pieces)) if (r.status === 'suggested' && !r.decided) delete pieces[k];
  e = { ...e, pieces };
  for (const m of sortMarks(e.marks)) {
    if (m.origin !== 'auto' || m.moved || m.split) continue;
    const ps = piecesOf(e, duration);
    const left = ps.find((p) => p.rightMark?.id === m.id);
    const right = ps.find((p) => p.leftMark?.id === m.id);
    if ((left && left.hasRecord) || (right && right.hasRecord)) continue;
    e = removeMark(e, m.id);
  }
  // 2. add the new ones where the user has not already made a call
  for (const s of [...suggestions].sort((a, b) => a.start - b.start)) {
    const busy = piecesOf(e, duration).some((p) => p.hasRecord && p.end > s.start + SNAP && p.start < s.end - SNAP);
    if (busy) continue;
    let r = addMark(e, s.start, duration, { origin: 'auto' });
    e = r.edit;
    r = addMark(e, s.end, duration, { origin: 'auto' });
    e = r.edit;
    const inside = piecesOf(e, duration).filter((p) => p.start >= s.start - SNAP && p.end <= s.end + SNAP);
    const next = { ...e.pieces };
    for (const p of inside) next[p.key] = { status: 'suggested', decided: false, confidence: s.confidence, reasons: s.reasons || [], origin: 'auto' };
    e = { ...e, pieces: next };
  }
  return e;
}

/**
 * The shapes the export plan understands: deleted pieces as accepted cut ranges, split marks as splits.
 */
export function toPlanInput(edit, duration) {
  const cuts = [];
  for (const p of piecesOf(edit, duration)) {
    if (p.status !== 'delete') continue;
    const last = cuts[cuts.length - 1];
    if (last && Math.abs(last.end - p.start) < 1e-6) last.end = p.end;
    else cuts.push({ id: p.key, start: p.start, end: p.end, status: 'accepted' });
  }
  const splits = sortMarks(edit.marks).filter((m) => m.split && m.at > 0 && m.at < duration).map((m) => ({ id: m.id, at: m.at, label: m.label || '' }));
  return { cuts, splits };
}

export function counts(edit, duration) {
  const n = { delete: 0, suggested: 0, high: 0, rejected: 0, marks: edit.marks.length };
  for (const p of piecesOf(edit, duration)) {
    if (p.status === 'delete') n.delete++;
    else if (p.status === 'suggested') { n.suggested++; if (p.confidence === 'high') n.high++; } else if (p.decided && p.origin === 'auto') n.rejected++;
  }
  return n;
}

/** Convert a v0.1/v0.2 project (cut ranges + split points) to marks and pieces. */
export function fromLegacy(cuts = [], splits = [], duration = Infinity) {
  let e = emptyEdit();
  const STATUS = { accepted: 'delete', rejected: 'keep', suggested: 'suggested' };
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    const origin = c.origin === 'manual' ? 'manual' : 'auto';
    e = addMark(e, c.start, duration, { origin }).edit;
    e = addMark(e, c.end, duration, { origin }).edit;
    if (c.edited) e = { ...e, marks: e.marks.map((m) => (Math.abs(m.at - round(c.start)) < 1e-6 || Math.abs(m.at - round(c.end)) < 1e-6 ? { ...m, moved: true } : m)) };
    const inside = piecesOf(e, duration).filter((p) => p.start >= c.start - SNAP && p.end <= c.end + SNAP);
    const next = { ...e.pieces };
    for (const p of inside) next[p.key] = { status: STATUS[c.status] || 'suggested', decided: c.status !== 'suggested', confidence: c.confidence || null, reasons: c.reasons || [], origin };
    e = { ...e, pieces: next };
  }
  for (const s of splits) e = addMark(e, s.at, duration, { split: true, label: s.label || '' }).edit;
  return e;
}
