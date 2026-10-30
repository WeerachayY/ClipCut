// Maps transcript time (tau, as written in the transcript file) to timeline time (g, the joined video).
//
// Anchors ("หมุดเวลา") are pairs {tau, g} the user confirmed by ear.
//  - no anchors      : g = tau
//  - one anchor      : constant offset everywhere
//  - several anchors : mode "linear" interpolates between anchors (handles slow drift),
//                      mode "step" keeps each anchor's offset until the next one (handles jumps,
//                      e.g. a recording that was stopped and restarted).
// Outside the anchored range the nearest anchor's offset is used (never extrapolated slopes).

export function sortAnchors(anchors) {
  return [...(anchors || [])].filter((a) => Number.isFinite(a.tau) && Number.isFinite(a.g)).sort((a, b) => a.tau - b.tau);
}

/** Anchors whose order in g disagrees with their order in tau (they would fold time backwards). */
export function findConflicts(anchors) {
  const s = sortAnchors(anchors);
  const bad = new Set();
  for (let i = 1; i < s.length; i++) {
    if (s[i].g <= s[i - 1].g) { bad.add(s[i].id); bad.add(s[i - 1].id); }
  }
  return bad;
}

export function createTimeMap(anchors, mode = 'linear') {
  const a = sortAnchors(anchors);
  // drop anchors that would make the mapping non-monotonic (keep the earlier one)
  const clean = [];
  for (const p of a) {
    if (clean.length === 0 || (p.tau > clean[clean.length - 1].tau && p.g > clean[clean.length - 1].g)) clean.push(p);
  }

  const offsetAt = (i) => clean[i].g - clean[i].tau;

  function toTimeline(tau) {
    if (clean.length === 0) return tau;
    if (tau <= clean[0].tau) return tau + offsetAt(0);
    const last = clean.length - 1;
    if (tau >= clean[last].tau) return tau + offsetAt(last);
    let i = 0;
    while (i < last && clean[i + 1].tau <= tau) i++;
    if (mode === 'step') return tau + offsetAt(i);
    const p = clean[i];
    const q = clean[i + 1];
    const r = (tau - p.tau) / (q.tau - p.tau);
    return p.g + r * (q.g - p.g);
  }

  function toTranscript(g) {
    if (clean.length === 0) return g;
    if (g <= clean[0].g) return g - offsetAt(0);
    const last = clean.length - 1;
    if (g >= clean[last].g) return g - offsetAt(last);
    let i = 0;
    while (i < last && clean[i + 1].g <= g) i++;
    if (mode === 'step') {
      // in step mode g ranges can overlap or leave holes; pick the segment that owns g
      return g - offsetAt(i);
    }
    const p = clean[i];
    const q = clean[i + 1];
    const r = (g - p.g) / (q.g - p.g);
    return p.tau + r * (q.tau - p.tau);
  }

  return { toTimeline, toTranscript, anchors: clean, mode };
}
