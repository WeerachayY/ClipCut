// WebVTT (.vtt, e.g. from Teams / Zoom / YouTube) and SubRip (.srt).
import { parseTimecode } from '../../core/time.js';

const CUE_RE = /(\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

export function parseCues(text) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  const lines = [];
  for (const block of blocks) {
    const rows = block.split('\n');
    const i = rows.findIndex((r) => CUE_RE.test(r));
    if (i < 0) continue;
    const startStr = rows[i].split('-->')[0].trim();
    const tau = parseTimecode(startStr.split(':').length === 2 ? `0:${startStr}` : startStr);
    let body = rows.slice(i + 1).join(' ').trim();
    let speaker = '';
    const v = body.match(/^<v(?:\.[^ >]*)?\s+([^>]+)>/);
    if (v) speaker = v[1].trim();
    body = body.replace(/<[^>]+>/g, '').trim();
    const colon = !speaker && body.match(/^([^:]{1,40}):\s+(.*)$/);
    if (colon) { speaker = colon[1]; body = colon[2]; }
    if (Number.isFinite(tau) && body) lines.push({ tau, speaker, text: body });
  }
  return lines;
}

export default {
  id: 'vtt',
  label: 'คำบรรยาย .vtt / .srt',
  extensions: ['.vtt', '.srt'],
  async parse(file) {
    const lines = parseCues(await file.text());
    if (!lines.length) throw new Error('ไม่พบช่วงเวลาในไฟล์คำบรรยาย');
    return { lines };
  },
};
