# เพิ่มฟีเจอร์ให้ ClipCut

แอปแบ่งเป็น **แกน** (`js/core`, ไม่ค่อยต้องแก้) กับ **ปลั๊กอิน** (`js/plugins`, ที่ที่ฟีเจอร์ใหม่ส่วนใหญ่อยู่)
ปลั๊กอินมี 6 ชนิด แต่ละชนิดเป็น object ธรรมดาหนึ่งตัว เพิ่มได้ด้วยขั้นตอนเดียวกัน:

| ชนิด | โฟลเดอร์ | ใช้ทำ | ตัวอย่างที่มีแล้ว |
|---|---|---|---|
| วิธีส่งออก | `export/` | สร้างไฟล์วิดีโอผลลัพธ์ | ไม่บีบอัด, การ์ดจอ, บีบอัด H.264, เฉพาะเสียง |
| ไฟล์ที่ได้เพิ่ม | `extras/` | ไฟล์ข้าง ๆ วิดีโอที่ส่งออก | สรุปการตัด .txt, คำบรรยาย .srt |
| ตัวหาจุดตัด | `detectors/` | เสนอช่วงที่ควรตัด | ช่องว่างใน transcript, คำบอกเบรก, เสียงเงียบ |
| ข้อมูลจากสื่อ | `layers/` | วัดค่าจากวิดีโอครั้งเดียว เก็บไว้กับงาน | คลื่นเสียง |
| แทร็กบน timeline | `tracks/` | วาดหนึ่งแถวบน timeline | ภาพย่อ, คลื่นเสียง |
| ตัวอ่าน transcript | `transcript/` | อ่านไฟล์ถอดความ | Word, .vtt/.srt, .txt |

ขั้นตอนเพิ่มปลั๊กอิน:

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
  snapToKeyframes: true,           // true เมื่อ copy ภาพ (ต้องเริ่มทุกชิ้นที่ keyframe); false = ตัดตรงจุด (ต้อง encode ใหม่)
  needsStreamInfo: false,          // true ถ้าต้องรู้ว่าไฟล์มีเสียงไหม (จะได้ hasAudio)
  media: 'video',                  // 'audio' = ใช้กับงานไฟล์เสียง (mp3/m4a/wav); ไม่ใส่ = วิดีโอ
  outputExtension: 'mp4',          // หรือ (timeline) => 'mp3' ถ้านามสกุลตามไฟล์ต้นฉบับ (timeline.ext)
  options: [ { key, label, type: 'select', default, choices: [{ value, label }] } ],
  // listPath : ffconcat ของชิ้นที่เก็บไว้ (เหมาะกับ -c copy)
  // segments : [{ fileIndex, inpoint, outpoint|null }] ใช้คู่กับ inputPaths[fileIndex] (เหมาะกับการ encode ใหม่แบบตัดเป๊ะ)
  buildArgs({ listPath, outPath, options, segments, inputPaths, hasAudio }) { return [ ...ffmpeg args... ]; },
}
```

ถ้าการตัดแต่ละช่วงต้องรัน ffmpeg แยก (เช่น เสียงแบบไม่เข้ารหัสใหม่ ที่ตัดทีละชิ้นแล้วค่อยต่อ) ใช้ `perSegment` แทน `buildArgs`:
`perSegment: { segmentArgs({ inputPath, segment, outPath, options }), joinArgs({ listPath, outPath, options }) }`
(ดู `js/plugins/export/audio-copy.js`)

แผนส่งออกมาจาก `buildPlan` (โหมดตัดช่วงทิ้ง) หรือ `buildClipPlan` (โหมดเลือกและเรียงชิ้น) ใน `js/core/plan.js`
ทั้งสองคืนรูปเดียวกัน วิธีส่งออกและไฟล์ที่ได้เพิ่มจึงใช้ได้กับทั้งสองโหมดโดยไม่ต้องรู้ว่าเป็นโหมดไหน

**สิ่งที่แต่งไว้ในขั้น “แต่ง”** บอกวิธีส่งออกด้วย 3 ฟิลด์:

```js
  handles: ['audio', 'speed', 'visual'], // ทำอะไรที่แต่งไว้ได้บ้าง: เพลง/ระดับเสียง, ความเร็ว, ข้อความ/ภาพซ้อน
                                         // ไม่ใส่ = ไม่ได้สักอย่าง → ปุ่มถูกปิดพร้อมเหตุผลเมื่องานมีสิ่งนั้น
  render: 'gpu' | 'audio',               // เมื่อมีสิ่งที่แต่ง: เรนเดอร์ด้วย js/render/export-program.js ทางไหน
                                         // ไม่ใส่ (แต่ handles มี 'audio') = copy-mix: คัดลอกภาพเดิม ผสมเสียงใหม่
  renderOnly: true,                      // ผ่าน export-program.js เสมอ แม้ไม่ได้แต่งอะไร (buildArgs จึงไม่ถูกเรียก)
```

แอปเลือกวิธีส่งออกที่ทำได้ให้เองถ้าวิธีที่ผู้ใช้เลือกไว้ทำไม่ได้ (`current()` ใน `js/ui/screen-export.js`)

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

## 1.1 ไฟล์ที่ได้เพิ่ม (export extra)

ไฟล์ข้างวิดีโอที่ส่งออก เช่น คำบรรยาย สารบัญ ไฟล์สรุป หน้าส่งออกแสดงเป็นช่องติ๊กพร้อม `options` ให้เอง

```js
{
  id, label, description,
  defaultOn: true,
  available(ctx) { return ctx.spans.length > 0; },   // ไม่บังคับ: ใช้ได้เมื่อไร (เช่น ต้องมี transcript)
  unavailableHint: 'ต้องมี transcript',
  options: [{ key: 'speakers', label: 'ใส่ชื่อผู้พูด', type: 'checkbox', default: true }],
  build(ctx) { return [{ name: 'ชื่อไฟล์.ext', data: 'ข้อความ' | Uint8Array }]; },
}
```

`ctx` มี `plan` (แผนส่งออก: `parts[].segments[]` บอกว่าแต่ละช่วงในไฟล์ผลลัพธ์มาจากเวลาไหนในต้นฉบับ),
`timeline`, `names` (ชื่อไฟล์วิดีโอแต่ละตอน), `fileBase`, `spans` (บรรทัด transcript เป็นช่วงเวลาบน timeline:
`{start, end, text, speaker}`), `transcript`, `options`

ตัวช่วยใน `js/core/captions.js`: `partCues(part, spans)` แปลง transcript เป็น cue บนเวลาของไฟล์ผลลัพธ์ (เลื่อนตามช่วงที่ตัด)
ใช้ทำคำบรรยายรูปแบบอื่นได้ เช่น .vtt หรือสารบัญสำหรับ YouTube

### ตัวอย่าง: สารบัญ (chapters) จากจุดแยกตอน

```js
// js/plugins/extras/chapters.js
import { formatTime } from '../../core/time.js';
export default {
  id: 'chapters', label: 'สารบัญ (.txt)', description: 'วางในคำอธิบาย YouTube ได้เลย', defaultOn: false,
  build({ plan, fileBase }) {
    let t = 0;
    const rows = plan.parts.map((p) => { const r = `${formatTime(t)} ${p.label || 'เริ่มต้น'}`; t += p.duration; return r; });
    return [{ name: `${fileBase}_สารบัญ.txt`, data: rows.join('\r\n') }];
  },
};
```

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

  // เฉพาะ needs 'audio'/'video': ให้ output args (แนะนำ) แอปรวมทุกตัวไว้ใน ffmpeg รอบเดียวต่อไฟล์ เสียงถูก decode ครั้งเดียว
  ffmpegOutput(params) { return ['-map', '0:a:0', '-af', '...', '-f', 'null', '-']; },
  // หรือ ffmpegArgs(inputPath, params) ถ้าต้องรันแยก (ช้ากว่า)
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

## 2.1 ข้อมูลจากสื่อ (media layer)

ค่าที่วัดจากวิดีโอครั้งเดียวแล้วเก็บไว้กับงาน (ไม่ต้องวัดใหม่ตอนเปิดงานอีกครั้ง) ใช้วาดแทร็กหรือให้ตัวหาจุดตัดใช้ต่อ
คำนวณใน ffmpeg รอบเดียวกับตัวหาจุดตัดที่ใช้เสียง

```js
{
  id: 'waveform', label: 'คลื่นเสียง', version: 1,      // เปลี่ยน version เมื่อเปลี่ยนวิธีคำนวณ งานเก่าจะคำนวณใหม่ให้
  needs: 'audio',
  ffmpegOutput(outPath) { return ['-map', '0:a:0', '-af', '...', '-f', 'f32le', outPath]; },
  collect({ bytes, file }) { return ...; },               // แปลงไฟล์ที่ ffmpeg เขียน (ต่อไฟล์วิดีโอ)
  combine(perFile, duration) { return { ... }; },         // รวมทุกไฟล์เป็นข้อมูลบน timeline เดียว
}
```

ข้อมูลอยู่ใน `store.layers[id]` (ใช้ `app.validLayers()` เพื่อเอาเฉพาะที่ตรงกับวิดีโอชุดปัจจุบัน)

## 2.2 แทร็กบน timeline (track)

หนึ่งแถวบน timeline วาดบน canvas เฉพาะช่วงที่มองเห็น จึงซูมลึกแค่ไหนก็เร็วเท่าเดิม ผู้ใช้ซ่อน/แสดงได้จากปุ่มบน timeline

```js
{
  id, label, order: 30, height: 32, enabledByDefault: true,
  needs: 'video',               // ไม่บังคับ: แสดงเฉพาะงานวิดีโอ ('audio' = เฉพาะงานเสียง)
  layer: 'waveform',            // ไม่บังคับ: ข้อมูลจาก media layer ไหน
  draw(view) { ... },
}
```

`view` มี `g` (CanvasRenderingContext2D), `width`, `height`, `t0`/`t1` (ช่วงเวลาที่มองเห็น), `pxPerSec`,
`x(t)` (เวลา → พิกเซล), `duration`, `timeline`, `layer`, `progress` (0–1 ขณะคำนวณ layer), `frames` (ภาพนิ่งจากวิดีโอ),
`analysis` (ผลของตัวหาจุดตัดที่ใช้เสียง/ภาพ), `colors` (จากตัวแปร CSS), `redraw()`

### ตัวอย่าง: แทร็กแสดงช่วงเงียบที่วัดได้

```js
// js/plugins/tracks/silence.js — ใช้ผลของตัวหาจุดตัด 'silence' ที่มีอยู่แล้ว
export default {
  id: 'silence-track', label: 'เงียบ', order: 30, height: 14, enabledByDefault: false,
  draw(view) {
    const ranges = view.analysis.silence || [];
    view.g.fillStyle = view.colors.muted;
    for (const r of ranges) if (r.end > view.t0 && r.start < view.t1) view.g.fillRect(view.x(r.start), 3, (r.end - r.start) * view.pxPerSec, 8);
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
  async parse(file) { return { lines: [{ tau, tauEnd?, speaker, text }] }; },   // tau = วินาทีตามที่เขียนในไฟล์, tauEnd ถ้าไฟล์มีเวลาจบ
}
```

แอปตัดบรรทัดซ้ำ (bot ถอดความชอบส่งประโยคเดิมซ้ำ) และเรียงเวลาให้เอง ฟังก์ชันช่วยอยู่ใน
`js/plugins/transcript/common.js` (`parseBracketLines` สำหรับรูปแบบ `[00:01:34] ชื่อ: ข้อความ`) และ `js/io/unzip.js` สำหรับไฟล์ Office

---

## 4. ขั้น “แต่ง”: program, composition และการเรนเดอร์

```
plan (core/plan.js)  →  program (core/program.js)  →  เสียง: core/audiograph.js (ffmpeg)
  ชิ้นที่เก็บ ลำดับ       + ความเร็วของแต่ละชิ้น           ภาพ: render/draw.js → render/gpu.js (WebCodecs)
                         = เวลาของผลลัพธ์
compose (core/compose.js): แทร็กและคลิปบนเวลาของผลลัพธ์ เก็บใน store.compose
```

- **program** คือแผนส่งออกบนนาฬิกาของผลลัพธ์ `buildProgram(plan, { pieces, speed })` แต่ละ segment มี `map`
  (จาก `speedMap` ใน `core/speed.js`) แปลงเวลาไป-กลับระหว่างต้นฉบับกับผลลัพธ์ `locate(program, T)` บอกว่าเวลา T
  ของผลลัพธ์มาจากไฟล์ไหน วินาทีที่เท่าไร `toProgram(program, g)` ทำกลับกัน ใช้ใน `app.program()`
- **compose** = `{ tracks, clips, speed, mainVolume }` ฟังก์ชันแก้ไขทั้งหมดเป็นฟังก์ชันล้วน (คืน object ใหม่)
  เช่น `addClip`, `moveClip`, `trimClip`, `splitClip`, `updateClip`, `setSpeed` UI เรียก `app.commitCompose(next)`
  ซึ่งทำ undo ให้ (ส่ง `{ live: true }` ระหว่างลาก แล้ว `app.endComposeDrag()` ตอนปล่อย = ย้อนกลับได้ในครั้งเดียว)
- **ภาพหนึ่งเฟรม** วาดโดย `drawFrame()` ใน `js/render/draw.js` ทั้งภาพตัวอย่าง (`js/ui/program-player.js`)
  และตอนส่งออก (`js/render/gpu.js`) สิ่งที่เห็นจึงตรงกับไฟล์ที่ได้

### ตัวอย่าง: แบบข้อความใหม่

เพิ่ม object ใน `TEXT_PRESETS` (`js/core/compose.js`) ปุ่มในเมนูและแผงขวาสร้างให้เอง

```js
{ id: 'quote', label: 'คำพูดเด่น', text: '“…”', duration: 4,
  style: { font: 'Plex Thai', weight: 700, size: 0.06, color: '#FFFFFF', bg: 'box', bgColor: 'rgba(0,0,0,0.55)', align: 'center' },
  box: { x: 0.5, y: 0.5, w: 0.8 }, anim: { in: 'fade', out: 'fade', dur: 0.4 } },
```

ขนาดและตำแหน่งเป็นสัดส่วนของภาพ (0–1) จึงออกมาเหมือนกันทุกความละเอียด
การเคลื่อนไหวแบบใหม่เพิ่มใน `ANIMS_IN` / `ANIMS_OUT` แล้ววาดใน `drawTextClip()` (`js/render/text.js`)

### ตัวอย่าง: เส้นโค้งความเร็วแบบใหม่

เพิ่มใน `CURVES` (`js/core/speed.js`): `points` คือ `[ตำแหน่งในชิ้น 0–1, ความเร็ว 0.1–10]` ต่อกันด้วยเส้นตรง

```js
{ id: 'ramp-up', label: 'เร่งขึ้น', hint: 'ช้าแล้วค่อย ๆ เร็ว', points: [[0, 0.5], [1, 3]] },
```

### คลิปชนิดใหม่ (เช่น สติกเกอร์ หรือ shape)

1. ใส่ชนิดใน `LANE` (`core/compose.js`) ว่าอยู่แทร็กภาพ (`overlay`) หรือเสียง (`audio`)
2. วาดใน `drawFrame()` (`render/draw.js`) — export ใช้ฟังก์ชันเดียวกัน จึงได้ทั้งตัวอย่างและไฟล์ผลลัพธ์
3. ถ้ามีเสียง เพิ่มใน `partAudioArgs()` (`core/audiograph.js`)
4. แผงปรับค่าใน `renderSide()` ของ `js/ui/screen-compose.js` และสีบน timeline ใน `KIND_COLOR` (`js/ui/compose-timeline.js`)

---

## จุดอื่นที่อาจอยากแก้

| อยากได้ | แก้ที่ |
|---|---|
| คำบอกเบรกเพิ่ม | ค่าเริ่มต้นใน `js/plugins/detectors/keywords.js` (ผู้ใช้ก็แก้เองได้ในหน้า “ตรวจไฟล์”) |
| ชื่อไฟล์ผลลัพธ์ | `partFileName` ใน `js/media/export.js` |
| ระยะฟังรอยต่อ / ปุ่มลัด | `js/ui/screen-review.js` (หน้าแต่ง: `js/ui/screen-compose.js`) |
| ระดับการลดเสียงเพลง | `DUCK` ใน `js/core/compose.js` (export ใช้ `ratio`, ภาพตัวอย่างใช้ `gain`) |
| ฟอนต์ของข้อความ | `FONTS` ใน `js/core/compose.js` + `@font-face` ใน `css/app.css` + ไฟล์ใน `vendor/fonts/` |
| สี/ฟอนต์ | ตัวแปรบนสุดของ `css/app.css` |
| รองรับวิดีโอนามสกุลอื่น | `VIDEO_EXT` ใน `js/io/folder.js` (keyframe อ่านได้เฉพาะ MP4/MOV; นามสกุลอื่นจะตัดตรงเวลาแต่ภาพอาจกระตุก) |

หลังแก้ไฟล์ใน `vendor/` ให้เพิ่ม `VERSION` ใน `sw.js` เพื่อให้ผู้ใช้ที่ติดตั้งแอปแล้วได้ไฟล์ใหม่
