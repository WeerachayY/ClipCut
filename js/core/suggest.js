// Combines raw detector output into reviewable cut suggestions.
//
// Detectors return "candidates" with one of three roles:
//   primary  {start,end,minStart?,maxEnd?,source,label}  proposes a range to cut
//   refiner  {start,end,source,label}                    precise quiet ranges (e.g. audio silence);
//                                                        used to sharpen primary edges, or stand alone if long
//   evidence {at,kind:'break-start'|'break-end',source,label}  supports a primary whose edge is nearby
//
// A suggestion is "high" confidence when at least two independent kinds of signal agree.

const round1 = (t) => Math.round(t * 10) / 10;

export function combineCandidates(cands, {
  duration = Infinity,
  edgeTolerance = 45,      // s: how far a silence edge may move a transcript edge
  evidenceWindow = 60,     // s: keyword must be this close to an edge to count
  standaloneMin = 90,      // s: silence alone becomes a suggestion when at least this long
  minCut = 10,             // s: drop anything shorter
} = {}) {
  const primaries = cands.filter((c) => c.role === 'primary').map((c) => ({ ...c }));
  const refiners = cands.filter((c) => c.role === 'refiner');
  const evidence = cands.filter((c) => c.role === 'evidence');

  // 1. union overlapping primaries
  primaries.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of primaries) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) {
      last.end = Math.max(last.end, p.end);
      last.minStart = Math.min(last.minStart ?? last.start, p.minStart ?? p.start);
      last.maxEnd = Math.max(last.maxEnd ?? last.end, p.maxEnd ?? p.end);
      last.sources.add(p.source);
      last.reasons.push(p.label);
    } else {
      merged.push({
        start: p.start,
        end: p.end,
        minStart: p.minStart ?? p.start,
        maxEnd: p.maxEnd ?? p.end,
        sources: new Set([p.source]),
        signals: new Set([p.signal || 'transcript']),
        reasons: [p.label],
      });
    }
  }

  // 2. refine edges with precise quiet ranges, and count them as support
  const usedRefiners = new Set();
  for (const m of merged) {
    const over = refiners.filter((r) => r.end > m.start && r.start < m.end);
    if (!over.length) continue;
    over.forEach((r) => usedRefiners.add(r));
    let best = null;
    for (const r of over) {
      const d = Math.abs(r.start - m.start);
      if (d <= edgeTolerance && (!best || d < Math.abs(best.start - m.start))) best = r;
    }
    if (best) m.start = Math.max(best.start, m.minStart);
    best = null;
    for (const r of over) {
      const d = Math.abs(r.end - m.end);
      if (d <= edgeTolerance && (!best || d < Math.abs(best.end - m.end))) best = r;
    }
    if (best) m.end = Math.min(best.end, m.maxEnd);
    const covered = over.reduce((a, r) => a + Math.max(0, Math.min(r.end, m.end) - Math.max(r.start, m.start)), 0);
    if (covered / Math.max(1, m.end - m.start) >= 0.5) {
      m.signals.add('audio');
      m.sources.add(over[0].source);
      m.reasons.push(`เสียงเงียบ ${Math.round((covered / (m.end - m.start)) * 100)}% ของช่วง`);
    }
  }

  // 3. keyword evidence: a break announcement just before the start, or a "we're back" just after the end
  const near = (e, m) =>
    (e.kind === 'break-start' && e.at >= m.start - evidenceWindow && e.at <= m.start + 15) ||
    (e.kind === 'break-end' && e.at >= m.end - 15 && e.at <= m.end + evidenceWindow);
  // each keyword supports only the one range whose edge is closest to it
  const edgeDist = (e, m) => Math.abs(e.at - (e.kind === 'break-start' ? m.start : m.end));
  const credited = new Map(merged.map((m) => [m, []]));
  for (const e of evidence) {
    let best = null;
    for (const m of merged) if (near(e, m) && (!best || edgeDist(e, m) < edgeDist(e, best))) best = m;
    if (best) credited.get(best).push(e);
  }
  for (const [m, hits] of credited) {
    if (!hits.length) continue;
    m.signals.add('keyword');
    m.sources.add(hits[0].source);
    m.reasons.push(...new Set(hits.map((e) => e.label)));
  }

  // 4. long silences nobody else noticed
  for (const r of refiners) {
    if (usedRefiners.has(r)) continue;
    if (r.end - r.start < standaloneMin) continue;
    if (merged.some((m) => r.end > m.start && r.start < m.end)) continue;
    merged.push({ start: r.start, end: r.end, sources: new Set([r.source]), signals: new Set(['audio']), reasons: [r.label] });
  }

  return merged
    .map((m) => ({
      start: round1(Math.max(0, m.start)),
      end: round1(Math.min(duration, m.end)),
      confidence: m.signals.size >= 2 ? 'high' : 'check',
      reasons: [...new Set(m.reasons)],
      sources: [...m.sources],
    }))
    .filter((s) => s.end - s.start >= minCut)
    .sort((a, b) => a.start - b.start);
}
