// Words that announce a break ("พักเบรก 10 นาที") or the return from one ("กลับมาแล้ว").
import { formatDuration } from '../../core/time.js';
import { estimateEnd } from './transcript-gap.js';

const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

/** "a, b, /regex/" -> matchers */
export function compileWords(list) {
  return String(list).split(/[,\n]/).map((w) => w.trim()).filter(Boolean).map((w) => {
    const rx = w.match(/^\/(.+)\/$/);
    if (rx) { const re = new RegExp(rx[1], 'i'); return { label: w, test: (t) => { const m = t.match(re); return m ? m[0] : null; } }; }
    const n = norm(w);
    return { label: w, test: (t) => (t.includes(n) ? w : null) };
  });
}

export default {
  id: 'keywords',
  label: 'คำบอกเบรก',
  description: 'คำที่ประกาศพักหรือกลับมาจากพัก ใช้ยืนยันขอบของช่วงตัด',
  needs: 'transcript',
  defaults: {
    breakWords: 'พักเบรก, เบรก, พักก่อน, พักสักครู่, /พัก\\d+นาที/, ไปห้องน้ำ, พักทานข้าว, พักกินข้าว, พักเที่ยง, coffee break',
    resumeWords: 'กลับมาแล้ว, กลับมาจากเบรก, เริ่มกันต่อ, มาต่อกัน, ต่อกันเลย, เรามาต่อ, เริ่มต่อ, we\'re back, welcome back',
    pairMaxMinutes: 90,
    pairMaxLinesPerMinute: 1,
    charsPerSec: 12,
  },
  settings: [
    { key: 'breakWords', label: 'คำประกาศพัก (คั่นด้วย ,)', type: 'text' },
    { key: 'resumeWords', label: 'คำบอกว่ากลับมาแล้ว (คั่นด้วย ,)', type: 'text' },
  ],
  detect(ctx, p) {
    const { lines } = ctx;
    if (!lines || !lines.length) return [];
    const breakers = compileWords(p.breakWords);
    const resumers = compileWords(p.resumeWords);
    const out = [];
    const marks = [];
    for (const line of lines) {
      const t = norm(line.text);
      const b = breakers.map((m) => m.test(t)).find(Boolean);
      const r = resumers.map((m) => m.test(t)).find(Boolean);
      if (b) { const at = estimateEnd(line, p.charsPerSec); marks.push({ kind: 'break-start', line, at, word: b }); out.push({ role: 'evidence', kind: 'break-start', at, source: this.id, label: `พบคำว่า “${b}”` }); }
      if (r) { marks.push({ kind: 'break-end', line, at: line.g, word: r }); out.push({ role: 'evidence', kind: 'break-end', at: line.g, source: this.id, label: `พบคำว่า “${r}”` }); }
    }
    // A break announcement followed by a "we're back" with little talk in between.
    for (const s of marks.filter((m) => m.kind === 'break-start')) {
      const e = marks.find((m) => m.kind === 'break-end' && m.at - s.at >= 120 && m.at - s.at <= p.pairMaxMinutes * 60);
      if (!e) continue;
      const between = lines.filter((l) => l.g > s.line.g && l.g < e.line.g).length;
      const minutes = (e.at - s.at) / 60;
      if (between / minutes > p.pairMaxLinesPerMinute) continue;
      out.push({ role: 'primary', source: this.id, signal: 'keyword', start: s.at + 1, end: e.at - 1.5, minStart: s.line.g + 1, maxEnd: e.line.g, label: `ระหว่าง “${s.word}” ถึง “${e.word}” ${formatDuration(e.at - s.at)}` });
    }
    return out;
  },
};
