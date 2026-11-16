// Executes an export plan part by part with the chosen export profile.
import { buildConcatList, estimatePartBytes } from '../core/plan.js';
import { ffmpeg } from './ffmpeg.js';
import { readStreamInfo } from './analyze.js';

export const MAX_OUTPUT_BYTES = 1.9 * 1024 ** 3; // browser memory ceiling for one output file

export const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

/** Output file extension of a profile for this timeline (audio profiles follow the source format). */
export const outputExtension = (profile, timeline, options = {}) => (typeof profile.outputExtension === 'function' ? profile.outputExtension(timeline, options) : profile.outputExtension) || 'mp4';

/** Export profiles that fit this timeline (video or audio job). */
export const profilesFor = (profiles, timeline) => profiles.filter((p) => (p.media || 'video') === timeline.kind);

export function partFileName(base, part, count, ext = 'mp4') {
  const b = safeName(base) || 'video';
  if (count <= 1) return `${b}.${ext}`;
  const n = String(part.index + 1).padStart(2, '0');
  const label = safeName(part.label || '');
  return `${b}_part${n}${label ? `_${label}` : ''}.${ext}`;
}

/**
 * @param {object} a
 * @param {object} a.plan        from buildPlan()
 * @param {object} a.timeline
 * @param {File[]} a.files       source videos in timeline order
 * @param {object} a.profile     export profile plugin
 * @param {object} a.options     profile options
 * @param {string} a.outputBase
 * @param {(name:string, data:Uint8Array)=>Promise<void>} a.writeOutput
 * @param {(info:{part:number,parts:number,ratio:number,speed:number|null,message:string})=>void} [a.onProgress]
 */
export async function runExport({ plan, timeline, files, profile, options, outputBase, writeOutput, onProgress }) {
  const parts = plan.parts;
  if (profile.speed === 'fast') {
    const big = parts.find((p) => estimatePartBytes(p, timeline) > MAX_OUTPUT_BYTES);
    if (big) throw new Error('ไฟล์ผลลัพธ์ใหญ่เกิน ~1.9 GB ซึ่งเกินหน่วยความจำของ browser ลองเพิ่มจุดแบ่งไฟล์ หรือเลือกแบบบีบอัด');
  }
  await ffmpeg.load((m) => onProgress?.({ part: 0, parts: parts.length, ratio: 0, speed: null, message: m }));
  const paths = await ffmpeg.mountInputs(files);
  let hasAudio = true;
  if (profile.needsStreamInfo) {
    const info = await readStreamInfo(files);
    hasAudio = info.every((streams) => streams.some((x) => x.startsWith('Audio')));
  }
  const results = [];
  const ext = outputExtension(profile, timeline);
  const fail = async (name, log, outPath) => {
    await ffmpeg.deleteFile(outPath).catch(() => {});
    const tail = log.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-6).join('\n');
    throw new Error(`สร้าง ${name} ไม่สำเร็จ\n${tail}`);
  };
  for (const part of parts) {
    const listPath = `/list${part.index}.txt`;
    const outPath = `/out${part.index}.${ext}`;
    const name = partFileName(outputBase, part, parts.length, ext);
    const started = performance.now();
    const report = (t) => {
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.({
        part: part.index, parts: parts.length,
        ratio: Math.min(1, t / Math.max(0.1, part.duration)),
        speed: elapsed > 1 ? t / elapsed : null,
        message: `กำลังสร้าง ${name}`,
      });
    };
    report(0);
    if (profile.perSegment) {
      // cut every segment on its own, then join the pieces (a single piece is the result as it is)
      const tmp = [];
      let done = 0;
      for (const [k, segment] of part.segments.entries()) {
        const segPath = part.segments.length === 1 ? outPath : `/seg${part.index}_${k}.${ext}`;
        const { code, log } = await ffmpeg.run(profile.perSegment.segmentArgs({ inputPath: paths[segment.fileIndex], segment, outPath: segPath, options }), {
          // -ss as an output option: the clock runs from the start of the file, and from 0 once inside the piece
          onTime: (t) => report(done + Math.min(segment.duration, Math.max(0, t))),
        });
        if (code !== 0) await fail(name, log, segPath);
        tmp.push(segPath);
        done += segment.duration;
        report(done);
      }
      if (tmp.length > 1) {
        await ffmpeg.writeText(listPath, `ffconcat version 1.0\n${tmp.map((p) => `file '${p}'`).join('\n')}\n`);
        const { code, log } = await ffmpeg.run(profile.perSegment.joinArgs({ listPath, outPath, options }));
        for (const p of tmp) await ffmpeg.deleteFile(p).catch(() => {});
        if (code !== 0) await fail(name, log, outPath);
      }
    } else {
      await ffmpeg.writeText(listPath, buildConcatList(part, (i) => paths[i]));
      const args = profile.buildArgs({ listPath, outPath, options, segments: part.segments, inputPaths: paths, hasAudio });
      const { code, log } = await ffmpeg.run(args, { onTime: report });
      if (code !== 0) await fail(name, log, outPath);
    }
    onProgress?.({ part: part.index, parts: parts.length, ratio: 1, speed: null, message: `กำลังบันทึก ${name}` });
    const data = await ffmpeg.readFile(outPath);
    await ffmpeg.deleteFile(outPath);
    await ffmpeg.deleteFile(listPath).catch(() => {});
    await writeOutput(name, data);
    results.push({ name, bytes: data.byteLength, duration: part.duration });
  }
  return results;
}
