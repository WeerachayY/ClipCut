// Speed of a main-track clip, like CapCut: normal, one constant speed, or a curve.
// A curve is points {x, y}: x = position in the clip's source (0..1), y = speed (0.1×–10×), straight lines between.
// speedMap() turns a setting into the clip's length on the program clock and the two-way time mapping.

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10;

/** Ready-made curves (names follow CapCut's, in Thai). */
export const CURVES = [
  { id: 'montage', label: 'มอนทาจ', hint: 'เร็ว-ช้าสลับกัน', points: [[0, 1], [0.15, 1], [0.3, 3], [0.45, 0.6], [0.6, 3], [0.8, 1], [1, 1]] },
  { id: 'hero', label: 'ฮีโร่', hint: 'ช้าลงตรงกลาง', points: [[0, 2], [0.35, 2], [0.5, 0.4], [0.65, 2], [1, 2]] },
  { id: 'bullet', label: 'กระสุน', hint: 'ช้ามากชั่วขณะ', points: [[0, 3], [0.42, 3], [0.5, 0.2], [0.58, 3], [1, 3]] },
  { id: 'jump', label: 'กระโดด', hint: 'พุ่งเร็วตรงกลาง', points: [[0, 1], [0.42, 1], [0.5, 6], [0.58, 1], [1, 1]] },
  { id: 'flash-in', label: 'แฟลชเข้า', hint: 'เร็วตอนต้นแล้วปกติ', points: [[0, 6], [0.35, 1], [1, 1]] },
  { id: 'flash-out', label: 'แฟลชออก', hint: 'ปกติแล้วเร็วตอนท้าย', points: [[0, 1], [0.65, 1], [1, 6]] },
  { id: 'custom', label: 'กำหนดเอง', hint: 'ลากจุดบนกราฟ', points: [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]] },
];

const clampSpeed = (v) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(v) || 1));

/** Settings as stored: {mode:'normal'|'constant'|'curve', rate, curve, points:[{x,y}], pitch} */
export function normalizeSpeed(sp) {
  if (!sp || !sp.mode || sp.mode === 'normal') return { mode: 'normal', rate: 1, pitch: false };
  if (sp.mode === 'constant') {
    const rate = clampSpeed(sp.rate);
    return Math.abs(rate - 1) < 1e-6 ? { mode: 'normal', rate: 1, pitch: false } : { mode: 'constant', rate, pitch: !!sp.pitch };
  }
  let pts = (sp.points?.length >= 2 ? sp.points : (CURVES.find((c) => c.id === sp.curve) || CURVES[0]).points.map(([x, y]) => ({ x, y })))
    .map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p))
    .map((p) => ({ x: Math.min(1, Math.max(0, Number(p.x) || 0)), y: clampSpeed(p.y) }))
    .sort((a, b) => a.x - b.x);
  pts[0] = { ...pts[0], x: 0 };
  pts[pts.length - 1] = { ...pts[pts.length - 1], x: 1 };
  if (pts.every((p) => Math.abs(p.y - 1) < 1e-6)) return { mode: 'normal', rate: 1, pitch: false };
  return { mode: 'curve', curve: sp.curve || 'custom', points: pts, pitch: !!sp.pitch };
}

export const isNormal = (sp) => normalizeSpeed(sp).mode === 'normal';

export function curvePoints(id) {
  const c = CURVES.find((x) => x.id === id) || CURVES[0];
  return c.points.map(([x, y]) => ({ x, y }));
}

/** Speed at position u (0..1) of the clip. */
export function speedAt(sp, u) {
  const s = normalizeSpeed(sp);
  if (s.mode === 'normal') return 1;
  if (s.mode === 'constant') return s.rate;
  const p = s.points;
  if (u <= 0) return p[0].y;
  for (let i = 1; i < p.length; i++) {
    if (u <= p[i].x) {
      const a = p[i - 1];
      const b = p[i];
      const f = b.x > a.x ? (u - a.x) / (b.x - a.x) : 1;
      return a.y + (b.y - a.y) * f;
    }
  }
  return p[p.length - 1].y;
}

const STEPS = 1024;

/**
 * Time mapping of one clip whose source lasts `srcDur` seconds.
 * @returns {{outDur:number, toOut:(srcSec)=>number, toSrc:(outSec)=>number, speed:(srcSec)=>number, mode:string, pitch:boolean}}
 */
export function speedMap(sp, srcDur) {
  const s = normalizeSpeed(sp);
  const L = Math.max(0, srcDur);
  if (s.mode !== 'curve') {
    const r = s.mode === 'constant' ? s.rate : 1;
    return { mode: s.mode, pitch: s.pitch, outDur: L / r, toOut: (x) => x / r, toSrc: (t) => t * r, speed: () => r };
  }
  // output time after each source step; integrating 1/speed with the trapezoid rule
  const cum = new Float64Array(STEPS + 1);
  const du = 1 / STEPS;
  let prev = 1 / speedAt(s, 0);
  for (let i = 1; i <= STEPS; i++) {
    const inv = 1 / speedAt(s, i * du);
    cum[i] = cum[i - 1] + ((prev + inv) / 2) * du * L;
    prev = inv;
  }
  const outDur = cum[STEPS];
  const toOut = (x) => {
    if (L <= 0) return 0;
    const u = Math.min(1, Math.max(0, x / L)) * STEPS;
    const i = Math.min(STEPS - 1, Math.floor(u));
    return cum[i] + (cum[i + 1] - cum[i]) * (u - i);
  };
  const toSrc = (t) => {
    if (t <= 0 || L <= 0) return 0;
    if (t >= outDur) return L;
    let lo = 0;
    let hi = STEPS;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
    const f = (t - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return ((lo + f) / STEPS) * L;
  };
  return { mode: 'curve', pitch: s.pitch, outDur, toOut, toSrc, speed: (x) => speedAt(s, L > 0 ? x / L : 0) };
}

/**
 * Split a stretch of source [a, b] (seconds into the clip) into pieces of constant speed for audio
 * (ffmpeg's atempo has no curves): each piece plays at its own average speed, so lengths add up exactly.
 * @returns {{from:number, to:number, rate:number}[]}
 */
export function speedChunks(map, a, b, maxChunk = 0.4) {
  if (map.mode !== 'curve') return [{ from: a, to: b, rate: map.mode === 'constant' ? map.speed(0) : 1 }];
  const n = Math.max(1, Math.min(200, Math.ceil((b - a) / maxChunk)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = a + ((b - a) * i) / n;
    const to = a + ((b - a) * (i + 1)) / n;
    const outLen = map.toOut(to) - map.toOut(from);
    out.push({ from, to, rate: outLen > 0 ? (to - from) / outLen : 1 });
  }
  return out;
}

/** Short label for a clip's speed: "1.5×", "เส้นโค้ง: ฮีโร่" */
export function speedLabel(sp) {
  const s = normalizeSpeed(sp);
  if (s.mode === 'normal') return '';
  if (s.mode === 'constant') return `${+s.rate.toFixed(2)}×`;
  return `โค้ง: ${(CURVES.find((c) => c.id === s.curve) || CURVES[CURVES.length - 1]).label}`;
}
