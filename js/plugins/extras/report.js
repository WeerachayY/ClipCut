// A plain-text record of what was cut and where each output came from.
import { formatTime, formatDuration } from '../../core/time.js';

export default {
  id: 'report',
  label: 'สรุปการตัด (.txt)',
  description: 'ช่วงที่ตัดออกและที่มาของแต่ละไฟล์ เก็บไว้อ้างอิงหรือใช้ทำสารบัญ',
  defaultOn: true,
  build({ plan, program, timeline, names, fileBase }) {
    const L = [];
    L.push(`ClipCut — สรุปการตัด (${new Date().toLocaleString('th-TH')})`);
    L.push(`ต้นฉบับ: ${timeline.files.map((f) => f.name).join(' + ')} (${formatTime(timeline.duration)})`);
    L.push(`ตัดออก: ${formatTime(plan.removedDuration)} · เหลือ: ${formatTime(plan.keptDuration)}`);
    L.push('');
    L.push('ช่วงที่ตัดออก (เวลาในต้นฉบับ):');
    plan.removed.forEach((r, i) => L.push(`  ${i + 1}. ${formatTime(r.start)} – ${formatTime(r.end)} (${formatDuration(r.end - r.start)})`));
    L.push('');
    L.push('ไฟล์ผลลัพธ์:');
    // with speed changes (step "แต่ง") the files are as long as the program, not the plain plan
    plan.parts.forEach((p, i) => L.push(`  ${names[i]}  ความยาว ${formatTime((program || plan).parts[i]?.duration ?? p.duration)}  มาจาก ${formatTime(p.from)} – ${formatTime(p.to)}`));
    if (program) L.push('', `ปรับความเร็วบางช่วงไว้ ความยาวรวม ${formatTime(program.duration)} (ก่อนปรับ ${formatTime(plan.keptDuration)})`);
    return [{ name: `${fileBase}_สรุปการตัด.txt`, data: L.join('\r\n') }];
  },
};
