// Re-encode to H.264 + AAC with HandBrake-like quality presets (CRF).
// Runs on the CPU inside the browser, so it is much slower than "copy": plan for roughly
// real time or slower. Lower resolution and frame rate make it a lot faster.
export default {
  id: 'compress-h264',
  label: 'บีบอัดไฟล์ให้เล็กลง (H.264)',
  description: 'คล้าย HandBrake ไฟล์เล็กลงมาก แต่ใช้เวลานานพอ ๆ กับความยาววิดีโอหรือมากกว่า',
  speed: 'slow',
  experimental: true,
  snapToKeyframes: true,
  outputExtension: 'mp4',
  options: [
    {
      key: 'height', label: 'ความละเอียด', type: 'select', default: '720',
      choices: [{ value: 'keep', label: 'เท่าต้นฉบับ' }, { value: '1080', label: '1080p' }, { value: '720', label: '720p (แนะนำสำหรับสไลด์)' }, { value: '540', label: '540p' }],
    },
    {
      key: 'fps', label: 'เฟรมต่อวินาที', type: 'select', default: '15',
      choices: [{ value: 'keep', label: 'เท่าต้นฉบับ' }, { value: '30', label: '30' }, { value: '15', label: '15 (พอสำหรับสไลด์และคนพูด เร็วขึ้นเกือบเท่าตัว)' }],
    },
    {
      key: 'crf', label: 'คุณภาพ', type: 'select', default: '26',
      choices: [{ value: '22', label: 'สูง (ไฟล์ใหญ่)' }, { value: '26', label: 'สมดุล' }, { value: '30', label: 'ประหยัดพื้นที่' }],
    },
    {
      key: 'preset', label: 'ความเร็วในการบีบอัด', type: 'select', default: 'veryfast',
      choices: [{ value: 'ultrafast', label: 'เร็วที่สุด (ไฟล์ใหญ่กว่า)' }, { value: 'veryfast', label: 'เร็ว' }, { value: 'medium', label: 'ช้า (ไฟล์เล็กกว่า)' }],
    },
    {
      key: 'audio', label: 'เสียง', type: 'select', default: '96k',
      choices: [{ value: '128k', label: '128 kbps' }, { value: '96k', label: '96 kbps' }, { value: '64k', label: '64 kbps' }],
    },
  ],
  buildArgs({ listPath, outPath, options }) {
    const o = { height: '720', fps: '15', crf: '26', preset: 'veryfast', audio: '96k', ...options };
    const vf = [];
    if (o.height !== 'keep') vf.push(`scale=-2:'min(${o.height},ih)'`);
    if (o.fps !== 'keep') vf.push(`fps=${o.fps}`);
    vf.push('format=yuv420p');
    return [
      '-hide_banner',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-vf', vf.join(','),
      '-c:v', 'libx264', '-preset', o.preset, '-crf', o.crf,
      '-c:a', 'aac', '-b:a', o.audio,
      '-movflags', '+faststart',
      '-y', outPath,
    ];
  },
};
