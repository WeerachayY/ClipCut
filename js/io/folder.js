// Local files: open a project folder (File System Access API, Edge/Chrome) or take dropped files.
// Nothing here talks to the network.
import { isProjectFileName } from '../core/jobs.js';

export const VIDEO_EXT = ['.mp4', '.m4v', '.mov'];
export const TRANSCRIPT_EXT = ['.docx', '.vtt', '.srt', '.txt'];

export const canOpenFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
/** Edge/Chrome can hand out file handles, so a job made from picked files can be reopened later. */
export const canPickFiles = () => typeof window !== 'undefined' && 'showOpenFilePicker' in window;

const ext = (name) => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; };
const collator = new Intl.Collator('th', { numeric: true, sensitivity: 'base' });

/** Sort, then split a flat list of files into videos / transcript candidates / project / ignored. */
export function classifyFiles(files) {
  const out = { videos: [], transcripts: [], project: null, ignored: [] };
  for (const f of files) {
    const e = ext(f.name);
    if (isProjectFileName(f.name)) { if (!out.project || f.name === 'clipcut.project.json') out.project = f; }
    else if (VIDEO_EXT.includes(e)) out.videos.push(f);
    else if (TRANSCRIPT_EXT.includes(e) && !f.name.startsWith('~$')) out.transcripts.push(f);
    else out.ignored.push(f);
  }
  out.videos.sort((a, b) => collator.compare(a.name, b.name));
  // Prefer a file that says "transcript", then Word files, then newest.
  const score = (f) => (/transcript|ถอดความ|บันทึก/i.test(f.name) ? 4 : 0) + (ext(f.name) === '.docx' ? 2 : ext(f.name) === '.vtt' ? 1 : 0);
  out.transcripts.sort((a, b) => score(b) - score(a) || b.lastModified - a.lastModified);
  return out;
}

export async function pickFolder() {
  const dir = await window.showDirectoryPicker({ id: 'clipcut', mode: 'readwrite' });
  return { dir, files: await listDirFiles(dir) };
}

/** Files directly inside a folder (not in subfolders such as output/). */
export async function listDirFiles(dir) {
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') files.push(await entry.getFile());
  }
  return files;
}

/** Edge/Chrome file picker: returns the files and their handles (kept with the job). */
export async function pickFiles() {
  const handles = await window.showOpenFilePicker({
    id: 'clipcut-files',
    multiple: true,
    types: [{
      description: 'วิดีโอ, transcript และไฟล์งาน',
      accept: {
        'video/mp4': ['.mp4', '.m4v'],
        'video/quicktime': ['.mov'],
        'text/plain': ['.txt', '.vtt', '.srt'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
        'application/json': ['.json'],
      },
    }],
  });
  return { handles, files: await Promise.all(handles.map((h) => h.getFile())) };
}

/** Other browsers: a plain file input. Resolves [] when the user cancels. */
export function pickFilesWithInput() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: [...VIDEO_EXT, ...TRANSCRIPT_EXT, '.json'].join(',') });
    input.addEventListener('change', () => resolve([...input.files]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/**
 * Files from a drop event, including files inside a dropped folder (one level deep).
 * Edge/Chrome also give handles: `dir` when one folder was dropped, `handles` when only files were.
 */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])].filter((it) => it.kind === 'file');
  const pending = items.map((it) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle() : null));
  if (pending.length && pending.every(Boolean)) {
    const handles = (await Promise.all(pending)).filter(Boolean);
    const out = [];
    let dir = null;
    const fileHandles = [];
    for (const h of handles) {
      if (h.kind === 'file') { fileHandles.push(h); out.push(await h.getFile()); }
      else if (h.kind === 'directory') { dir = dir || h; out.push(...await listDirFiles(h)); }
    }
    if (handles.length === 1 && dir) return { files: out, dir, handles: null };
    return { files: out, dir: null, handles: dir ? null : fileHandles };
  }
  return { files: [...dataTransfer.files], dir: null, handles: null };
}

/** Make sure we may read (or write) through a saved handle. Asking needs a click, so call it from one. */
export async function ensurePermission(handle, mode = 'read') {
  if (!handle) return false;
  if (!handle.queryPermission) return true;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** True only when write access is already granted; never shows a prompt (for autosave). */
export async function canWriteNow(dir) {
  try { return (await dir?.queryPermission?.({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}

export const ensureWritable = (dir) => ensurePermission(dir, 'readwrite');

export async function writeFileTo(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function outputDir(dir, name = 'output') {
  return dir.getDirectoryHandle(name, { create: true });
}

/** Browser download for when no folder is open. */
export function downloadBlob(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
