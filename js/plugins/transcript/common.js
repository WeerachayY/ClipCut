import { parseTimecode } from '../../core/time.js';

// "[00:01:34] Speaker Name: text"  (common export format of note-taking / transcription bots)
const LINE_RE = /^\s*\[(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]\s*([^:：]{1,80}?)\s*[:：]\s*(.*)$/;

/** Parse paragraphs/lines of "[time] speaker: text". Lines without a timestamp continue the previous entry. */
export function parseBracketLines(paragraphs) {
  const lines = [];
  for (const raw of paragraphs) {
    const p = raw.replace(/ /g, ' ').trim();
    if (!p) continue;
    const m = p.match(LINE_RE);
    if (m) {
      const tau = parseTimecode(m[1].split(':').length === 2 ? `0:${m[1]}` : m[1]);
      if (Number.isFinite(tau)) { lines.push({ tau, speaker: m[2].trim(), text: m[3].trim() }); continue; }
    }
    if (lines.length) lines[lines.length - 1].text += ` ${p}`;
  }
  return lines;
}

const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

/**
 * Removes the repeated lines live-transcription bots emit (same speaker, a few seconds apart,
 * one text containing the other). Keeps the earliest time and the longest text.
 */
export function dedupeLines(lines, windowSec = 20) {
  const out = [];
  let removed = 0;
  for (const line of lines) {
    const n = norm(line.text);
    const dup = out.slice(-4).reverse().find((o) =>
      o.speaker === line.speaker && line.tau - o.tau <= windowSec && n.length > 0 &&
      (norm(o.text).includes(n) || n.includes(norm(o.text))));
    if (dup) {
      if (line.text.length > dup.text.length) dup.text = line.text;
      removed++;
      continue;
    }
    out.push({ ...line });
  }
  out.sort((a, b) => a.tau - b.tau);
  out.forEach((l, i) => { l.idx = i; });
  return { lines: out, removed };
}

export function looksLikeBracketTranscript(text) {
  const sample = text.split(/\r?\n/).slice(0, 40);
  return sample.filter((l) => LINE_RE.test(l)).length >= Math.min(3, sample.length);
}
