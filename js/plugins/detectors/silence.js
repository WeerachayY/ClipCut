// Audio silence, measured by ffmpeg's silencedetect filter (audio only, no video decoding).
import { formatDuration } from '../../core/time.js';

export function parseSilenceLog(lines, fileDuration) {
  const ranges = [];
  let start = null;
  for (const l of lines) {
    let m = l.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { start = Math.max(0, Number(m[1])); continue; }
    m = l.match(/silence_end:\s*([\d.]+)/);
    if (m && start != null) { ranges.push({ start, end: Number(m[1]) }); start = null; }
  }
  // silence that runs to the end of the file never prints silence_end
  if (start != null && Number.isFinite(fileDuration)) ranges.push({ start, end: fileDuration });
  return ranges;
}

export default {
  id: 'silence',
  label: 'เสียงเงียบ',
  description: 'วัดจากเสียงจริงในวิดีโอ ใช้ปรับขอบช่วงตัดให้แม่นขึ้น (ใช้เวลาวิเคราะห์ราว 1 นาทีต่อชั่วโมง)',
  needs: 'audio',
  defaults: { noiseDb: -35, minSilence: 15, standaloneMin: 90 },
  // changing these needs a new ffmpeg pass; other settings only re-run detect()
  analysisKeys: ['noiseDb', 'minSilence'],
  settings: [
    { key: 'noiseDb', label: 'ถือว่าเงียบเมื่อเสียงต่ำกว่า', type: 'number', unit: 'dB', min: -80, max: -10, step: 1 },
    { key: 'minSilence', label: 'นับเฉพาะช่วงเงียบยาวกว่า', type: 'number', unit: 'วินาที', min: 2, step: 1 },
    { key: 'standaloneMin', label: 'เสนอตัดแม้ไม่มี transcript เมื่อเงียบเกิน', type: 'number', unit: 'วินาที', min: 30, step: 10 },
  ],
  /** Output args for the shared per-file pass (the audio is decoded once for all detectors and layers). */
  ffmpegOutput(p) {
    return ['-map', '0:a:0', '-af', `silencedetect=noise=${p.noiseDb}dB:d=${p.minSilence}`, '-f', 'null', '-'];
  },
  /** Args for one input file on its own; output goes to the log. */
  ffmpegArgs(inputPath, p) {
    return ['-hide_banner', '-i', inputPath, '-vn', '-sn', '-dn', ...this.ffmpegOutput(p)];
  },
  parseLog: parseSilenceLog,
  detect(ctx, p) {
    const ranges = ctx.analysis?.[this.id] || [];
    return ranges.map((r) => ({ role: 'refiner', source: this.id, signal: 'audio', start: r.start, end: r.end, label: `เสียงเงียบ ${formatDuration(r.end - r.start)}` }));
  },
  combineOptions: (p) => ({ standaloneMin: p.standaloneMin }),
};
