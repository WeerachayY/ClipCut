// Media analysis that needs ffmpeg: runs every enabled detector with needs:'audio' or 'video'
// over each file (one ffmpeg pass per detector per file) and converts results to global time.
import { detectors, mediaLayers } from '../core/registry.js';
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

export const isMediaDetector = (d) => d.needs === 'audio' || d.needs === 'video';

async function hasAudioStream(path) {
  const { log } = await ffmpeg.run(['-hide_banner', '-i', path]);
  return log.some((l) => /Stream #\d+:\d+.*Audio:/.test(l));
}

/**
 * Measure the recordings: media detectors (e.g. silence) and media layers (e.g. the waveform).
 * Everything that has `ffmpegOutput` shares one ffmpeg pass per file, so the audio is decoded once.
 * @param {{videos:{file:File}[], timeline, settings:object, only?:string[], layers?:string[], onProgress?:(info)=>void}} args
 *   only = detector ids to run (default: every enabled media detector), layers = media layer ids to build
 * @returns {Promise<{analysis: object, layers: object}>} analysis = {detectorId: [{start,end}]}, layers = {layerId: data}, global time
 */
export async function runMediaAnalysis({ videos, timeline, settings, only, layers: layerIds = [], onProgress }) {
  const dets = detectors().filter((d) => isMediaDetector(d) && (settings[d.id]?.enabled ?? d.enabledByDefault !== false) && (!only || only.includes(d.id)));
  const lays = mediaLayers().filter((l) => layerIds.includes(l.id));
  const analysis = {};
  const layers = {};
  if (!dets.length && !lays.length) return { analysis, layers };
  await ffmpeg.load((msg) => onProgress?.({ message: msg, ratio: 0 }));
  const paths = await ffmpeg.mountInputs(videos.map((v) => v.file));
  const total = timeline.duration || 1;
  const params = (d) => ({ ...(d.defaults || {}), ...(settings[d.id] || {}) });
  const ranges = Object.fromEntries(dets.map((d) => [d.id, []]));
  const perFile = Object.fromEntries(lays.map((l) => [l.id, []]));
  const what = [...dets, ...lays].map((x) => x.label).join(' และ ');

  for (let i = 0; i < videos.length; i++) {
    const f = timeline.files[i];
    const message = videos.length > 1 ? `${what}: ไฟล์ ${i + 1}/${videos.length}` : what;
    const progress = (t) => onProgress?.({ message, ratio: Math.min(1, (f.start + Math.min(t, f.duration)) / total) });
    progress(0);
    const audio = await hasAudioStream(paths[i]);
    const usable = (x) => x.needs !== 'audio' || audio;
    const shared = dets.filter((d) => d.ffmpegOutput && usable(d));
    const alone = dets.filter((d) => !d.ffmpegOutput && usable(d));
    const outPath = (l) => `/layer-${l.id}.bin`;
    const layHere = lays.filter(usable);
    for (const l of lays.filter((x) => !usable(x))) perFile[l.id].push({ data: null, file: f });

    const outs = [...shared.flatMap((d) => d.ffmpegOutput(params(d))), ...layHere.flatMap((l) => l.ffmpegOutput(outPath(l)))];
    if (outs.length) {
      const { code, log } = await ffmpeg.run(['-hide_banner', '-i', paths[i], ...outs], { onTime: progress });
      if (code !== 0) throw new Error(`วิเคราะห์ ${f.name} ไม่สำเร็จ (ffmpeg code ${code})`);
      for (const d of shared) ranges[d.id].push(...toGlobal(d.parseLog(log, f.duration), f));
      for (const l of layHere) {
        const bytes = await ffmpeg.readFile(outPath(l));
        await ffmpeg.deleteFile(outPath(l)).catch(() => {});
        perFile[l.id].push({ data: l.collect({ bytes, file: f }), file: f });
      }
    }
    for (const d of alone) {
      const { code, log } = await ffmpeg.run(d.ffmpegArgs(paths[i], params(d)), { onTime: progress });
      if (code !== 0) throw new Error(`วิเคราะห์ ${f.name} ไม่สำเร็จ (ffmpeg code ${code})`);
      ranges[d.id].push(...toGlobal(d.parseLog(log, f.duration), f));
    }
  }
  for (const d of dets) analysis[d.id] = mergeRanges(ranges[d.id], 0.5);
  for (const l of lays) layers[l.id] = { ...l.combine(perFile[l.id], timeline.duration), version: l.version };
  onProgress?.({ message: 'วิเคราะห์เสร็จ', ratio: 1 });
  return { analysis, layers };
}

const toGlobal = (rs, f) => rs.map((r) => ({ start: f.start + r.start, end: f.start + Math.min(r.end, f.duration) }));
