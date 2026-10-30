import { h, icon } from './dom.js';
import { canOpenFolder, VIDEO_EXT, TRANSCRIPT_EXT } from '../io/folder.js';

export function mount(root, app) {
  const input = h('input', { type: 'file', multiple: true, accept: [...VIDEO_EXT, ...TRANSCRIPT_EXT, '.json'].join(','), hidden: true, onchange: (e) => e.target.files.length && app.openPicked(e.target.files) });
  const drop = h('div.drop', { tabindex: '0', role: 'button', 'aria-label': 'ลากไฟล์หรือโฟลเดอร์มาวาง หรือกดเพื่อเลือกไฟล์', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
    icon('download', 22),
    h('p', h('strong', 'ลากโฟลเดอร์หรือไฟล์มาวางตรงนี้'), h('br'), 'หรือกดเพื่อเลือกไฟล์'));
  drop.addEventListener('dragenter', () => drop.classList.add('over'));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', () => drop.classList.remove('over'));

  const strip = h('div.hero-strip', { 'aria-hidden': 'true' },
    h('div.hs-track',
      h('span.hs-talk', { style: { left: '0%', width: '6%' } }),
      h('span.hs-cut', { style: { left: '0%', width: '4%' } }),
      h('span.hs-talk', { style: { left: '4%', width: '38%' } }),
      h('span.hs-cut.accepted', { style: { left: '42%', width: '9%' } }),
      h('span.hs-seam', { style: { left: '58%' } }),
      h('span.hs-cut.check', { style: { left: '79%', width: '1.6%' } }),
      h('span.hs-cut.accepted', { style: { left: '95%', width: '5%' } })),
    h('div.hs-labels', h('span', { style: { left: '0%' } }, 'ช่วงรอ'), h('span', { style: { left: '42%' } }, 'ช่วงพัก'), h('span', { style: { left: '58%' } }, 'ไฟล์ที่ 2'), h('span', { style: { left: '95%', transform: 'translateX(-100%)' } }, 'ท้ายคลิปที่ไม่ใช้')));

  root.append(h('section.start',
    h('div.start-head',
      h('h1', 'ตัดช่วงที่ไม่ต้องการออกจากวิดีโอ'),
      h('p.lede', 'แอปหาช่วงเงียบ ช่วงพัก และช่วงที่ไม่มีใครพูดให้อัตโนมัติ คุณฟังรอยต่อก่อนตัดจริง ต่อหลายไฟล์เป็นไฟล์เดียว หรือแบ่งเป็นหลายตอนก็ได้')),
    strip,
    h('div.start-actions',
      canOpenFolder()
        ? h('button.primary.big', { type: 'button', onclick: () => app.openFolder() }, icon('folder', 20), 'เปิดโฟลเดอร์')
        : h('p.note', 'browser นี้เปิดทั้งโฟลเดอร์ไม่ได้ ใช้ Edge หรือ Chrome บนคอมพิวเตอร์จะบันทึกผลลงโฟลเดอร์ให้อัตโนมัติ'),
      drop, input),
    h('div.start-info',
      h('div',
        h('h2', 'ในโฟลเดอร์ควรมี'),
        h('ul',
          h('li', h('strong', 'วิดีโอ .mp4 หรือ .mov'), ' ไฟล์เดียว หรือหลายไฟล์ที่บันทึกต่อกัน'),
          h('li', h('strong', 'transcript ที่มีเวลากำกับ'), ' (.docx, .vtt, .srt หรือ .txt) ไม่มีก็ได้ แอปจะใช้เสียงเงียบอย่างเดียว'))),
      h('div',
        h('h2', 'ไฟล์ไม่ออกจากเครื่อง'),
        h('p', 'ทุกอย่างประมวลผลใน browser บนคอมพิวเตอร์นี้ ไม่มีการอัปโหลดและไม่ใช้ AI ผลลัพธ์จะถูกบันทึกในโฟลเดอร์ output ข้างไฟล์ต้นฉบับ')))));
  return () => {};
}
