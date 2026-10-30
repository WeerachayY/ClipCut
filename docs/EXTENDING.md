# เพิ่มฟีเจอร์ให้ ClipCut

แอปแบ่งเป็น **แกน** (`js/core`, ไม่ค่อยต้องแก้) กับ **ปลั๊กอิน** (`js/plugins`, ที่ที่ฟีเจอร์ใหม่ส่วนใหญ่อยู่)
ปลั๊กอินมี 3 ชนิด แต่ละชนิดเป็น object ธรรมดาหนึ่งตัว เพิ่มได้ด้วยขั้นตอนเดียวกัน:

1. สร้างไฟล์ในโฟลเดอร์ที่ตรงชนิด `js/plugins/<ชนิด>/<ชื่อ>.js` แล้ว `export default { ... }`
2. import และ register ใน `js/plugins/index.js`
3. รัน `node --test tests/*.test.mjs` และเพิ่ม test ถ้าเป็นตรรกะที่ซับซ้อน

หน้าจอสร้างตัวเลือกให้เองจากข้อมูลในปลั๊กอิน (`settings` ของตัวหาจุดตัด, `options` ของวิธีส่งออก) ไม่ต้องแก้ UI

---

## 1. วิธีส่งออก (export profile)

รับ “รายการไฟล์ต่อกัน” (ffconcat ที่แอปสร้างจากช่วงที่ไม่ถูกตัด) แล้วคืน argument ของ ffmpeg

```js
{
  id: 'unique-id',
  label: 'ชื่อที่ผู้ใช้เห็น',
  description: 'อธิบายสั้น ๆ ว่าได้อะไร เร็วหรือช้า',
  speed: 'fast' | 'slow',          // fast = ไม่ encode ภาพใหม่ (แอปจะเช็คเพดาน 1.9 GB ให้)
  experimental: false,
  snapToKeyframes: true,           // true เมื่อ copy ภาพ (ต้องเริ่มทุกช่วงที่ keyframe)
  outputExtension: 'mp4',
  options: [ { key, label, type: 'select', default, choices: [{ value, label }] } ],
  buildArgs({ listPath, outPath, options }) { return [ ...ffmpeg args... ]; },
}
```

### ตัวอย่าง: ปรับเสียงให้ดังเท่ากันทั้งไฟล์ (ภาพไม่ encode ใหม่ จึงยังเร็ว)

```js
// js/plugins/export/normalize-audio.js
export default {
  id: 'normalize-audio',
  label: 'ไม่บีบอัด + ปรับเสียงให้ดังเท่ากัน',
  description: 'ภาพเท่าต้นฉบับ เสียงคนพูดใกล้/ไกลไมค์ดังใกล้เคียงกัน',
  speed: 'fast',
  snapToKeyframes: true,
  outputExtension: 'mp4',
  options: [],
  buildArgs({ listPath, outPath }) {
    return ['-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v?', '-map', '0:a?', '-c:v', 'copy',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', outPath];
  },
};
```

### ตัวอย่าง: เสียงอย่างเดียว (.m4a) สำหรับฟังย้อนหลัง

```js
buildArgs({ listPath, outPath }) {
  return ['-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath, '-vn', '-c:a', 'copy', '-y', outPath];
},
outputExtension: 'm4a',
```

> ffmpeg.wasm ที่ใช้คือ build มาตรฐานของ `@ffmpeg/core` 0.12 มี libx264, libx265, libvpx, aac, mp3 (lame), opus
> filter ส่วนใหญ่ของ ffmpeg ใช้ได้ ลองคำสั่งกับ ffmpeg บนเครื่องก่อนได้ (ดู `tests/ffmpeg-native.test.mjs`)

---

## 2. ตัวหาจุดตัด (detector)

คืน “candidate” ซึ่งแกน (`core/suggest.js`) จะรวมเป็นข้อเสนอให้ผู้ใช้ตรวจ ทุกเวลาเป็นวินาทีบน timeline รวม

```js
{
  id, label, description,
  needs: 'transcript' | 'audio' | 'video',
  defaults: { ... },                         // ค่าเริ่มต้น ผู้ใช้ปรับได้
  settings: [ { key, label, type: 'number'|'text', unit, min, max, step } ],
  enabledByDefault: true,

  // เฉพาะ needs 'audio'/'video': แอปรัน ffmpeg ให้ไฟล์ละครั้ง แล้วส่ง log กลับมาให้แปลง
  ffmpegArgs(inputPath, params) { return [...]; },
  parseLog(logLines, fileDuration) { return [{ start, end }]; },   // เวลาในไฟล์นั้น
  analysisKeys: ['...'],                     // setting ที่เปลี่ยนแล้วต้องวิเคราะห์ใหม่

  detect(ctx, params) { return [ ...candidates ]; },
}
```

`ctx` มี `timeline`, `duration`, `lines` (บรรทัด transcript ที่แปลงเป็นเวลาวิดีโอแล้ว: `{tau, g, speaker, text}`)
และ `analysis[detectorId]` (ช่วงเวลาจาก `parseLog` ที่แปลงเป็นเวลารวมแล้ว)

Candidate มี 3 บทบาท

| role | ใช้เมื่อ | ฟิลด์ |
|---|---|---|
| `primary` | เสนอช่วงที่ควรตัด | `start, end, minStart?, maxEnd?, label, signal` |
| `refiner` | ช่วงที่วัดได้แม่น (เช่น เสียงเงียบ) ใช้ปรับขอบของ primary หรือเสนอเองถ้ายาวพอ | `start, end, label, signal` |
| `evidence` | จุดที่ยืนยันขอบ (เช่น คำว่า “พักเบรก”) | `at, kind: 'break-start'|'break-end', label` |

ข้อเสนอจะเป็น “แนะนำ” (มั่นใจสูง) เมื่อมีสัญญาณอย่างน้อย 2 ชนิด (`signal`) ตรงกัน เช่น transcript + เสียง

### ตัวอย่าง: จอค้างนาน (เช่น ขึ้นสไลด์ “Break 10 min”)

```js
// js/plugins/detectors/frozen-screen.js
import { formatDuration } from '../../core/time.js';
export default {
  id: 'frozen-screen',
  label: 'ภาพนิ่งนาน',
  description: 'ภาพแทบไม่เปลี่ยนเลยนานเกินกำหนด (ต้องถอดรหัสภาพ ช้ากว่าเสียงมาก)',
  needs: 'video',
  enabledByDefault: false,
  defaults: { minFrozen: 120 },
  settings: [{ key: 'minFrozen', label: 'ภาพนิ่งนานกว่า', type: 'number', unit: 'วินาที', min: 30, step: 10 }],
  analysisKeys: ['minFrozen'],
  ffmpegArgs: (input, p) => ['-hide_banner', '-skip_frame', 'nokey', '-i', input, '-an', '-vf', `freezedetect=n=0.003:d=${p.minFrozen}`, '-f', 'null', '-'],
  parseLog(lines, dur) {
    const out = []; let s = null;
    for (const l of lines) {
      const a = l.match(/freeze_start:\s*([\d.]+)/); if (a) s = Number(a[1]);
      const b = l.match(/freeze_end:\s*([\d.]+)/); if (b && s != null) { out.push({ start: s, end: Number(b[1]) }); s = null; }
    }
    if (s != null) out.push({ start: s, end: dur });
    return out;
  },
  detect(ctx) {
    return (ctx.analysis[this.id] || []).map((r) => ({ role: 'refiner', signal: 'video', source: this.id, start: r.start, end: r.end, label: `ภาพนิ่ง ${formatDuration(r.end - r.start)}` }));
  },
};
```

---

## 3. ตัวอ่าน transcript

```js
{
  id, label,
  extensions: ['.csv'],
  sniff(text) { return true/false; },     // ไม่บังคับ ใช้แยกรูปแบบที่นามสกุลซ้ำกัน (.txt)
  async parse(file) { return { lines: [{ tau, speaker, text }] }; },   // tau = วินาทีตามที่เขียนในไฟล์
}
```

แอปตัดบรรทัดซ้ำ (bot ถอดความชอบส่งประโยคเดิมซ้ำ) และเรียงเวลาให้เอง ฟังก์ชันช่วยอยู่ใน
`js/plugins/transcript/common.js` (`parseBracketLines` สำหรับรูปแบบ `[00:01:34] ชื่อ: ข้อความ`) และ `js/io/unzip.js` สำหรับไฟล์ Office

---

## จุดอื่นที่อาจอยากแก้

| อยากได้ | แก้ที่ |
|---|---|
| คำบอกเบรกเพิ่ม | ค่าเริ่มต้นใน `js/plugins/detectors/keywords.js` (ผู้ใช้ก็แก้เองได้ในหน้า “ตรวจไฟล์”) |
| ชื่อไฟล์ผลลัพธ์ | `partFileName` ใน `js/media/export.js` |
| ระยะฟังรอยต่อ / ปุ่มลัด | `js/ui/screen-review.js` |
| สี/ฟอนต์ | ตัวแปรบนสุดของ `css/app.css` |
| รองรับวิดีโอนามสกุลอื่น | `VIDEO_EXT` ใน `js/io/folder.js` (keyframe อ่านได้เฉพาะ MP4/MOV; นามสกุลอื่นจะตัดตรงเวลาแต่ภาพอาจกระตุก) |

หลังแก้ไฟล์ใน `vendor/` ให้เพิ่ม `VERSION` ใน `sw.js` เพื่อให้ผู้ใช้ที่ติดตั้งแอปแล้วได้ไฟล์ใหม่
