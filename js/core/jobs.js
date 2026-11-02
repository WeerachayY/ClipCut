// Jobs: one piece of work (a set of videos plus every decision about them), listed on the home screen.
// Pure helpers only; storage lives in io/jobs-db.js, the lifecycle in main.js.
import { piecesOf, toPlanInput } from './cuts.js';

const stripExt = (name) => name.replace(/\.[^.]+$/, '');

/** Default name: the folder's name, or the first video's name. */
export function autoJobName(source, videoNames = []) {
  if (source?.kind === 'folder' && source.name) return source.name;
  if (!videoNames.length) return 'งานใหม่';
  const base = stripExt(videoNames[0]);
  return videoNames.length > 1 ? `${base} และอีก ${videoNames.length - 1} ไฟล์` : base;
}

export const duplicateName = (name) => `${name} (สำเนา)`;

/** Clean up a name typed by the user; falls back to the previous one when left empty. */
export function cleanJobName(typed, previous) {
  const t = String(typed ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return t || previous;
}

/** Numbers shown on a job card. `videos` need {duration}; `edit` is the cut-point model from cuts.js. */
export function jobSummary({ videos = [], edit }) {
  const duration = videos.reduce((a, v) => a + (v.duration || 0), 0);
  if (!duration || !edit) return { files: videos.length, duration, cut: 0, kept: duration, marks: 0, parts: 1 };
  const cut = piecesOf(edit, duration).filter((p) => p.status === 'delete').reduce((a, p) => a + (p.end - p.start), 0);
  const parts = toPlanInput(edit, duration).splits.length + 1;
  return { files: videos.length, duration, cut, kept: Math.max(0, duration - cut), marks: edit.marks.length, parts };
}

/** Badge on a job card. */
export function jobStatus(job) {
  if (job.missing) return { id: 'missing', label: 'หาไฟล์ไม่เจอ' };
  if (job.exportedAt && job.exportedAt >= (job.editedAt || 0)) return { id: 'exported', label: 'ส่งออกแล้ว' };
  if (job.exportedAt) return { id: 'changed', label: 'แก้หลังส่งออก' };
  if (job.summary?.marks) return { id: 'editing', label: 'กำลังตรวจ' };
  return { id: 'new', label: 'ยังไม่ได้ตัด' };
}

/** Last time the job was touched (for sorting). */
export const lastActive = (job) => Math.max(job.openedAt || 0, job.editedAt || 0, job.createdAt || 0);

export const sortJobs = (jobs) => [...jobs].sort((a, b) => lastActive(b) - lastActive(a));

export function searchJobs(jobs, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return jobs;
  return jobs.filter((j) => [j.name, j.source?.name, ...(j.videos || []).map((v) => v.name)]
    .some((s) => s && String(s).toLowerCase().includes(q)));
}

/**
 * Find a job's videos among picked files, by name + size (the same rule as project restore).
 * Returns the matching files in the job's order and the names that were not found.
 */
export function matchFiles(saved = [], files = []) {
  const pool = new Map();
  for (const f of files) {
    const k = `${f.name}|${f.size}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(f);
  }
  const matched = [];
  const missing = [];
  for (const sv of saved) {
    const f = pool.get(`${sv.name}|${sv.size}`)?.shift();
    if (f) matched.push(f); else missing.push(sv.name);
  }
  return { matched, missing };
}

/** "เมื่อสักครู่", "5 นาทีที่แล้ว", "วันนี้ 09:12", "เมื่อวาน 16:20", "25 ต.ค." */
export function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = now - ms;
  if (diff < 60_000) return 'เมื่อสักครู่';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} นาทีที่แล้ว`;
  const d = new Date(ms);
  const n = new Date(now);
  const hm = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  if (ms >= today) return `วันนี้ ${hm}`;
  if (ms >= yesterday) return `เมื่อวาน ${hm}`;
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }) });
}

/** A project file saved by ClipCut: clipcut.project.json, or one downloaded from a job card (name.clipcut.json). */
export const isProjectFileName = (name) => /^clipcut\.project.*\.json$/i.test(name) || /\.clipcut(\s*\(\d+\))?\.json$/i.test(name);
