// Lossless: copies the original video/audio packets. Seconds per hour of video, same quality and bitrate.
export default {
  id: 'copy',
  label: 'ไม่บีบอัด (แนะนำ)',
  description: 'เร็วมาก คุณภาพและขนาดต่อนาทีเท่าต้นฉบับ จุดตัดถูกปรับให้ตรง keyframe',
  speed: 'fast',
  snapToKeyframes: true,
  outputExtension: 'mp4',
  options: [],
  buildArgs({ listPath, outPath }) {
    return [
      '-hide_banner',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v?', '-map', '0:a?',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', outPath,
    ];
  },
};
