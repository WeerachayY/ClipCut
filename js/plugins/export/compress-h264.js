// Re-encode to H.264 + AAC with HandBrake-like quality presets (CRF).
// Runs on the CPU inside the browser, so it is much slower than "copy": plan for roughly
// real time or slower. Lower resolution and frame rate make it a lot faster.
// Because every frame is re-encoded, cuts land exactly where they were marked (no keyframe snapping):
// each kept segment is opened with an accurate input seek and the pieces are joined with the concat filter.
export default {
  id: 'compress-h264',
  label: 'บีบอัดไฟล์ให้เล็กลง (H.264)',
  description: 'คล้าย HandBrake ไฟล์เล็กลงมากและตัดตรงจุดเป๊ะ แต่ใช้เวลานานพอ ๆ กับความยาววิดีโอหรือมากกว่า',
  speed: 'slow',
  experimental: true,
  snapToKeyframes: false,
  needsStreamInfo: true,
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
  /**
   * @param {{outPath:string, options:object, segments:{fileIndex,inpoint,outpoint}[], inputPaths:string[], hasAudio:boolean}} a
   */
  buildArgs({ outPath, options, segments, inputPaths, hasAudio = true }) {
    const o = { height: '720', fps: '15', crf: '26', preset: 'veryfast', audio: '96k', ...options };
    const v = [];
    if (o.height !== 'keep') v.push(`scale=-2:'min(${o.height},ih)'`);
    if (o.fps !== 'keep') v.push(`fps=${o.fps}`);
    v.push('format=yuv420p', 'setsar=1');
    const args = ['-hide_banner'];
    segments.forEach((s) => {
      args.push('-ss', s.inpoint.toFixed(3));
      if (s.outpoint != null) args.push('-t', (s.outpoint - s.inpoint).toFixed(3));
      args.push('-i', inputPaths[s.fileIndex]);
    });
    let fc = '';
    let pads = '';
    segments.forEach((_, i) => {
      fc += `[${i}:v:0]${v.join(',')}[v${i}];`;
      if (hasAudio) fc += `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
      pads += `[v${i}]${hasAudio ? `[a${i}]` : ''}`;
    });
    fc += `${pads}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`;
    args.push('-filter_complex', fc, '-map', '[v]');
    if (hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', o.audio);
    args.push('-c:v', 'libx264', '-preset', o.preset, '-crf', o.crf, '-movflags', '+faststart', '-y', outPath);
    return args;
  },
};
