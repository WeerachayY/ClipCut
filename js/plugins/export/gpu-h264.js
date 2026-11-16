// Re-encode with the browser's video encoder (WebCodecs, the graphics card when there is one). This is
// the profile that renders compositions: text, pictures, overlay video, music, speed changes.
// The work itself is in render/export-program.js; this file only describes the choice.
export default {
  id: 'gpu-h264',
  media: 'video',
  render: 'gpu',
  renderOnly: true, // always through render/export-program.js, even with nothing composed
  handles: ['audio', 'speed', 'visual'],
  label: 'เรนเดอร์ด้วยการ์ดจอ (H.264)',
  description: 'ใส่ข้อความ ภาพซ้อน เพลง และความเร็วที่แต่งไว้ เร็วกว่าการบีบอัดใน browser หลายเท่าเมื่อเครื่องมีการ์ดจอ ตัดตรงจุดเป๊ะ',
  speed: 'slow',
  snapToKeyframes: false,
  outputExtension: 'mp4',
  buildArgs() { throw new Error('rendered by render/export-program.js'); },
  options: [
    { key: 'quality', label: 'คุณภาพ', type: 'select', default: 'high', choices: [{ value: 'high', label: 'สูง' }, { value: 'medium', label: 'กลาง (ไฟล์เล็กลง)' }, { value: 'low', label: 'ต่ำ (ไฟล์เล็กมาก)' }] },
    { key: 'height', label: 'ขนาดภาพ', type: 'select', default: '', choices: [{ value: '', label: 'เท่าต้นฉบับ' }, { value: '1080', label: 'ไม่เกิน 1080p' }, { value: '720', label: 'ไม่เกิน 720p' }, { value: '480', label: 'ไม่เกิน 480p' }] },
  ],
};
