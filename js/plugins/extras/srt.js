// Captions (.srt) next to each exported video, from the transcript, timed to the cut video.
// Same base name as the video, so most players load them automatically.
import { partCues, toSrt } from '../../core/captions.js';

export default {
  id: 'srt',
  label: 'คำบรรยาย (.srt)',
  description: 'จาก transcript เวลาตรงกับไฟล์ที่ตัดแล้ว ชื่อเดียวกับวิดีโอ เปิดคู่กันใน player หรืออัปโหลดขึ้น Stream / YouTube ได้',
  defaultOn: true,
  available: ({ spans }) => spans.length > 0,
  unavailableHint: 'ต้องมี transcript',
  options: [{ key: 'speakers', label: 'ใส่ชื่อผู้พูด', type: 'checkbox', default: true }],
  build({ plan, spans, names, options }) {
    return plan.parts.map((part, i) => ({
      name: names[i].replace(/\.[^.]+$/, '.srt'),
      // BOM: some Windows players read UTF-8 captions as gibberish without it
      data: `﻿${toSrt(partCues(part, spans, { speakers: options.speakers !== false }))}`,
    }));
  },
};
