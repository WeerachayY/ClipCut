// Quick facts about a local video without ffmpeg: duration from the browser's own decoder,
// keyframes from the MP4 index. Both take milliseconds.
import { readMp4Keyframes } from './mp4-keyframes.js';

export function videoDuration(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = (fn, arg) => { v.removeAttribute('src'); v.load(); fn(arg); };
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) done(resolve, v.duration);
      else done(reject, new Error('อ่านความยาววิดีโอไม่ได้'));
    };
    v.onerror = () => done(reject, new Error('browser เปิดไฟล์วิดีโอนี้ไม่ได้'));
    v.src = url;
  });
}

/** @param {{file:File,url:string}} video */
export async function probeVideo(video) {
  const out = { duration: null, keyframes: null, kfSource: null, error: null, playable: true };
  try { out.duration = await videoDuration(video.url); } catch (e) { out.error = e.message; out.playable = false; }
  const k = await readMp4Keyframes(video.file);
  if (k) {
    out.keyframes = k.keyframes;
    out.kfSource = 'mp4';
    if (!out.duration) out.duration = k.duration;
  }
  return out;
}
