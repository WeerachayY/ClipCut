// Audio files (mp3, m4a, wav) without re-encoding: the original audio packets are copied.
// Audio is stored in small frames (mp3 about 26 ms, AAC about 21 ms), so a cut lands on a frame edge:
// at most one frame away from the mark. wav has no frames and is cut exactly.
// Each piece is cut with an output-side seek (the file is read from its start, no index needed, so it is
// right even for VBR mp3 without a seek table), then the pieces are joined.
const t = (x) => x.toFixed(3);
export default {
  id: 'audio-copy',
  media: 'audio',
  label: 'ไม่เข้ารหัสใหม่ (แนะนำ)',
  description: 'เร็วมาก เสียงเหมือนต้นฉบับทุกประการ จุดตัดลงที่ขอบเฟรมเสียง คลาดได้ไม่เกิน 0.026 วินาที (wav ตรงเป๊ะ)',
  speed: 'fast',
  snapToKeyframes: false,
  outputExtension: (timeline) => timeline.ext || 'mp3',
  options: [],
  perSegment: {
    segmentArgs({ inputPath, segment, outPath }) {
      const a = ['-hide_banner', '-i', inputPath];
      if (segment.inpoint > 0.0005) a.push('-ss', t(segment.inpoint));
      if (segment.outpoint != null) a.push('-to', t(segment.outpoint));
      // wav is uncompressed: writing the samples again loses nothing and cuts on the exact sample
      // (copying would cut on 4096-sample packets); written as 16-bit PCM
      if (outPath.endsWith('.wav')) return [...a, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-y', outPath];
      return [...a, '-map', '0:a:0', '-c', 'copy', '-y', outPath];
    },
    joinArgs({ listPath, outPath }) {
      return ['-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outPath];
    },
  },
};
