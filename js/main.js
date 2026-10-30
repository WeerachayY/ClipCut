import './plugins/index.js';
import { createStore, newId, serializeProject, restoreProject, videosKey, PROJECT_FILE } from './core/store.js';
import { Timeline } from './core/timeline.js';
import { findTranscriptParser, detectors } from './core/registry.js';
import { suggestCuts } from './core/analysis.js';
import { mergeSuggestions } from './core/cuts.js';
import { dedupeLines } from './plugins/transcript/common.js';
import { classifyFiles, pickFolder, filesFromDrop, writeFileTo, downloadBlob, ensureWritable } from './io/folder.js';
import { probeVideo } from './media/probe.js';
import { runMediaAnalysis, readStreamInfo, compatSignature, isMediaDetector, keyframesViaFfprobe } from './media/analyze.js';
import { ffmpeg } from './media/ffmpeg.js';
import { h, clear, toast, ask, busy } from './ui/dom.js';
import { formatTime } from './core/time.js';
import * as startScreen from './ui/screen-start.js';
import * as filesScreen from './ui/screen-files.js';
import * as reviewScreen from './ui/screen-review.js';
import * as exportScreen from './ui/screen-export.js';

const store = createStore();
const SCREENS = { start: startScreen, files: filesScreen, review: reviewScreen, export: exportScreen };
const STEPS = [
  { id: 'start', label: 'เลือกไฟล์' },
  { id: 'files', label: 'ตรวจไฟล์' },
  { id: 'review', label: 'ตรวจจุดตัด' },
  { id: 'export', label: 'ส่งออก' },
];

let tlCache = { key: null, tl: null };
const app = {
  store,

  /** Timeline for the current video order (cached). */
  timeline() {
    const s = store.get();
    const key = s.videos.map((v) => `${v.id}:${v.duration}:${v.keyframes ? v.keyframes.length : 0}`).join('|');
    if (key !== tlCache.key) {
      tlCache = { key, tl: new Timeline(s.videos.map((v) => ({ id: v.id, name: v.name, size: v.size, duration: v.duration || 0, keyframes: v.keyframes }))) };
    }
    return tlCache.tl;
  },

  go(step) { store.set({ step }); window.scrollTo(0, 0); },

  async openFolder() {
    let picked;
    try { picked = await pickFolder(); } catch (e) { if (e.name !== 'AbortError') toast(`เปิดโฟลเดอร์ไม่ได้: ${e.message}`, 'error'); return; }
    await app.loadFiles(picked.files, { kind: 'folder', dir: picked.dir, name: picked.dir.name });
  },

  async openDropped(dataTransfer) {
    const { files, dir } = await filesFromDrop(dataTransfer);
    await app.loadFiles(files, dir ? { kind: 'folder', dir, name: dir.name } : { kind: 'files', name: 'ไฟล์ที่ลากมา' });
  },

  async openPicked(fileList) {
    await app.loadFiles([...fileList], { kind: 'files', name: 'ไฟล์ที่เลือก' });
  },

  async loadFiles(files, source) {
    const c = classifyFiles(files);
    if (!c.videos.length) { toast('ไม่พบไฟล์วิดีโอ (.mp4 / .mov) ในสิ่งที่เลือก', 'error'); return; }
    const b = busy('กำลังอ่านไฟล์วิดีโอ…');
    try {
      for (const v of store.get().videos) URL.revokeObjectURL(v.url);
      const videos = c.videos.map((file) => ({ id: newId('v'), name: file.name, size: file.size, lastModified: file.lastModified, file, url: URL.createObjectURL(file) }));
      await Promise.all(videos.map(async (v) => Object.assign(v, await probeVideo(v))));
      store.reset({ source, videos, transcriptCandidates: c.transcripts, otherFiles: c.ignored.map((f) => f.name) });

      for (const t of c.transcripts) {
        if (await app.setTranscript(t, { quiet: true })) break;
      }

      if (c.project) {
        let saved = null;
        try { saved = JSON.parse(await c.project.text()); } catch { /* broken file */ }
        const restored = restoreProject(saved, videos);
        if (restored) {
          b.close();
          const choice = await ask({
            title: 'พบงานที่ทำค้างไว้',
            body: `บันทึกล่าสุด ${saved.savedAt ? new Date(saved.savedAt).toLocaleString('th-TH') : ''} มีช่วงตัด ${restored.cuts.length} ช่วง`,
            buttons: [{ label: 'เริ่มใหม่', value: 'new' }, { label: 'ทำต่อจากเดิม', value: 'resume', kind: 'primary' }],
          });
          if (choice === 'resume') {
            store.set(restored);
            if (restored.cuts.length) { app.go('review'); return; }
          }
        }
      }
      // start downloading/initialising ffmpeg while the user checks the files
      ffmpeg.load().catch((e) => console.warn('ffmpeg preload', e));
      const unplayable = videos.filter((v) => !v.playable);
      if (unplayable.length) toast(`browser เล่นไฟล์นี้ไม่ได้: ${unplayable.map((v) => v.name).join(', ')}`, 'error', 9000);
      app.go('files');
    } catch (e) {
      console.error(e);
      toast(`อ่านไฟล์ไม่สำเร็จ: ${e.message}`, 'error');
    } finally {
      b.close();
    }
  },

  /** Parse a transcript file. Returns true on success. */
  async setTranscript(file, { quiet = false } = {}) {
    if (!file) { store.set({ transcript: null, transcriptFile: null }); return true; }
    try {
      const sniff = file.name.toLowerCase().endsWith('.txt') ? await file.text() : null;
      const parser = findTranscriptParser(file.name, sniff);
      if (!parser) throw new Error('ไม่รู้จักรูปแบบไฟล์นี้');
      const { lines } = await parser.parse(file);
      const d = dedupeLines(lines);
      store.set({ transcriptFile: file, transcript: { fileName: file.name, parserId: parser.id, parserLabel: parser.label, lines: d.lines, removed: d.removed } });
      return true;
    } catch (e) {
      if (!quiet) toast(`อ่าน ${file.name} ไม่ได้: ${e.message}`, 'error');
      return false;
    }
  },

  moveVideo(id, delta) {
    const videos = [...store.get().videos];
    const i = videos.findIndex((v) => v.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= videos.length) return;
    [videos[i], videos[j]] = [videos[j], videos[i]];
    store.set({ videos });
  },

  /** Media analysis (if needed) + detectors, then go to review. */
  async analyze({ force = false } = {}) {
    const s = store.get();
    const key = videosKey(s.videos);
    let analysis = s.analysisKey === key ? { ...s.analysis } : {};
    // which settings each cached media result was computed with
    const paramsOf = (d) => {
      const p = { ...(d.defaults || {}), ...(s.detectorSettings[d.id] || {}) };
      return JSON.stringify((d.analysisKeys || Object.keys(d.defaults || {})).map((k) => p[k]));
    };
    const used = analysis._params || {};
    // media detectors that are switched on but have no cached result for these videos and settings
    const missing = detectors()
      .filter((d) => isMediaDetector(d) && s.detectorSettings[d.id]?.enabled !== false && (force || !analysis[d.id] || used[d.id] !== paramsOf(d)))
      .map((d) => d.id);
    const needsMedia = missing.length > 0;
    const noKeyframes = s.videos.filter((v) => !v.keyframes && !v.kfTried);
    if (needsMedia || !s.compat || noKeyframes.length) {
      const b = busy('เตรียมวิเคราะห์เสียง…');
      try {
        if (noKeyframes.length) {
          b.update('อ่านตำแหน่ง keyframe…', null);
          const paths = await ffmpeg.mountInputs(s.videos.map((v) => v.file));
          const videos = await Promise.all(s.videos.map(async (v, i) => {
            if (v.keyframes || v.kfTried) return v;
            const kf = await keyframesViaFfprobe(paths[i]).catch(() => null);
            return { ...v, keyframes: kf, kfSource: kf ? 'ffprobe' : null, kfTried: true };
          }));
          store.set({ videos });
        }
        if (needsMedia) {
          const fresh = await runMediaAnalysis({
            videos: s.videos, timeline: app.timeline(), settings: s.detectorSettings, only: missing,
            onProgress: ({ message, ratio }) => b.update(message, ratio),
          });
          analysis = { ...analysis, ...fresh, _params: { ...used, ...Object.fromEntries(missing.map((id) => [id, paramsOf(detectors().find((d) => d.id === id))])) } };
        }
        if (s.videos.length > 1) {
          b.update('ตรวจว่าไฟล์ต่อกันได้…', null);
          const info = await readStreamInfo(s.videos.map((v) => v.file));
          const sigs = info.map(compatSignature);
          store.set({ compat: { ok: sigs.every((x) => x === sigs[0]), sigs } });
        } else {
          store.set({ compat: { ok: true, sigs: [] } });
        }
      } catch (e) {
        console.error(e);
        toast(`วิเคราะห์เสียงไม่สำเร็จ จะใช้ transcript อย่างเดียว (${e.message})`, 'error', 9000);
      } finally { b.close(); }
    }
    store.set({ analysis, analysisKey: key });
    app.resuggest();
    app.go('review');
  },

  /** Re-run detectors (instant) and merge with the user's decisions. */
  resuggest() {
    const s = store.get();
    const { suggestions } = suggestCuts({
      timeline: app.timeline(), transcript: s.transcript, anchors: s.anchors, anchorMode: s.anchorMode,
      analysis: s.analysis, settings: s.detectorSettings,
    });
    store.set({ cuts: mergeSuggestions(s.cuts, suggestions) });
  },

  updateCuts(fn) { store.set({ cuts: fn(store.get().cuts) }); },

  async saveNow({ download = false } = {}) {
    const s = store.get();
    const json = JSON.stringify(serializeProject(s), null, 1);
    if (download || s.source?.kind !== 'folder') { downloadBlob(PROJECT_FILE, json, 'application/json'); return; }
    if (!(await ensureWritable(s.source.dir))) throw new Error('ไม่ได้รับสิทธิ์เขียนโฟลเดอร์');
    await writeFileTo(s.source.dir, PROJECT_FILE, json);
    store.set({ savedAt: new Date() });
  },
};

// ---------- autosave (folder mode only) ----------
const PERSISTED = ['videos', 'anchors', 'anchorMode', 'analysis', 'cuts', 'splits', 'detectorSettings', 'exportProfile', 'exportOptions', 'outputBase'];
let lastSnapshot = null;
let saveTimer = 0;
store.subscribe((s) => {
  if (s.source?.kind !== 'folder' || s.step === 'start') return;
  const snap = PERSISTED.map((k) => s[k]);
  if (lastSnapshot && snap.every((v, i) => v === lastSnapshot[i])) return;
  const first = lastSnapshot === null;
  lastSnapshot = snap;
  if (first) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => app.saveNow().catch((e) => console.warn('autosave', e)), 1200);
});

// ---------- shell ----------
const root = document.getElementById('app');
const stepNav = h('ol.steps');
const saveState = h('span.save-state');
const header = h('header.top',
  h('div.brand', h('img.brand-mark', { src: './icons/favicon.svg', alt: '', width: 26, height: 26 }), h('span.brand-name', 'ClipCut'), h('span.brand-sub', 'ตัดช่วงพักจากวิดีโอประชุม')),
  h('nav', { 'aria-label': 'ขั้นตอน' }, stepNav),
  h('div.top-right', saveState));
const main = h('main.screen');
root.append(header, main);

let current = { step: null, unmount: null };
function renderShell(s) {
  const idx = STEPS.findIndex((x) => x.id === s.step);
  const reachable = (id) => id === 'start' || (s.videos.length > 0 && (id !== 'review' && id !== 'export' ? true : s.cuts.length > 0 || s.analysisKey));
  clear(stepNav, STEPS.map((st, i) => h(`li${i === idx ? '.current' : i < idx ? '.done' : ''}`,
    h('button', { type: 'button', disabled: !reachable(st.id) || i === idx, onclick: () => app.go(st.id), 'aria-current': i === idx ? 'step' : null },
      h('span.step-n', String(i + 1)), h('span.step-label', st.label)))));
  if (s.source?.kind === 'folder') {
    saveState.textContent = s.savedAt ? `บันทึกงานลงโฟลเดอร์แล้ว ${s.savedAt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : `โฟลเดอร์: ${s.source.name}`;
  } else if (s.videos.length) {
    clear(saveState, h('button.ghost.small', { type: 'button', onclick: () => app.saveNow({ download: true }) }, 'ดาวน์โหลดไฟล์งาน'));
  } else saveState.textContent = '';

  if (s.step !== current.step) {
    current.unmount?.();
    clear(main);
    const screen = SCREENS[s.step];
    current = { step: s.step, unmount: screen.mount(main, app) };
  }
}
store.subscribe(renderShell);
renderShell(store.get());

// dropping files anywhere on the start screen
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (store.get().step === 'start' && e.dataTransfer) app.openDropped(e.dataTransfer);
});

window.addEventListener('beforeunload', (e) => {
  const s = store.get();
  if (s.cuts.some((c) => c.status !== 'suggested') && s.source?.kind !== 'folder') { e.preventDefault(); e.returnValue = ''; }
});

// service worker for offline use
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
}

// for debugging in the console
window.clipcut = { app, store, formatTime };
