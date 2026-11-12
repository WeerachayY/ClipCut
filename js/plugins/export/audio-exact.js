// Audio files re-encoded so every cut is sample-exact. Audio encodes fast, even in the browser.
const ENCODERS = { mp3: ['-c:a', 'libmp3lame'], m4a: ['-c:a', 'aac'], wav: ['-c:a', 'pcm_s16le'] };
export default {
  id: 'audio-exact',
  media: 'audio',
  label: 'ตัดตรงจุดเป๊ะ (เข้ารหัสใหม่)',
  description: 'จุดตัดตรงระดับ sample ใช้เวลามากกว่าเล็กน้อย mp3 และ m4a ถูกเข้ารหัสอีกรอบ คุณภาพลดลงเล็กน้อยตาม bitrate ที่เลือก',
  speed: 'slow',
  snapToKeyframes: false,
  outputExtension: (timeline) => (ENCODERS[timeline.ext] ? timeline.ext : 'mp3'),
  options: [{
    key: 'bitrate', label: 'คุณภาพเสียง (mp3 / m4a)', type: 'select', default: '192k',
    choices: [{ value: '320k', label: '320 kbps (สูงสุด)' }, { value: '256k', label: '256 kbps' }, { value: '192k', label: '192 kbps' }, { value: '128k', label: '128 kbps' }, { value: '96k', label: '96 kbps (เสียงพูด)' }],
  }],
  buildArgs({ outPath, options, segments, inputPaths }) {
    const ext = outPath.split('.').pop();
    const used = [...new Set(segments.map((s) => s.fileIndex))];
    const args = ['-hide_banner'];
    used.forEach((i) => args.push('-i', inputPaths[i]));
    let fc = '';
    segments.forEach((s, k) => {
      const end = s.outpoint != null ? `:end=${s.outpoint.toFixed(6)}` : '';
      fc += `[${used.indexOf(s.fileIndex)}:a:0]atrim=start=${s.inpoint.toFixed(6)}${end},asetpts=PTS-STARTPTS[a${k}];`;
    });
    fc += `${segments.map((_, k) => `[a${k}]`).join('')}concat=n=${segments.length}:v=0:a=1[a]`;
    args.push('-filter_complex', fc, '-map', '[a]', ...(ENCODERS[ext] || ENCODERS.mp3));
    if (ext !== 'wav') args.push('-b:a', options.bitrate || '192k');
    return [...args, '-y', outPath];
  },
};
