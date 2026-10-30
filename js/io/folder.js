// Local files: open a meeting folder (File System Access API, Edge/Chrome) or take dropped files.
// Nothing here talks to the network.
import { PROJECT_FILE } from '../core/store.js';

export const VIDEO_EXT = ['.mp4', '.m4v', '.mov'];
export const TRANSCRIPT_EXT = ['.docx', '.vtt', '.srt', '.txt'];

export const canOpenFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const ext = (name) => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; };
const collator = new Intl.Collator('th', { numeric: true, sensitivity: 'base' });

/** Sort, then split a flat list of files into videos / transcript candidates / project / ignored. */
export function classifyFiles(files) {
  const out = { videos: [], transcripts: [], project: null, ignored: [] };
  for (const f of files) {
    const e = ext(f.name);
    if (f.name === PROJECT_FILE) out.project = f;
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
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') files.push(await entry.getFile());
  }
  return { dir, files };
}

/** Files from a drop event, including files inside dropped folders (one level deep). */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const handles = items.map((it) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle() : null));
  const out = [];
  let dir = null;
  if (handles.every(Boolean)) {
    for (const h of await Promise.all(handles)) {
      if (!h) continue;
      if (h.kind === 'file') out.push(await h.getFile());
      else if (h.kind === 'directory') {
        dir = dir || h;
        for await (const entry of h.values()) if (entry.kind === 'file') out.push(await entry.getFile());
      }
    }
    return { files: out, dir: handles.length === 1 ? dir : null };
  }
  return { files: [...dataTransfer.files], dir: null };
}

export async function ensureWritable(dir) {
  if (!dir) return false;
  const opts = { mode: 'readwrite' };
  if ((await dir.queryPermission(opts)) === 'granted') return true;
  return (await dir.requestPermission(opts)) === 'granted';
}

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
