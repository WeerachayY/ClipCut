// Media analysis that needs ffmpeg: runs every enabled detector with needs:'audio' or 'video'
// over each file (one ffmpeg pass per detector per file) and converts results to global time.
import { detectors } from '../core/registry.js';
import { mergeRanges } from '../core/plan.js';
import { ffmpeg } from './ffmpeg.js';

/** Codec summary lines ("Stream #0:0 ... Video: h264 ...") so we can warn when files differ. */
export async function readStreamInfo(files) {
  const paths = await ffmpeg.mountInputs(files);
  const out = [];
  for (const p of paths) {
    const { log } = await ffmpeg.run(['-hide_banner', '-i', p]);
    const streams = log.filter((l) => /Stream #\d+:\d+.*(Video|Audio):/.test(l)).map((l) => l.replace(/^.*?(Video|Audio):/, '$1:').replace(/\(\[.*?\]\s*\/\s*0x[0-9a-f]+\)/gi, '').trim());
    out.push(streams);
  }
  return out;
}

/**
 * Keyframe times by listing packets with ffprobe (no decoding). Fallback for files the
 * MP4 index reader cannot handle, e.g. fragmented MP4.
 * @returns {Promise<{keyframes:number[], packets:number}|null>}
 */
export async function keyframesViaFfprobe(path) {
  const out = '/keyframes.txt';
  await ffmpeg.probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path, '-o', out]);
  let text = '';
  try { text = new TextDecoder().decode(await ffmpeg.readFile(out)); } catch { return null; }
  await ffmpeg.deleteFile(out);
  const rows = text.split('\n').filter((l) => /^-?[\d.]+,/.test(l));
  const kf = rows.filter((l) => /,\s*K/.test(l)).map((l) => Number(l.split(',')[0])).filter(Number.isFinite).sort((a, b) => a - b);
  return kf.length ? { keyframes: kf, packets: rows.length } : null;
}

/** Signature of what concat -c copy cares about: codec, profile, size, sample rate, channels. */
export function compatSignature(streams) {
  return streams.map((s) => {
    if (s.startsWith('Video:')) {
      const codec = s.match(/^Video:\s*(\w+)/)?.[1];
      const size = s.match(/(\d{2,5}x\d{2,5})/)?.[1];
      const pix = s.match(/\b(yuv\w+|nv12|rgb\w*)/)?.[1];
      return `V:${codec}:${size}:${pix}`;
    }
    const codec = s.match(/^Audio:\s*(\w+)/)?.[1];
    const rate = s.match(/(\d+) Hz/)?.[1];
    const ch = s.match(/Hz,\s*([^,]+)/)?.[1];
    return `A:${codec}:${rate}:${ch}`;
  }).join(' ');
}

/**
 * @param {{videos:{file:File,duration:number}[], timeline, settings:object, onProgress?:(info)=>void}} args
 * @returns {Promise<object>} {detectorId: [{start,end}] in global time}
 */
export const isMediaDetector = (d) => d.needs === 'audio' || d.needs === 'video';

export async function runMediaAnalysis({ videos, timeline, settings, only, onProgress }) {
  const audioDetectors = detectors().filter((d) => isMediaDetector(d) && (settings[d.id]?.enabled ?? d.enabledByDefault !== false) && (!only || only.includes(d.id)));
  const result = {};
  if (!audioDetectors.length) return result;
  await ffmpeg.load((msg) => onProgress?.({ message: msg, ratio: 0 }));
  const paths = await ffmpeg.mountInputs(videos.map((v) => v.file));
  const total = timeline.duration * audioDetectors.length || 1;
  let doneBefore = 0;
  for (const d of audioDetectors) {
    const p = { ...(d.defaults || {}), ...(settings[d.id] || {}) };
    const ranges = [];
    for (let i = 0; i < videos.length; i++) {
      const f = timeline.files[i];
      onProgress?.({ message: `${d.label}: ไฟล์ ${i + 1}/${videos.length}`, ratio: doneBefore / total });
      const { code, log } = await ffmpeg.run(d.ffmpegArgs(paths[i], p), {
        onTime: (t) => onProgress?.({ message: `${d.label}: ไฟล์ ${i + 1}/${videos.length}`, ratio: (doneBefore + Math.min(t, f.duration)) / total }),
      });
      if (code !== 0) throw new Error(`วิเคราะห์ ${f.name} ไม่สำเร็จ (ffmpeg code ${code})`);
      for (const r of d.parseLog(log, f.duration)) ranges.push({ start: f.start + r.start, end: f.start + Math.min(r.end, f.duration) });
      doneBefore += f.duration;
    }
    result[d.id] = mergeRanges(ranges, 0.5);
  }
  onProgress?.({ message: 'วิเคราะห์เสร็จ', ratio: 1 });
  return result;
}
