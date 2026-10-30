// Long stretches where nobody said anything in the transcript.
import { formatDuration, clamp } from '../../core/time.js';

/** Rough end of an utterance: transcripts only give the start time. */
export const estimateEnd = (line, rate) => line.g + clamp(line.text.replace(/\s+/g, '').length / rate, 1.5, 25);

export default {
  id: 'transcript-gap',
  label: 'ช่องว่างใน transcript',
  description: 'ช่วงที่ไม่มีใครพูดนานเกินกำหนด รวมช่วงก่อนเริ่มและหลังจบประชุม',
  needs: 'transcript',
  defaults: { minGap: 180, leadMin: 60, tailMin: 60, charsPerSec: 12, padBefore: 1.5, padAfter: 1 },
  settings: [
    { key: 'minGap', label: 'เงียบนานกว่า', type: 'number', unit: 'วินาที', min: 30, step: 10 },
    { key: 'leadMin', label: 'ช่วงก่อนเริ่มพูดยาวกว่า', type: 'number', unit: 'วินาที', min: 10, step: 10 },
    { key: 'tailMin', label: 'ช่วงหลังประโยคสุดท้ายยาวกว่า', type: 'number', unit: 'วินาที', min: 10, step: 10 },
  ],
  detect(ctx, p) {
    const { lines, duration } = ctx;
    if (!lines || !lines.length) return [];
    const out = [];
    const first = lines[0];
    if (first.g >= p.leadMin) {
      out.push({ role: 'primary', source: this.id, signal: 'transcript', start: 0, end: first.g - p.padBefore, minStart: 0, maxEnd: first.g, label: `ก่อนเริ่มพูด ${formatDuration(first.g)}` });
    }
    for (let i = 0; i < lines.length - 1; i++) {
      const a = lines[i];
      const b = lines[i + 1];
      const gap = b.g - a.g;
      if (gap < p.minGap) continue;
      const start = estimateEnd(a, p.charsPerSec) + p.padAfter;
      const end = b.g - p.padBefore;
      if (end <= start) continue;
      out.push({ role: 'primary', source: this.id, signal: 'transcript', start, end, minStart: a.g + 1, maxEnd: b.g, label: `ไม่มีใครพูด ${formatDuration(gap)} (transcript)` });
    }
    const last = lines[lines.length - 1];
    const lastEnd = estimateEnd(last, p.charsPerSec) + p.padAfter;
    if (duration - lastEnd >= p.tailMin) {
      out.push({ role: 'primary', source: this.id, signal: 'transcript', start: lastEnd, end: duration, minStart: last.g + 1, maxEnd: duration, label: `หลังประโยคสุดท้าย ${formatDuration(duration - lastEnd)}` });
    }
    return out;
  },
};
