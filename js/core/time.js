// Time helpers. All times inside the app are seconds (float).

/** "01:05:10" / "1:05:10.5" / "05:10" / "00:00:03,250" -> seconds, or NaN */
export function parseTimecode(str) {
  if (typeof str !== 'string') return NaN;
  const m = str.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return h * 3600 + min * 60 + s + frac;
}

/** seconds -> "1:05:10" (or "05:10" when short=true and < 1h). Negative values keep their sign. */
export function formatTime(sec, { decimals = 0, short = false } = {}) {
  if (!Number.isFinite(sec)) return '--:--';
  const sign = sec < 0 ? '-' : '';
  let t = Math.abs(sec);
  const factor = 10 ** decimals;
  t = Math.round(t * factor) / factor;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const ss = decimals > 0 ? s.toFixed(decimals).padStart(decimals + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (short && h === 0) return `${sign}${mm}:${ss}`;
  return `${sign}${h}:${mm}:${ss}`;
}

/**
 * Editor timecode with frames: 3910.5 s at 30 fps -> "1:05:10:15".
 * short=true drops the hour when it is 0 ("05:10:15").
 */
export function formatTimecode(sec, fps = 30, { short = false } = {}) {
  if (!Number.isFinite(sec)) return '--:--:--';
  const rate = Math.max(1, Math.round(fps || 30));
  const sign = sec < 0 ? '-' : '';
  // count whole frames so rounding never shows a frame number equal to the rate
  const total = Math.floor(Math.abs(sec) * rate + 1e-6);
  const f = total % rate;
  const s = Math.floor(total / rate);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  if (short && h === 0) return `${sign}${p2(m)}:${p2(ss)}:${p2(f)}`;
  return `${sign}${h}:${p2(m)}:${p2(ss)}:${p2(f)}`;
}

/** Snap a time to the start of the frame it falls in (plus a hair so seeking lands inside it). */
export const toFrame = (sec, fps = 30) => Math.round(sec * fps) / fps;

/** Human duration in Thai: 90 -> "1 นาที 30 วิ", 3725 -> "1 ชม. 2 นาที" */
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '-';
  const t = Math.round(Math.abs(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return m > 0 ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
  if (m > 0) return s > 0 ? `${m} นาที ${s} วิ` : `${m} นาที`;
  return `${s} วิ`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
