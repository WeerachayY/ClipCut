// Runs all enabled detectors against the current project and returns cut suggestions.
// Pure function of its inputs: media analysis (e.g. silence) is computed elsewhere and passed in.
import { detectors } from './registry.js';
import { combineCandidates } from './suggest.js';
import { createTimeMap } from './timemap.js';

/** Transcript lines with their position on the joined timeline (g). */
export function mapLines(transcript, anchors, mode) {
  if (!transcript || !transcript.lines) return [];
  const map = createTimeMap(anchors, mode);
  return transcript.lines.map((l) => ({ ...l, g: map.toTimeline(l.tau) })).sort((a, b) => a.g - b.g);
}

/**
 * @returns {{suggestions: object[], candidates: object[]}}
 */
export function suggestCuts({ timeline, transcript, anchors = [], anchorMode = 'linear', analysis = {}, settings = {} }) {
  const lines = mapLines(transcript, anchors, anchorMode);
  const ctx = { timeline, duration: timeline.duration, lines: lines.length ? lines : null, analysis };
  const candidates = [];
  let combineOpts = { duration: timeline.duration };
  for (const d of detectors()) {
    const p = { ...(d.defaults || {}), ...(settings[d.id] || {}) };
    if (p.enabled === false) continue;
    if (d.needs === 'transcript' && !ctx.lines) continue;
    if ((d.needs === 'audio' || d.needs === 'video') && !analysis[d.id]) continue;
    const found = d.detect(ctx, p) || [];
    candidates.push(...found);
    if (d.combineOptions) combineOpts = { ...combineOpts, ...d.combineOptions(p) };
  }
  return { suggestions: combineCandidates(candidates, combineOpts), candidates };
}

/**
 * Proposes sync anchors: the first line after each long quiet stretch in the transcript is matched
 * with the nearest end of an audio silence (that is where speech audibly resumes).
 */
export function proposeAnchors({ transcript, anchors = [], anchorMode = 'linear', silence = [], minGap = 60, window = 90 }) {
  const lines = mapLines(transcript, anchors, anchorMode);
  if (!lines.length || !silence.length) return [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const quietBefore = i === 0 ? lines[0].g : lines[i].g - lines[i - 1].g;
    if (quietBefore < minGap) continue;
    let best = null;
    for (const s of silence) {
      const d = Math.abs(s.end - lines[i].g);
      if (d <= window && (!best || d < Math.abs(best.end - lines[i].g))) best = s;
    }
    if (best) out.push({ tau: lines[i].tau, g: best.end, lineIdx: lines[i].idx, text: lines[i].text, shift: best.end - lines[i].g });
  }
  return out;
}
