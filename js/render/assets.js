// Media added on top of the main track (pictures, overlay video, music, voice). The bytes are kept in this
// browser with the job (io/jobs-db.js 'assets'), so reopening needs no file picker.
import { putAsset, getAsset } from '../io/jobs-db.js';
import { newId } from '../core/id.js';

const MB_URL = new URL('../../vendor/mediabunny-1.62.1/mediabunny.min.mjs', import.meta.url).href;
let mb = null;
export const mediabunny = () => (mb ||= import(MB_URL));

export const MAX_ASSET_BYTES = 600 * 1024 * 1024;
const IMAGE = /^image\//;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

export function kindOfFile(file) {
  if (IMAGE.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) return 'image';
  if (/^audio\//.test(file.type) || AUDIO_EXT.test(file.name)) return 'audio';
  if (/^video\//.test(file.type) || VIDEO_EXT.test(file.name)) return 'video';
  return null;
}

/** Loudness envelope (100 values a second, 0–255) of a sound file, for drawing it on its clip. */
async function envelope(blob) {
  if (blob.size > 80 * 1024 * 1024 || typeof AudioContext === 'undefined') return null;
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 100;
    const step = Math.max(1, Math.round(buf.sampleRate / rate));
    const n = Math.ceil(buf.length / step);
    const ch = [...Array(buf.numberOfChannels).keys()].map((i) => buf.getChannelData(i));
    const out = new Float32Array(n);
    let max = 1e-6;
    for (let k = 0; k < n; k++) {
      let m = 0;
      for (const d of ch) for (let i = k * step, e = Math.min(d.length, i + step); i < e; i += 4) { const v = Math.abs(d[i]); if (v > m) m = v; }
      out[k] = m;
      if (m > max) max = m;
    }
    return { rate, peaks: Uint8Array.from(out, (v) => Math.round((v / max) * 255)) };
  } catch { return null; }
}

/** Facts about a media file: size of the picture, length, whether it has sound. */
async function probe(blob, kind) {
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob);
    const out = { width: bmp.width, height: bmp.height, duration: null, hasAudio: false };
    bmp.close();
    return out;
  }
  const MB = await mediabunny();
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
  const v = kind === 'video' ? await input.getPrimaryVideoTrack() : null;
  const a = await input.getPrimaryAudioTrack();
  if (kind === 'video' && !v) throw new Error('ไม่พบภาพในไฟล์นี้');
  if (kind === 'audio' && !a) throw new Error('ไม่พบเสียงในไฟล์นี้');
  return { width: v?.displayWidth || null, height: v?.displayHeight || null, duration: await input.computeDuration(), hasAudio: !!a, channels: a?.numberOfChannels || 0, envelope: kind === 'audio' ? await envelope(blob) : null };
}

export class AssetLibrary {
  constructor() { this.items = new Map(); }

  /** Store a picked file as a new asset. */
  async add(file) {
    const kind = kindOfFile(file);
    if (!kind) throw new Error(`ไม่รองรับไฟล์ ${file.name}`);
    if (file.size > MAX_ASSET_BYTES) throw new Error(`${file.name} ใหญ่เกินไป (เกิน 600 MB) ตัดให้สั้นลงก่อน`);
    const blob = new Blob([file], { type: file.type });
    const info = await probe(blob, kind);
    const rec = { id: newId('asset'), name: file.name, size: file.size, type: file.type, kind, blob, ...info };
    await putAsset(rec);
    this.#keep(rec);
    return this.items.get(rec.id);
  }

  /** Load the assets a composition uses. Missing ones are reported, not thrown. */
  async load(ids) {
    const missing = [];
    for (const id of new Set(ids)) {
      if (this.items.has(id)) continue;
      const rec = await getAsset(id).catch(() => null);
      if (rec) this.#keep(rec); else missing.push(id);
    }
    return missing;
  }

  #keep(rec) {
    this.items.set(rec.id, { ...rec, url: URL.createObjectURL(rec.blob), file: new File([rec.blob], rec.name, { type: rec.type }) });
  }

  get(id) { return this.items.get(id) || null; }

  /** Decoded picture of an image asset (cached). */
  async bitmap(id) {
    const a = this.get(id);
    if (!a || a.kind !== 'image') return null;
    a.bitmap ||= await createImageBitmap(a.blob);
    return a.bitmap;
  }

  dispose() {
    for (const a of this.items.values()) { URL.revokeObjectURL(a.url); a.bitmap?.close?.(); }
    this.items.clear();
  }
}
