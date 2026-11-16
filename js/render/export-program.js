// Export of a program (core/program.js) when it is more than plain cuts: composition overlays, music,
// speed changes, or a render-only profile. Three ways, chosen by the profile:
//   gpu       sound by ffmpeg (core/audiograph.js), pictures by the browser's encoder (render/gpu.js)
//   copy-mix  pictures copied as they are (like the lossless profile), only the sound mixed again
//   audio     sound only (audio jobs, and "sound only" from a video job)
import { ffmpeg } from '../media/ffmpeg.js';
import { buildConcatList } from '../core/plan.js';
import { clipsInWindow } from '../core/program.js';
import { drawOrder, hasAudioMix } from '../core/compose.js';
import { partAudioArgs, audioOut } from '../core/audiograph.js';
import { partFileName, outputExtension } from '../media/export.js';
import { renderPartVideo, outputSize } from './gpu.js';
import { mediabunny } from './assets.js';

/** Number of sound channels of each recording (0 = no sound). */
async function channelsOf(files) {
  const MB = await mediabunny();
  return Promise.all(files.map(async (f) => {
    try { return (await new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(f) }).getPrimaryAudioTrack())?.numberOfChannels || 0; } catch { return 2; }
  }));
}

/** Size of the first recording's picture. */
async function pictureSize(file) {
  const MB = await mediabunny();
  const t = await new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) }).getPrimaryVideoTrack();
  return t ? { width: t.displayWidth, height: t.displayHeight } : { width: 1280, height: 720 };
}

/**
 * @param {object} o
 * @param {'gpu'|'copy-mix'|'audio'} o.mode
 * @param {object} o.program        core/program.js
 * @param {object} o.plan           the plan the program was made from (copy-mix copies its merged segments)
 * @param {object} o.timeline
 * @param {File[]} o.files          recordings by fileIndex
 * @param {object} o.compose        core/compose.js (may be empty)
 * @param {import('./assets.js').AssetLibrary} o.assets
 * @param {object} o.profile
 * @param {object} o.options        the profile's options
 * @param {string} o.outputBase
 * @param {(name, bytes)=>Promise<void>} o.writeOutput
 * @param {((name)=>Promise<{writable:WritableStream, size:()=>Promise<number>}>)|null} o.openOutput  stream to disk (folder jobs)
 * @param {(p)=>void} o.onProgress  {part, parts, ratio, speed, message}
 * @param {{aborted:boolean}} o.signal
 * @returns {Promise<{name, bytes, duration}[]>}
 */
export async function exportProgram({ mode, program, plan, timeline, files, compose, assets, profile, options, outputBase, writeOutput, openOutput, onProgress, signal }) {
  const parts = program.parts;
  const ext = outputExtension(profile, timeline, options);
  const say = (part, ratio, message, speed = null) => onProgress?.({ part: part.index, parts: parts.length, ratio, speed, message });
  await ffmpeg.load((m) => onProgress?.({ part: 0, parts: parts.length, ratio: 0, message: m }));

  const clips = compose?.clips || [];
  const used = [...new Set(clips.map((c) => c.asset).filter(Boolean))].map((id) => assets.get(id)).filter(Boolean);
  const paths = await ffmpeg.mountInputs([...files, ...used.map((a) => a.file)]);
  const mainPaths = paths.slice(0, files.length);
  const assetPaths = Object.fromEntries(used.map((a, i) => [a.id, paths[files.length + i]]));
  const assetHasAudio = Object.fromEntries(used.map((a) => [a.id, a.kind === 'audio' || !!a.hasAudio]));
  const mainChannels = await channelsOf(files);
  const mainHasAudio = mainChannels.map((n) => n > 0);
  const assetChannels = Object.fromEntries(used.map((a) => [a.id, a.channels || 2]));
  const size = mode === 'gpu' ? outputSize(...Object.values(await pictureSize(files[0])), Number(options.height) || null) : null;
  const fps = Math.min(60, Math.round(timeline.fps || 30) || 30);

  const results = [];
  for (const part of parts) {
    if (signal?.aborted) throw Object.assign(new Error('ยกเลิกแล้ว'), { name: 'AbortError' });
    const name = partFileName(outputBase, part, parts.length, ext);
    const inPart = clipsInWindow(clips, part.start, part.start + part.duration);
    const sounding = inPart.filter((c) => c.kind === 'audio' || c.kind === 'video');
    const started = performance.now();
    const audioArgs = (outArgs, leadInputs = []) => partAudioArgs({
      part, mainPaths, mainHasAudio, mainChannels, clips: sounding, assetPaths, assetHasAudio, assetChannels, mainVolume: compose?.mainVolume ?? 1, leadInputs, outArgs,
    });
    const runFfmpeg = async (args, outPath, from, to, message) => {
      const { code, log } = await ffmpeg.run(args, {
        onTime: (t) => {
          const el = (performance.now() - started) / 1000;
          say(part, from + (to - from) * Math.min(1, t / Math.max(0.1, part.duration)), message, el > 1 ? t / el : null);
        },
      });
      if (code !== 0) {
        await ffmpeg.deleteFile(outPath);
        throw new Error(`สร้าง ${name} ไม่สำเร็จ\n${log.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-6).join('\n')}`);
      }
      const bytes = await ffmpeg.readFile(outPath);
      await ffmpeg.deleteFile(outPath);
      return bytes;
    };

    if (mode === 'audio') {
      const out = `/prog${part.index}.${ext}`;
      const bytes = await runFfmpeg(audioArgs(audioOut(ext, out, options.bitrate || '192k')), out, 0, 1, `กำลังทำเสียง ${name}`);
      await writeOutput(name, bytes);
      results.push({ name, bytes: bytes.byteLength, duration: part.duration });
      continue;
    }

    if (mode === 'copy-mix') {
      // the picture straight from the recordings (keyframe-aligned plan), the sound mixed again
      const list = `/list${part.index}.txt`;
      // the plan's segments, not the program's: pieces next to each other must stay one stretch of copied picture
      await ffmpeg.writeText(list, buildConcatList(plan.parts[part.index], (i) => mainPaths[i]));
      const out = `/out${part.index}.mp4`;
      const args = audioArgs(['-map', '0:v:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', out],
        ['-f', 'concat', '-safe', '0', '-i', list]);
      const bytes = await runFfmpeg(args, out, 0, 1, `กำลังต่อไฟล์และผสมเสียง ${name}`);
      await ffmpeg.deleteFile(list);
      await writeOutput(name, bytes);
      results.push({ name, bytes: bytes.byteLength, duration: part.duration });
      continue;
    }

    // gpu: sound first (quick), then the pictures
    let audio = null;
    if (mainHasAudio.some(Boolean) || (hasAudioMix(compose) && sounding.length)) {
      const out = `/mix${part.index}.m4a`;
      audio = await runFfmpeg(audioArgs(audioOut('m4a', out, '160k')), out, 0, 0.08, `กำลังทำเสียง ${name}`);
    }
    const target = openOutput ? await openOutput(name) : null;
    const visual = drawOrder(compose || { tracks: [], clips: [] }, inPart);
    const bytes = await renderPartVideo({
      part, mainFiles: files, clips: visual, assets, size, fps, quality: options.quality || 'high', audio,
      writable: target?.writable || null, signal,
      onProgress: ({ ratio, fps: done }) => say(part, 0.08 + 0.92 * ratio, `กำลังเรนเดอร์ภาพ ${name} (${size.width}×${size.height})`, done ? done / fps : null),
    });
    if (bytes) await writeOutput(name, bytes);
    results.push({ name, bytes: bytes ? bytes.byteLength : await target.size(), duration: part.duration });
  }
  return results;
}

/** What a composition asks of the export: subset of ['audio', 'speed', 'visual']. */
export function needsOf(compose, program, kind) {
  const out = [];
  if (hasAudioMix(compose)) out.push('audio');
  if (program.speedChanged) out.push('speed');
  if (kind === 'video' && compose?.clips?.some((c) => c.kind !== 'audio')) out.push('visual');
  return out;
}
