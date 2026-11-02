// Captions for an exported part: transcript spans moved onto the part's own clock (what was cut is
// skipped, so every later caption moves earlier by exactly that much), long lines split into readable cues.
import { speakingTime } from './textedit.js';

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const chars = (s) => [...s].length;

/** Split text at word boundaries (Thai has no spaces between words) into chunks of at most `max` characters. */
export function chunkText(text, max = 84) {
  const words = segmenter ? [...segmenter.segment(text)].map((x) => x.segment) : text.split(/(\s+)/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (chars(cur) + chars(w) > max && cur.trim()) { out.push(cur.trim()); cur = ''; }
    if (chars(w) > max) { for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max)); continue; }
    cur += w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Break a cue's text into at most two lines near the middle, at a word boundary. */
export function twoLines(text, max = 42) {
  if (chars(text) <= max) return text;
  const words = segmenter ? [...segmenter.segment(text)].map((x) => x.segment) : text.split(/(\s+)/);
  const half = chars(text) / 2;
  let acc = '';
  let best = null;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i];
    const d = Math.abs(chars(acc) - half);
    if (!best || d < best.d) best = { d, at: acc.length };
  }
  return best ? `${text.slice(0, best.at).trim()}\n${text.slice(best.at).trim()}` : text;
}

/**
 * Cues for one part of an export plan (core/plan.js).
 * @param {{segments:{globalStart:number,duration:number}[]}} part
 * @param {{start:number,end:number,text:string,speaker?:string}[]} spans  transcript spans on the timeline
 * @returns {{start:number,end:number,text:string}[]}  times in the part's own clock
 */
export function partCues(part, spans, { speakers = true, maxChars = 84 } = {}) {
  let off = 0;
  const segs = part.segments.map((s) => { const r = { g0: s.globalStart, g1: s.globalStart + s.duration, o0: off }; off += s.duration; return r; });
  const cues = [];
  for (const sp of spans) {
    const iv = [];
    for (const s of segs) {
      const a = Math.max(sp.start, s.g0);
      const b = Math.min(sp.end, s.g1);
      if (b - a > 0.05) iv.push([s.o0 + a - s.g0, s.o0 + b - s.g0]);
    }
    // a line that runs across a cut is continuous in the output: one cue
    const merged = [];
    for (const r of iv) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] < 0.1) last[1] = r[1]; else merged.push([...r]);
    }
    const text = speakers && sp.speaker ? `${sp.speaker}: ${sp.text}` : sp.text;
    for (const [a, b0] of merged) {
      if (b0 - a < 0.3) continue;
      const chunks = chunkText(text, maxChars);
      const b = Math.min(b0, a + speakingTime(text) * 1.5 + 2); // do not leave a short line on screen through a silence
      const total = chunks.reduce((acc, c) => acc + chars(c), 0) || 1;
      let t = a;
      for (const c of chunks) {
        const d = ((b - a) * chars(c)) / total;
        cues.push({ start: t, end: t + d, text: twoLines(c) });
        t += d;
      }
    }
  }
  cues.sort((x, y) => x.start - y.start);
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.02);
  return cues.filter((c) => c.end - c.start >= 0.2);
}

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.text.replace(/\n/g, '\r\n')}\r\n`).join('\r\n');
}
