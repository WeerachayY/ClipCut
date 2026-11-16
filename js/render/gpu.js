// Renders one program part to MP4 with the browser's own video encoder (WebCodecs; the graphics card when
// the computer has one). Frames are decoded from the recordings, the overlays drawn on top
// (render/draw.js, the same code as the preview), encoded, and written straight to disk when possible.
// The sound is made beforehand by ffmpeg (core/audiograph.js) and only copied in.
import { mediabunny } from './assets.js';
import { drawFrame, mediaRect } from './draw.js';
import { ensureFonts } from './text.js';
import { at } from '../core/program.js';

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

/** Whether this browser can encode H.264 (and roughly how): {ok, reason?} */
export async function gpuSupport(width = 1920, height = 1080) {
  if (typeof VideoEncoder === 'undefined') return { ok: false, reason: 'browser นี้ไม่มีตัวเข้ารหัสวิดีโอ (WebCodecs) ใช้ Edge หรือ Chrome รุ่นใหม่' };
  try {
    const MB = await mediabunny();
    if (await MB.canEncodeVideo('avc', { width: even(width), height: even(height) })) return { ok: true };
    return { ok: false, reason: 'browser นี้เข้ารหัส H.264 ที่ขนาดนี้ไม่ได้' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Output size: the recording's own, or limited to a height (keeping the shape, even numbers). */
export function outputSize(srcW, srcH, maxHeight = null) {
  const w = srcW || 1280;
  const h = srcH || 720;
  if (!maxHeight || h <= maxHeight) return { width: even(w), height: even(h) };
  return { width: even((w * maxHeight) / h), height: even(maxHeight) };
}

const BITRATE = { high: 'QUALITY_HIGH', medium: 'QUALITY_MEDIUM', low: 'QUALITY_LOW' };

/**
 * @param {object} o
 * @param {object} o.part           program part (core/program.js)
 * @param {File[]} o.mainFiles      recordings, by fileIndex
 * @param {object[]} o.clips        picture overlays on the part's clock, in drawing order
 * @param {import('./assets.js').AssetLibrary} o.assets
 * @param {{width:number,height:number}} o.size
 * @param {number} o.fps
 * @param {'high'|'medium'|'low'} [o.quality]
 * @param {Uint8Array|null} o.audio  the part's sound as AAC in .m4a (from ffmpeg), or null
 * @param {WritableStream|null} o.writable  file on disk; null = keep in memory and return the bytes
 * @param {(p:{ratio:number, fps:number})=>void} [o.onProgress]
 * @param {{aborted:boolean}} [o.signal]
 */
export async function renderPartVideo({ part, mainFiles, clips, assets, size, fps, quality = 'high', audio, writable, onProgress, signal }) {
  const MB = await mediabunny();
  const W = size.width;
  const H = size.height;
  await ensureFonts(clips);

  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d', { alpha: false });
  const target = writable ? new MB.StreamTarget(writable, { chunked: true }) : new MB.BufferTarget();
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });
  const video = new MB.CanvasSource(canvas, {
    // 'no-preference': the browser takes the graphics card when it has an H.264 encoder, software otherwise
    // ('prefer-hardware' is a requirement, and fails outright on computers without one)
    codec: 'avc', bitrate: MB[BITRATE[quality] || BITRATE.high], keyFrameInterval: 2, latencyMode: 'quality', hardwareAcceleration: 'no-preference',
  });
  output.addVideoTrack(video, { frameRate: fps });

  // sound: packets copied from ffmpeg's file, fed alongside the pictures so the file stays interleaved
  let pump = async () => {};
  if (audio) {
    const ain = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BufferSource(audio) });
    const track = await ain.getPrimaryAudioTrack();
    if (track) {
      const asrc = new MB.EncodedAudioPacketSource(track.codec);
      output.addAudioTrack(asrc);
      let meta = { decoderConfig: await track.getDecoderConfig() };
      const it = new MB.EncodedPacketSink(track).packets();
      let next = null;
      let done = false;
      pump = async (until) => {
        while (!done) {
          if (!next) { const r = await it.next(); if (r.done) { done = true; break; } next = r.value; }
          if (next.timestamp > until) break;
          await asrc.add(next, meta);
          meta = undefined;
          next = null;
        }
      };
    }
  }
  await output.start();

  // decoders for the recordings, scaled to the output on the way out
  const mains = new Map();
  const mainSink = async (i) => {
    if (!mains.has(i)) {
      const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(mainFiles[i]) });
      const track = await input.getPrimaryVideoTrack();
      mains.set(i, track ? { sink: new MB.CanvasSink(track, { width: W, height: H, fit: 'contain', poolSize: 3 }), first: Math.max(0, await track.getFirstTimestamp()) } : null);
    }
    return mains.get(i);
  };

  // overlays: pictures once, videos as their own decoders that step along with the frames
  const pics = new Map();
  const vids = new Map();
  for (const c of clips) {
    const a = assets.get(c.asset);
    if (!a) continue;
    if (c.kind === 'image') pics.set(c.id, { src: await assets.bitmap(c.asset), w: a.width, h: a.height });
    if (c.kind === 'video') {
      const r = mediaRect(c, a.width, a.height, W, H);
      const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(a.blob) });
      const track = await input.getPrimaryVideoTrack();
      if (!track) continue;
      const first = Math.max(0, await track.getFirstTimestamp());
      const times = [];
      const k0 = Math.ceil(c.start * fps - 1e-6);
      for (let k = k0; k / fps < c.start + c.duration - 1e-6; k++) times.push(first + (c.offset || 0) + (k / fps - c.start));
      const sink = new MB.CanvasSink(track, { width: even(r.w), height: even(r.h), fit: 'fill', poolSize: 2 });
      vids.set(c.id, { it: sink.canvasesAtTimestamps(times), w: a.width, h: a.height, current: null });
    }
  }
  const media = (c) => (c.kind === 'image' ? pics.get(c.id) : c.kind === 'video' ? (vids.get(c.id)?.current ? { src: vids.get(c.id).current, w: vids.get(c.id).w, h: vids.get(c.id).h } : null) : null);

  const total = Math.max(1, Math.round(part.duration * fps));
  const started = performance.now();
  let k = 0;
  const frame = async (main) => {
    if (signal?.aborted) throw Object.assign(new Error('ยกเลิกแล้ว'), { name: 'AbortError' });
    const T = k / fps; // part clock
    const active = clips.filter((c) => T >= c.start - 1e-6 && T < c.start + c.duration - 1e-6);
    for (const c of active) {
      const v = vids.get(c.id);
      if (v) { const r = await v.it.next(); if (!r.done && r.value) v.current = r.value.canvas; }
    }
    drawFrame(g, W, H, { main, mainW: W, mainH: H, clips: active, media, T });
    await pump(T + 1);
    await video.add(T, 1 / fps);
    k++;
    if (k % 15 === 0 || k === total) {
      const secs = (performance.now() - started) / 1000;
      onProgress?.({ ratio: k / total, fps: secs > 0 ? k / secs : 0 });
    }
  };

  try {
    for (const seg of part.segments) {
      if (k >= total) break;
      // frames whose time falls in this segment, and where each one comes from in its recording
      const stamps = [];
      const end = seg.partStart + seg.duration;
      for (let j = k; j < total && j / fps < end - 1e-6; j++) stamps.push(at(seg, part.start + j / fps, part).local);
      if (!stamps.length) continue;
      const m = await mainSink(seg.fileIndex);
      if (!m) { for (let j = 0; j < stamps.length; j++) await frame(null); continue; }
      let last = null;
      for await (const wc of m.sink.canvasesAtTimestamps(stamps.map((s) => s + m.first))) {
        if (wc) last = wc.canvas;
        await frame(last);
      }
    }
    while (k < total) await frame(null); // rounding: never leave the end without pictures
    await pump(Infinity);
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    for (const v of vids.values()) await v.it.return?.();
  }
  return writable ? null : new Uint8Array(target.buffer);
}
