// Composition: what is layered over the main track, on the program clock (core/program.js).
// Tracks above the main track hold text, pictures and video; tracks below hold music and voice.
// Speeds of main-track pieces live here too (keyed by piece), so all "making it nicer" sits in one place.
//
// compose = {
//   tracks: [{id, lane:'overlay'|'audio'}]    overlay tracks listed top → bottom, audio tracks top → bottom
//   clips:  [clip]
//   speed:  {pieceKey: speed setting (core/speed.js)}
//   mainVolume: 0..2
// }
// clip (all):   {id, track, kind:'text'|'image'|'video'|'audio', start, duration}   start/duration on the program clock
// text:         text, style:{font, weight, size, color, stroke, strokeWidth, bg:'none'|'box'|'bar', bgColor, align, shadow}, box:{x,y,w}, anim:{in, out, dur}, preset
// image/video:  asset, offset (seconds into the media), box:{x,y,w}, opacity, volume (video)
// audio:        asset, offset, volume, fadeIn, fadeOut, duck:'off'|'light'|'medium'|'strong'
import { newId } from './id.js';
import { isNormal } from './speed.js';

export const emptyCompose = () => ({ tracks: [], clips: [], speed: {}, mainVolume: 1 });

export const LANE = { text: 'overlay', image: 'overlay', video: 'overlay', audio: 'audio' };
const MIN = 0.1;

export const FONTS = [
  { id: 'Kanit', label: 'Kanit (หัวข้อ)', weights: [600, 800] },
  { id: 'Plex Thai', label: 'IBM Plex Sans Thai', weights: [400, 600, 700] },
];

/** Text looks, including CapCut-style hooks for the first seconds. */
export const TEXT_PRESETS = [
  { id: 'hook-big', label: 'Hook ตัวใหญ่', hook: true, text: 'ดูให้จบ แล้วจะรู้ว่า…', duration: 3,
    style: { font: 'Kanit', weight: 800, size: 0.09, color: '#FFFFFF', stroke: '#000000', strokeWidth: 0.16, bg: 'none', align: 'center', shadow: true },
    box: { x: 0.5, y: 0.2, w: 0.88 }, anim: { in: 'pop', out: 'fade', dur: 0.35 } },
  { id: 'hook-yellow', label: 'ป้ายเหลือง', hook: true, text: '3 เรื่องที่ต้องรู้ก่อนเริ่ม', duration: 3,
    style: { font: 'Kanit', weight: 800, size: 0.072, color: '#111111', bg: 'box', bgColor: '#FFD60A', align: 'center' },
    box: { x: 0.5, y: 0.2, w: 0.82 }, anim: { in: 'pop', out: 'fade', dur: 0.35 } },
  { id: 'hook-red', label: 'แถบแดง', hook: true, text: 'ห้ามพลาด!', duration: 3,
    style: { font: 'Kanit', weight: 800, size: 0.07, color: '#FFFFFF', bg: 'box', bgColor: '#E5262A', align: 'center' },
    box: { x: 0.5, y: 0.78, w: 0.8 }, anim: { in: 'slide', out: 'fade', dur: 0.35 } },
  { id: 'typewriter', label: 'พิมพ์ทีละตัว', hook: true, text: 'คุณเคยเจอปัญหานี้ไหม?', duration: 4,
    style: { font: 'Plex Thai', weight: 700, size: 0.06, color: '#FFFFFF', bg: 'box', bgColor: 'rgba(0,0,0,0.62)', align: 'center' },
    box: { x: 0.5, y: 0.5, w: 0.8 }, anim: { in: 'type', out: 'fade', dur: 1.2 } },
  { id: 'lower-third', label: 'ชื่อผู้พูด', text: 'ชื่อ นามสกุล\nตำแหน่ง', duration: 5,
    style: { font: 'Plex Thai', weight: 700, size: 0.045, color: '#FFFFFF', bg: 'bar', bgColor: 'rgba(18,24,69,0.88)', align: 'left' },
    box: { x: 0.3, y: 0.85, w: 0.52 }, anim: { in: 'slide', out: 'fade', dur: 0.4 } },
  { id: 'plain', label: 'ข้อความธรรมดา', text: 'พิมพ์ข้อความ', duration: 4,
    style: { font: 'Plex Thai', weight: 600, size: 0.05, color: '#FFFFFF', stroke: '#000000', strokeWidth: 0.1, bg: 'none', align: 'center', shadow: true },
    box: { x: 0.5, y: 0.88, w: 0.9 }, anim: { in: 'fade', out: 'fade', dur: 0.3 } },
];

export const ANIMS_IN = [['none', 'ไม่มี'], ['fade', 'ค่อย ๆ ปรากฏ'], ['pop', 'เด้งขึ้น'], ['slide', 'เลื่อนขึ้น'], ['type', 'พิมพ์ทีละตัว']];
export const ANIMS_OUT = [['none', 'ไม่มี'], ['fade', 'ค่อย ๆ หาย'], ['pop', 'หดหาย']];
export const DUCK = { off: null, light: { ratio: 3, gain: 0.55 }, medium: { ratio: 8, gain: 0.3 }, strong: { ratio: 20, gain: 0.15 } };

const clone = (x) => JSON.parse(JSON.stringify(x));
const end = (c) => c.start + c.duration;

export function textClipFromPreset(presetId, start = 0) {
  const p = TEXT_PRESETS.find((x) => x.id === presetId) || TEXT_PRESETS[0];
  return { kind: 'text', preset: p.id, start, duration: p.duration, text: p.text, style: clone(p.style), box: clone(p.box), anim: clone(p.anim) };
}

const fits = (c, trackId, a, b, ignore) => c.clips.every((k) => k.track !== trackId || k.id === ignore || end(k) <= a + 1e-6 || k.start >= b - 1e-6);

/** Tracks of a lane, in the order they are drawn on screen (overlays: top first; audio: top first). */
export const tracksOf = (c, lane) => c.tracks.filter((t) => t.lane === lane);

/**
 * Add a clip (without id/track) on the first track of its lane that is free at that time, nearest the
 * main track first; a new track is made when none is free (like CapCut).
 * @returns {{compose, id}}
 */
export function addClip(c, clip) {
  const lane = LANE[clip.kind];
  const id = newId('c');
  const start = Math.max(0, clip.start || 0);
  const duration = Math.max(MIN, clip.duration || 3);
  const lanes = tracksOf(c, lane);
  const nearFirst = lane === 'overlay' ? [...lanes].reverse() : lanes;
  let track = nearFirst.find((t) => fits(c, t.id, start, start + duration))?.id;
  let tracks = c.tracks;
  if (!track) {
    track = newId('t');
    const t = { id: track, lane };
    // overlays: a new track goes on top; audio: at the bottom
    tracks = lane === 'overlay' ? [t, ...c.tracks] : [...c.tracks, t];
  }
  return { compose: { ...c, tracks, clips: [...c.clips, { ...clip, id, track, start, duration }] }, id };
}

const clipById = (c, id) => c.clips.find((k) => k.id === id);
const replace = (c, id, fn) => ({ ...c, clips: c.clips.map((k) => (k.id === id ? fn(k) : k)) });

/** Free stretch of a track around time t (for keeping a dragged clip between its neighbours). */
function gapAround(c, trackId, ignore, t) {
  let lo = 0;
  let hi = Infinity;
  for (const k of c.clips) {
    if (k.track !== trackId || k.id === ignore) continue;
    if (end(k) <= t + 1e-6) lo = Math.max(lo, end(k));
    else if (k.start >= t - 1e-6) hi = Math.min(hi, k.start);
    else return null; // t is inside another clip
  }
  return { lo, hi };
}

/**
 * Move a clip to `start` (and optionally to another track of the same lane). Stays between its neighbours:
 * a move that would overlap is pushed to the edge of the gap; a track change into an occupied spot is refused.
 */
export function moveClip(c, id, start, trackId = null) {
  const k = clipById(c, id);
  if (!k) return c;
  const target = trackId && c.tracks.find((t) => t.id === trackId && t.lane === LANE[k.kind]) ? trackId : k.track;
  let s = Math.max(0, start);
  if (target !== k.track) {
    if (!fits(c, target, s, s + k.duration, id)) return c;
    return pruneTracks(replace(c, id, (x) => ({ ...x, start: s, track: target })));
  }
  const g = gapAround(c, target, id, k.start + k.duration / 2);
  if (g) s = Math.max(g.lo, Math.min(s, g.hi - k.duration));
  return replace(c, id, (x) => ({ ...x, start: Math.max(0, s) }));
}

/** Move one edge of a clip to time t. `mediaLength` limits video/audio clips to their media. */
export function trimClip(c, id, side, t, mediaLength = Infinity) {
  const k = clipById(c, id);
  if (!k) return c;
  const g = gapAround(c, k.track, id, k.start + k.duration / 2) || { lo: 0, hi: Infinity };
  const media = k.kind === 'video' || k.kind === 'audio';
  if (side === 'start') {
    const minStart = Math.max(g.lo, media ? k.start - (k.offset || 0) : 0);
    const s = Math.min(end(k) - MIN, Math.max(minStart, t));
    return replace(c, id, (x) => ({ ...x, start: s, duration: end(k) - s, offset: media ? (k.offset || 0) + (s - k.start) : x.offset }));
  }
  const maxEnd = Math.min(g.hi, media ? k.start + (mediaLength - (k.offset || 0)) : Infinity);
  const e = Math.max(k.start + MIN, Math.min(maxEnd, t));
  return replace(c, id, (x) => ({ ...x, duration: e - k.start }));
}

/** Cut a clip in two at time T. */
export function splitClip(c, id, T) {
  const k = clipById(c, id);
  if (!k || T <= k.start + MIN || T >= end(k) - MIN) return { compose: c, id: null };
  const nid = newId('c');
  const left = { ...k, duration: T - k.start };
  const right = { ...clone(k), id: nid, start: T, duration: end(k) - T, offset: (k.offset || 0) + (T - k.start) };
  if (k.kind === 'audio') { left.fadeOut = 0; right.fadeIn = 0; }
  return { compose: { ...c, clips: c.clips.flatMap((x) => (x.id === id ? [left, right] : [x])) }, id: nid };
}

/** Give a text clip another preset's look; its text, timing and place stay. */
export function applyPreset(c, id, presetId) {
  const p = TEXT_PRESETS.find((x) => x.id === presetId);
  if (!p) return c;
  return replace(c, id, (k) => ({ ...k, preset: p.id, style: clone(p.style), anim: clone(p.anim) }));
}

export const removeClip = (c, id) => pruneTracks({ ...c, clips: c.clips.filter((k) => k.id !== id) });

/** Change fields of a clip; nested style/box/anim are merged. */
export function updateClip(c, id, patch) {
  return replace(c, id, (k) => {
    const out = { ...k, ...patch };
    for (const f of ['style', 'box', 'anim']) if (patch[f]) out[f] = { ...(k[f] || {}), ...patch[f] };
    return out;
  });
}

/** Empty tracks go away. */
export function pruneTracks(c) {
  const used = new Set(c.clips.map((k) => k.track));
  return { ...c, tracks: c.tracks.filter((t) => used.has(t.id)) };
}

export function setSpeed(c, pieceKey, sp) {
  const speed = { ...c.speed };
  if (!sp || isNormal(sp)) delete speed[pieceKey]; else speed[pieceKey] = sp;
  return { ...c, speed };
}

/** Drop settings of pieces that no longer exist (after the cut points changed). */
export function prunePieces(c, keys) {
  const keep = new Set(keys);
  const speed = Object.fromEntries(Object.entries(c.speed || {}).filter(([k]) => keep.has(k)));
  return Object.keys(speed).length === Object.keys(c.speed || {}).length ? c : { ...c, speed };
}

export const hasVisual = (c) => !!c?.clips?.some((k) => k.kind !== 'audio');
export const hasSpeed = (c) => Object.values(c?.speed || {}).some((s) => !isNormal(s));
/** Anything that changes the sound: extra audio, video overlays with sound, main volume. */
export const hasAudioMix = (c) => !!c && (c.clips.some((k) => k.kind === 'audio' || (k.kind === 'video' && (k.volume ?? 1) > 0)) || Math.abs((c.mainVolume ?? 1) - 1) > 1e-6);
export const isEmpty = (c) => !c || (!c.clips.length && !hasSpeed(c) && Math.abs((c.mainVolume ?? 1) - 1) < 1e-6);

export function summary(c) {
  const n = (kind) => (c?.clips || []).filter((k) => k.kind === kind).length;
  return { text: n('text'), image: n('image'), video: n('video'), audio: n('audio'), speed: Object.values(c?.speed || {}).filter((s) => !isNormal(s)).length };
}

/** Clips visible or audible at time T. */
export const activeAt = (c, T) => c.clips.filter((k) => T >= k.start - 1e-6 && T < end(k) - 1e-6);

/** Picture clips in drawing order: the bottom overlay track first, so higher tracks end up on top. */
export function drawOrder(c, clips = c.clips) {
  const rank = new Map(tracksOf(c, 'overlay').map((t, i, all) => [t.id, all.length - i]));
  return clips.filter((k) => k.kind !== 'audio').sort((a, b) => (rank.get(a.track) || 0) - (rank.get(b.track) || 0));
}
