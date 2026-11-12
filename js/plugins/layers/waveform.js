// Loudness envelope for the audio track: mean absolute level, 1000 values per second (1 ms), mono.
// Fine enough to see where a word starts; an hour is 3.6 MB kept with the job.
// Comes out of the same ffmpeg pass as silence detection, so the audio is decoded only once.
export const RATE = 1000;

/** Mean absolute level per 1/RATE s (float32 from ffmpeg) → Uint8 0..255 after a gain that puts loud speech near the top. */
export function toBytes(levels) {
  if (!levels.length) return new Uint8Array(0);
  // 98th percentile as full scale: one loud bang does not flatten everything else
  // (from a sample of the values: sorting millions of them is slow and changes nothing)
  const stride = Math.max(1, Math.floor(levels.length / 200000));
  const sample = new Float32Array(Math.ceil(levels.length / stride));
  for (let i = 0, k = 0; i < levels.length; i += stride) sample[k++] = levels[i];
  sample.sort();
  const ref = Math.max(sample[Math.floor(sample.length * 0.98)] || 0, 1e-4);
  const out = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((levels[i] / ref) * 230)));
  return out;
}

export default {
  id: 'waveform',
  label: 'คลื่นเสียง',
  version: 2,
  needs: 'audio',
  ffmpegOutput(outPath) {
    return ['-map', '0:a:0', '-af', `aformat=sample_fmts=flt:channel_layouts=mono,aresample=8000,aeval=abs(val(0)),aresample=${RATE}`, '-f', 'f32le', outPath];
  },
  collect({ bytes }) {
    const n = Math.floor(bytes.byteLength / 4);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
  },
  /** perFile: [{data: Float32Array|null, file:{start,duration}}] → {rate, peaks: Uint8Array} over the whole timeline */
  combine(perFile, duration) {
    const all = new Float32Array(Math.ceil(duration * RATE));
    for (const { data, file } of perFile) {
      if (!data) continue;
      const at = Math.round(file.start * RATE);
      const n = Math.min(data.length, Math.round(file.duration * RATE), all.length - at);
      if (n > 0) all.set(data.subarray(0, n), at);
    }
    return { rate: RATE, peaks: toBytes(all) };
  },
};
