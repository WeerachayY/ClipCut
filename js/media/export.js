// Executes an export plan part by part with the chosen export profile.
import { buildConcatList, estimatePartBytes } from '../core/plan.js';
import { ffmpeg } from './ffmpeg.js';

export const MAX_OUTPUT_BYTES = 1.9 * 1024 ** 3; // browser memory ceiling for one output file

export const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

export function partFileName(base, part, count, ext = 'mp4') {
  const b = safeName(base) || 'meeting';
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
  const results = [];
  for (const part of parts) {
    const listPath = `/list${part.index}.txt`;
    const outPath = `/out${part.index}.${profile.outputExtension || 'mp4'}`;
    const name = partFileName(outputBase, part, parts.length, profile.outputExtension || 'mp4');
    await ffmpeg.writeText(listPath, buildConcatList(part, (i) => paths[i]));
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
    const { code, log } = await ffmpeg.run(profile.buildArgs({ listPath, outPath, options }), { onTime: report });
    if (code !== 0) {
      await ffmpeg.deleteFile(outPath);
      const tail = log.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-6).join('\n');
      throw new Error(`สร้าง ${name} ไม่สำเร็จ\n${tail}`);
    }
    onProgress?.({ part: part.index, parts: parts.length, ratio: 1, speed: null, message: `กำลังบันทึก ${name}` });
    const data = await ffmpeg.readFile(outPath);
    await ffmpeg.deleteFile(outPath);
    await ffmpeg.deleteFile(listPath);
    await writeOutput(name, data);
    results.push({ name, bytes: data.byteLength, duration: part.duration });
  }
  return results;
}
