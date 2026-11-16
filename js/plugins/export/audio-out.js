// Only the sound of a video job: for podcasts, transcription, or sending a small file.
// Cuts, arrangement, speed changes, music and ducking from the composition are all in it.
export default {
  id: 'audio-out',
  media: 'video',
  render: 'audio',
  renderOnly: true,
  handles: ['audio', 'speed', 'visual'],
  label: 'ส่งออกเฉพาะเสียง',
  description: 'ได้ไฟล์เสียงอย่างเดียว ตัดตรงจุดเป๊ะ รวมเพลงและความเร็วที่แต่งไว้ เหมาะทำ podcast หรือส่งให้คนฟัง',
  speed: 'fast',
  snapToKeyframes: false,
  outputExtension: (timeline, options = {}) => options.format || 'm4a',
  options: [
    { key: 'format', label: 'ชนิดไฟล์', type: 'select', default: 'm4a', choices: [{ value: 'm4a', label: 'M4A (AAC) เล็กและเปิดได้ทั่วไป' }, { value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV (ไม่บีบอัด ไฟล์ใหญ่)' }] },
    { key: 'bitrate', label: 'คุณภาพเสียง (M4A / MP3)', type: 'select', default: '160k', choices: [{ value: '256k', label: '256 kbps' }, { value: '192k', label: '192 kbps' }, { value: '160k', label: '160 kbps' }, { value: '128k', label: '128 kbps' }, { value: '96k', label: '96 kbps (เสียงพูด)' }] },
  ],
  buildArgs() { throw new Error('rendered by render/export-program.js'); },
};
