// Transcript lines as spans of the timeline: the basis for cutting by text and for captions.
// Lines come from analysis.mapLines (sorted, with g = start on the timeline, gEnd when the file has end times).

/** Rough speaking time of a line (Thai or English), for transcripts that give only start times. */
export const speakingTime = (text) => 1 + [...String(text || '')].length / 12;

/**
 * @returns {{i:number, start:number, end:number, text:string, speaker:string}[]}
 *   end = the transcript's own end time, otherwise the next line's start, but never longer than twice the
 *   speaking time + 4 s, so the last line before a long break does not swallow the break.
 */
export function lineSpans(lines, duration) {
  return lines.map((l, i) => {
    const next = lines[i + 1];
    const est = speakingTime(l.text);
    let end;
    if (Number.isFinite(l.gEnd) && l.gEnd > l.g) end = l.gEnd;
    else if (next) end = Math.min(next.g, l.g + est * 2 + 4);
    else end = l.g + est * 2;
    const start = Math.max(0, Math.min(l.g, duration));
    return { i, start, end: Math.max(start, Math.min(end, duration)), text: l.text, speaker: l.speaker || '' };
  });
}

/** Timeline range covered by lines a..b (either order, inclusive). */
export function rangeOfLines(spans, a, b) {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(spans.length - 1, Math.max(a, b));
  return { start: spans[lo].start, end: spans[hi].end, count: hi - lo + 1 };
}

/**
 * The quietest moment within ±window s of t, read from the waveform layer, so a cut lands in the pause
 * between sentences rather than on a word. Returns t unchanged when there is no waveform.
 */
export function quietestNear(layer, t, window = 0.6) {
  if (!layer?.peaks?.length) return t;
  const { rate, peaks } = layer;
  const c = t * rate;
  const a = Math.max(0, Math.floor(c - window * rate));
  const b = Math.min(peaks.length - 1, Math.ceil(c + window * rate));
  let best = -1;
  let bestV = Infinity;
  for (let i = a; i <= b; i++) {
    const v = peaks[i] + (Math.abs(i - c) / rate) * 60; // a little preference for staying close to the transcript time
    if (v < bestV) { bestV = v; best = i; }
  }
  return best < 0 ? t : best / rate;
}

/**
 * How each line fares against the pieces (core/cuts.js piecesOf): 'gone' (thrown away), 'partly',
 * 'suggested' (inside a piece the app suggests throwing away) or 'kept'.
 */
export function lineStates(spans, pieces) {
  const cut = pieces.filter((p) => p.status === 'delete');
  const sug = pieces.filter((p) => p.status === 'suggested');
  const overlap = (list, s, e) => list.reduce((acc, p) => acc + Math.max(0, Math.min(e, p.end) - Math.max(s, p.start)), 0);
  return spans.map((sp) => {
    const len = Math.max(0.2, sp.end - sp.start);
    const gone = overlap(cut, sp.start, sp.start + len) / len;
    if (gone >= 0.6) return 'gone';
    if (gone > 0.1) return 'partly';
    if (overlap(sug, sp.start, sp.start + len) / len >= 0.6) return 'suggested';
    return 'kept';
  });
}

// ---------- where sound starts and stops ----------
const edgeCache = new WeakMap();

/**
 * Times where sound starts ('on') or stops ('off'), from the waveform layer. Pauses shorter than `minQuiet`
 * (breaths, the gap inside a word) and blips shorter than `minLoud` (a click) are ignored.
 * @returns {{t:number, kind:'on'|'off'}[]}
 */
export function soundEdges(layer, { threshold = 14, minQuiet = 0.18, minLoud = 0.04 } = {}) {
  if (!layer?.peaks?.length) return [];
  const hit = edgeCache.get(layer.peaks);
  if (hit) return hit;
  const { rate, peaks } = layer;
  // runs of loud / quiet
  const runs = [];
  let from = 0;
  let loud = peaks[0] > threshold;
  for (let i = 1; i <= peaks.length; i++) {
    const l = i < peaks.length ? peaks[i] > threshold : !loud;
    if (l !== loud) { runs.push({ loud, from, to: i }); from = i; loud = l; }
  }
  const merge = (keep) => {
    const out = [];
    for (const r of runs.splice(0)) {
      const last = out[out.length - 1];
      if (last && (last.loud === r.loud || !keep(r))) last.to = r.to; else out.push({ ...r });
    }
    runs.push(...out);
  };
  merge((r) => r.loud || (r.to - r.from) / rate >= minQuiet); // close short pauses
  merge((r) => !r.loud || (r.to - r.from) / rate >= minLoud); // drop short blips
  const edges = [];
  for (let i = 1; i < runs.length; i++) edges.push({ t: runs[i].from / rate, kind: runs[i].loud ? 'on' : 'off' });
  edgeCache.set(layer.peaks, edges);
  return edges;
}

/** The next (dir = 1) or previous (dir = -1) sound edge from time t, or null. */
export function nextSoundEdge(layer, t, dir) {
  const edges = soundEdges(layer);
  if (dir > 0) return edges.find((e) => e.t > t + 0.003) || null;
  for (let i = edges.length - 1; i >= 0; i--) if (edges[i].t < t - 0.003) return edges[i];
  return null;
}
