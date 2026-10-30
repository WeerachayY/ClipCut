// Operations on the cut list. Every function returns a new array (state stays immutable).
import { newId } from './store.js';

const MIN_LEN = 0.5;

/**
 * Fold fresh detector suggestions into the list, keeping everything the user already touched:
 * decided cuts, edited cuts and manual cuts stay; untouched suggestions are replaced.
 */
export function mergeSuggestions(existing, suggestions) {
  const keep = existing.filter((c) => c.origin === 'manual' || c.status !== 'suggested' || c.edited);
  const fresh = suggestions
    .filter((s) => !keep.some((k) => s.end > k.start && s.start < k.end))
    .map((s) => ({ id: newId('c'), start: s.start, end: s.end, status: 'suggested', confidence: s.confidence, reasons: s.reasons, origin: 'auto', edited: false }));
  return [...keep, ...fresh].sort((a, b) => a.start - b.start);
}

export const setStatus = (cuts, id, status) => cuts.map((c) => (c.id === id ? { ...c, status } : c));

export function setEdge(cuts, id, edge, t, duration) {
  return cuts.map((c) => {
    if (c.id !== id) return c;
    const v = Math.max(0, Math.min(duration, Math.round(t * 10) / 10));
    const next = { ...c, edited: true, [edge]: v };
    if (next.end - next.start < MIN_LEN) return c;
    return next;
  });
}

export const nudge = (cuts, id, edge, delta, duration) => {
  const c = cuts.find((x) => x.id === id);
  return c ? setEdge(cuts, id, edge, c[edge] + delta, duration) : cuts;
};

export function addManual(cuts, start, end) {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b - a < MIN_LEN) return { cuts, id: null };
  const id = newId('c');
  const cut = { id, start: Math.round(a * 10) / 10, end: Math.round(b * 10) / 10, status: 'accepted', confidence: 'manual', reasons: ['เพิ่มเอง'], origin: 'manual', edited: true };
  return { cuts: [...cuts, cut].sort((x, y) => x.start - y.start), id };
}

export const removeCut = (cuts, id) => cuts.filter((c) => c.id !== id);

export const acceptAllHigh = (cuts) => cuts.map((c) => (c.status === 'suggested' && c.confidence === 'high' ? { ...c, status: 'accepted' } : c));

export function counts(cuts) {
  const n = { accepted: 0, suggested: 0, rejected: 0, high: 0 };
  for (const c of cuts) { n[c.status]++; if (c.status === 'suggested' && c.confidence === 'high') n.high++; }
  return n;
}
