# Vendored files

เก็บไว้ใน repo เพื่อให้แอปทำงาน offline และไม่ต้องพึ่ง CDN (บาง firewall องค์กรบล็อก CDN)

| โฟลเดอร์ | ที่มา | เวอร์ชัน | License |
|---|---|---|---|
| `ffmpeg/` | npm `@ffmpeg/ffmpeg` (dist/esm) — https://github.com/ffmpegwasm/ffmpeg.wasm | 0.12.15 | MIT |
| `core/` | npm `@ffmpeg/core` (dist/esm, single-thread) | 0.12.10 | GPL-2.0-or-later (รวม FFmpeg, x264 ฯลฯ) |
| `fonts/` | npm `@fontsource/ibm-plex-sans-thai`, `@fontsource/ibm-plex-mono` | 5.3.0 | SIL OFL 1.1 (`LICENSE-OFL.txt`) |

`core/ffmpeg-core.wasm` เป็นงาน GPL ซอร์สโค้ดอยู่ที่ https://github.com/ffmpegwasm/ffmpeg.wasm (tag `v0.12.10`) และ https://ffmpeg.org
ถ้าเผยแพร่ repo นี้ต่อสาธารณะ ให้คงลิงก์ซอร์สไว้ตามเงื่อนไข GPL

อัปเดตเวอร์ชันด้วย `scripts/update-vendor.sh` แล้วเปลี่ยน `VERSION` ใน `sw.js` เพื่อให้เครื่องผู้ใช้โหลดไฟล์ใหม่
