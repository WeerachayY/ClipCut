import './plugins/index.js';
import { APP_VERSION } from './version.js';
import { createStore, newId, serializeProject, restoreProject, videosKey, PROJECT_FILE } from './core/store.js';
import { Timeline } from './core/timeline.js';
import { findTranscriptParser, detectors, mediaLayers } from './core/registry.js';
import { suggestCuts } from './core/analysis.js';
import { applySuggestions, toPlanInput } from './core/cuts.js';
import { dedupeLines } from './plugins/transcript/common.js';
import { classifyFiles, pickFolder, pickFiles, pickFilesWithInput, listDirFiles, filesFromDrop, writeFileTo, downloadBlob, ensurePermission, canWriteNow, canOpenFolder, canPickFiles } from './io/folder.js';
import * as jobsDb from './io/jobs-db.js';
import { autoJobName, cleanJobName, duplicateName, jobSummary, matchFiles, relativeTime, lastActive, sortJobs } from './core/jobs.js';
import { captureThumbnail } from './media/thumbnail.js';
import { safeName } from './media/export.js';
import { probeVideo } from './media/probe.js';
import { runMediaAnalysis, readStreamInfo, compatSignature, isMediaDetector, keyframesViaFfprobe } from './media/analyze.js';
import { ffmpeg } from './media/ffmpeg.js';
import { h, clear, toast, ask, busy, icon } from './ui/dom.js';
import { formatTime } from './core/time.js';
import * as homeScreen from './ui/screen-home.js';
import * as filesScreen from './ui/screen-files.js';
import * as reviewScreen from './ui/screen-review.js';
import * as exportScreen from './ui/screen-export.js';

const store = createStore();
const SCREENS = { home: homeScreen, files: filesScreen, review: reviewScreen, export: exportScreen };
const STEPS = [
  { id: 'files', label: 'ไฟล์' },
  { id: 'review', label: 'ตรวจจุดตัด' },
  { id: 'export', label: 'ส่งออก' },
];

let tlCache = { key: null, tl: null };
// undo/redo history of the edit (cut points + piece states)
const history = { past: [], future: [] };
const HISTORY_MAX = 200;
const app = {
  store,

  /** Timeline for the current video order (cached). */
  timeline() {
    const s = store.get();
    const key = s.videos.map((v) => `${v.id}:${v.duration}:${v.keyframes ? v.keyframes.length : 0}:${v.fps || 0}`).join('|');
    if (key !== tlCache.key) {
      tlCache = { key, tl: new Timeline(s.videos.map((v) => ({ id: v.id, name: v.name, size: v.size, duration: v.duration || 0, keyframes: v.keyframes, fps: v.fps }))) };
    }
    return tlCache.tl;
  },

  go(step) { store.set({ step }); window.scrollTo(0, 0); },

  // ---------- jobs ----------

  /** Job list for the home screen, most recently used first. */
  async listJobs() {
    try { return sortJobs(await jobsDb.listJobs()); } catch (e) {
      console.warn('jobs', e);
      if (!warnedStorage) { warnedStorage = true; toast('browser นี้เก็บรายการงานไม่ได้ (อาจเป็นหน้าต่างส่วนตัว) งานจะหายเมื่อปิดหน้า', 'error', 9000); }
      return [];
    }
  },

  async newFromFolder() {
    let picked;
    try { picked = await pickFolder(); } catch (e) { if (e.name !== 'AbortError') toast(`เปิดโฟลเดอร์ไม่ได้: ${e.message}`, 'error'); return; }
    await app.startJob(picked.files, { kind: 'folder', dir: picked.dir, name: picked.dir.name });
  },

  /** `fileList` comes from a plain file input (browsers without file handles). */
  async newFromFiles(fileList = null) {
    if (fileList) { await app.startJob([...fileList], { kind: 'files', name: '' }); return; }
    let picked;
    try { picked = await pickFiles(); } catch (e) { if (e.name !== 'AbortError') toast(`เปิดไฟล์ไม่ได้: ${e.message}`, 'error'); return; }
    await app.startJob(picked.files, { kind: 'files', name: '', handles: picked.handles });
  },

  async newFromDrop(dataTransfer) {
    const { files, dir, handles } = await filesFromDrop(dataTransfer);
    await app.startJob(files, dir ? { kind: 'folder', dir, name: dir.name } : { kind: 'files', name: '', handles });
  },

  /** New job from picked files, or the existing job when these are the same folder / files. */
  async startJob(files, src) {
    const c = classifyFiles(files);
    if (!c.videos.length) { toast('ไม่พบไฟล์วิดีโอ (.mp4 / .mov) ในสิ่งที่เลือก', 'error'); return; }
    let saved = null;
    if (c.project) { try { saved = JSON.parse(await c.project.text()); } catch { /* broken file */ } }
    if (saved?.app !== 'clipcut') saved = null;
    const jobs = await app.listJobs();

    let existing = null;
    if (src.kind === 'folder') {
      existing = (saved?.jobId && jobs.find((j) => j.id === saved.jobId && !j.missing)) || null;
      for (const j of jobs) {
        if (existing) break;
        if (j.dir && await j.dir.isSameEntry(src.dir).catch(() => false)) existing = j;
      }
    } else {
      const key = videosKey(c.videos);
      const twin = jobs.find((j) => !j.dir && videosKey(j.videos || []) === key);
      if (twin) {
        const choice = await ask({
          title: 'มีงานจากไฟล์ชุดนี้อยู่แล้ว',
          body: `“${twin.name}” ใช้ไฟล์ชุดเดียวกัน แก้ล่าสุด${relativeTime(lastActive(twin))}`,
          buttons: [{ label: 'ยกเลิก', value: null }, { label: 'สร้างงานใหม่', value: 'new' }, { label: 'เปิดงานเดิม', value: 'open', kind: 'primary' }],
        });
        if (choice === null) return;
        if (choice === 'open') existing = twin;
      }
    }
    if (existing) {
      // the user just picked these files, so remember where they are now
      const where = src.kind === 'folder' ? { dir: src.dir, handles: null, source: { kind: 'folder', name: src.name } } : { dir: null, handles: src.handles || existing.handles || null };
      toast(`เปิดงานเดิม “${existing.name}”`);
      await app.loadJob({ ...existing, ...where, missing: false }, files);
      return;
    }

    const now = Date.now();
    const job = {
      id: newId('j'), name: autoJobName(src, c.videos.map((f) => f.name)),
      createdAt: now, editedAt: now, openedAt: now, exportedAt: null,
      source: { kind: src.kind, name: src.name || '' }, dir: src.dir || null, handles: src.handles || null,
      videos: c.videos.map((f) => ({ name: f.name, size: f.size })), project: null, transcript: null, step: 'files',
      thumb: null, summary: null, missing: false,
    };
    // a project file left in the folder by earlier work (another computer, or a cleared browser)
    if (saved && !matchFiles(saved.videos || [], c.videos).missing.length) {
      const choice = await ask({
        title: 'พบงานที่ทำค้างไว้ในโฟลเดอร์นี้',
        body: `${saved.jobName ? `“${saved.jobName}” ` : ''}บันทึกล่าสุด ${saved.savedAt ? new Date(saved.savedAt).toLocaleString('th-TH') : ''}`,
        buttons: [{ label: 'เริ่มใหม่', value: 'new' }, { label: 'ทำต่อจากเดิม', value: 'resume', kind: 'primary' }],
      });
      if (choice === 'resume') {
        job.project = saved;
        if (saved.jobName) job.name = saved.jobName;
        if (saved.jobId && !jobs.some((j) => j.id === saved.jobId)) job.id = saved.jobId;
      }
    }
    jobsDb.keepStorage();
    await app.loadJob(job, files);
  },

  /** Open a job from the home screen. Call straight from the click: the browser may ask for access. */
  async openJob(rec) {
    let files = null;
    let lost = false;
    try {
      if (rec.dir) {
        if (!(await ensurePermission(rec.dir, 'readwrite'))) { toast('ต้องอนุญาตให้เข้าถึงโฟลเดอร์ก่อน จึงจะเปิดงานนี้ได้', 'error', 7000); return; }
        files = await listDirFiles(rec.dir);
      } else if (rec.handles?.length) {
        files = [];
        for (const fh of rec.handles) {
          if (!(await ensurePermission(fh, 'read'))) { toast('ต้องอนุญาตให้อ่านไฟล์ก่อน จึงจะเปิดงานนี้ได้', 'error', 7000); return; }
          try { files.push(await fh.getFile()); } catch { /* this one was moved; the check below decides */ }
        }
      }
    } catch (e) {
      console.warn('open job', e);
      files = null;
      lost = true;
    }
    const missing = files ? matchFiles(rec.videos, classifyFiles(files).videos).missing : rec.videos.map((v) => v.name);
    if (files && !missing.length) { await app.loadJob({ ...rec, missing: false }, files); return; }
    if (files || lost) await jobsDb.putJob({ ...rec, missing: true }).catch(() => {});
    await app.relink({ ...rec, missing: !!(files || lost) }, missing);
  },

  /** The job's videos were moved, or this browser cannot remember files: let the user point to them. */
  async relink(rec, missing) {
    const found = rec.missing;
    const choice = await ask({
      title: found ? 'หาไฟล์ของงานนี้ไม่เจอ' : 'เลือกไฟล์ของงานนี้อีกครั้ง',
      body: h('div.relink',
        h('p', found ? 'ไฟล์อาจถูกย้ายหรือเปลี่ยนชื่อ เลือกไฟล์เดิมอีกครั้ง แอปจะจับคู่จากชื่อและขนาดไฟล์ จุดตัดที่ทำไว้ยังอยู่ครบ'
          : 'browser นี้จำตำแหน่งไฟล์ไว้ไม่ได้ เลือกไฟล์เดิมอีกครั้ง แอปจะจับคู่จากชื่อและขนาดไฟล์ จุดตัดที่ทำไว้ยังอยู่ครบ'),
        h('ul', missing.map((n) => h('li', n)))),
      buttons: [{ label: 'ยกเลิก', value: null }, canOpenFolder() ? { label: 'เลือกโฟลเดอร์', value: 'folder' } : null, { label: 'เลือกไฟล์', value: 'files', kind: 'primary' }].filter(Boolean),
    });
    if (!choice) return false;
    let files = [];
    let where;
    try {
      if (choice === 'folder') {
        const p = await pickFolder();
        files = p.files;
        where = { dir: p.dir, handles: null, source: { kind: 'folder', name: p.dir.name } };
      } else if (canPickFiles()) {
        const p = await pickFiles();
        files = p.files;
        where = { dir: null, handles: p.handles, source: { kind: 'files', name: rec.source?.kind === 'files' ? rec.source.name : '' } };
      } else {
        files = await pickFilesWithInput();
        where = { dir: null, handles: null, source: { kind: 'files', name: '' } };
      }
    } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'error'); return false; }
    if (!files.length) return false;
    const still = matchFiles(rec.videos, classifyFiles(files).videos).missing;
    if (still.length) { toast(`ยังไม่พบ: ${still.join(', ')}`, 'error', 9000); return false; }
    await app.loadJob({ ...rec, ...where, missing: false }, files);
    return true;
  },

  /** Load a job's files and its saved work, then open it at the step the user left. */
  async loadJob(rec, files) {
    const c = classifyFiles(files);
    const b = busy('กำลังอ่านไฟล์วิดีโอ…');
    loading = true;
    try {
      for (const v of store.get().videos) URL.revokeObjectURL(v.url);
      const videos = c.videos.map((file) => ({ id: newId('v'), name: file.name, size: file.size, lastModified: file.lastModified, file, url: URL.createObjectURL(file) }));
      await Promise.all(videos.map(async (v) => Object.assign(v, await probeVideo(v))));
      const source = rec.dir ? { kind: 'folder', dir: rec.dir, name: rec.source?.name || rec.dir.name } : { kind: 'files', name: rec.source?.name || '' };
      store.reset({ step: 'files', source, videos, transcriptCandidates: c.transcripts, otherFiles: c.ignored.map((f) => f.name), jobId: rec.id, jobName: rec.name });
      history.past = [];
      history.future = [];

      // the transcript saved with the job first, otherwise the best candidate among the files
      if (rec.transcript) store.set({ transcript: rec.transcript });
      if (rec.layers) store.set({ layers: rec.layers });
      else for (const t of c.transcripts) { if (await app.setTranscript(t, { quiet: true })) break; }

      let step = 'files';
      const restored = rec.project ? restoreProject(rec.project, videos) : null;
      if (restored) {
        store.set(restored);
        const canReview = restored.edit.marks.length > 0 || !!restored.analysisKey;
        step = canReview && (rec.step === 'review' || rec.step === 'export') ? rec.step : canReview ? 'review' : 'files';
      }
      const s = store.get();
      job = { ...rec, source: { kind: source.kind, name: source.name }, openedAt: Date.now(), missing: false, videos: s.videos.map(videoFacts) };
      baseline(s);
      loading = false;
      await saveJob();

      // start downloading/initialising ffmpeg while the user checks the files
      ffmpeg.load().catch((e) => console.warn('ffmpeg preload', e));
      const unplayable = videos.filter((v) => !v.playable);
      if (unplayable.length) toast(`browser เล่นไฟล์นี้ไม่ได้: ${unplayable.map((v) => v.name).join(', ')}`, 'error', 9000);
      app.go(step);
      if (!job.thumb && s.videos[0]?.playable) {
        const id = job.id;
        captureThumbnail(s.videos[0].url).then((thumb) => {
          if (!thumb || job?.id !== id) return;
          job.thumb = thumb;
          saveJob();
        });
      }
    } catch (e) {
      console.error(e);
      toast(`อ่านไฟล์ไม่สำเร็จ: ${e.message}`, 'error');
    } finally {
      loading = false;
      b.close();
    }
  },

  /** Save and close the open job, back to the job list. */
  async goHome() {
    if (layerRun) ffmpeg.cancel(); // a background waveform pass for this job: not needed any more
    if (store.get().step === 'home') return;
    if (app.exporting) {
      const ok = await ask({ title: 'กำลังส่งออกอยู่', body: 'ถ้ากลับไปหน้ารายการงาน การส่งออกจะถูกยกเลิก', buttons: [{ label: 'ส่งออกต่อ', value: false }, { label: 'ยกเลิกการส่งออก', value: true, kind: 'danger-fill' }] });
      if (!ok) return;
      ffmpeg.cancel();
    }
    await saveJob();
    for (const v of store.get().videos) URL.revokeObjectURL(v.url);
    job = null;
    history.past = [];
    history.future = [];
    store.reset({ step: 'home' });
    window.scrollTo(0, 0);
  },

  async renameJob(rec, typed) {
    const name = cleanJobName(typed, rec.name);
    if (name === rec.name) return rec;
    if (job && job.id === rec.id) { store.set({ jobName: name }); return { ...rec, name }; }
    const next = { ...rec, name, project: rec.project ? { ...rec.project, jobName: name } : null };
    await jobsDb.putJob(next);
    return next;
  },

  async duplicateJob(rec) {
    const now = Date.now();
    const id = newId('j');
    const name = duplicateName(rec.name);
    const copy = { ...rec, id, name, createdAt: now, openedAt: now, editedAt: now, exportedAt: null, project: rec.project ? { ...rec.project, jobId: id, jobName: name } : null };
    await jobsDb.putJob(copy);
    return copy;
  },

  /** Removes the job from this browser's list only. Videos, exports and the folder's project file stay. */
  async removeJob(rec) { await jobsDb.deleteJob(rec.id); },

  /** The job's work as a file, to keep a copy or move it to another computer. */
  downloadJobFile(rec) {
    const data = { ...(rec.project || {}), app: 'clipcut', jobId: rec.id, jobName: rec.name, transcript: rec.transcript ? { fileName: rec.transcript.fileName } : null };
    if (!data.videos) data.videos = rec.videos;
    downloadBlob(`${safeName(rec.name) || 'clipcut'}.clipcut.json`, JSON.stringify(data, null, 1), 'application/json');
  },

  markExported() {
    if (!job) return;
    job.exportedAt = Date.now();
    saveJob();
  },
  exporting: false,

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

  /** Media layers that belong to the current videos (others are stale: files changed or plugin updated). */
  validLayers() {
    const s = store.get();
    const key = videosKey(s.videos);
    const out = {};
    for (const l of mediaLayers()) {
      const d = s.layers?.[l.id];
      if (d && d.key === key && d.version === l.version) out[l.id] = d;
    }
    return out;
  },

  /** Build missing media layers in the background (e.g. a job opened from before waveforms existed). */
  ensureLayers() {
    if (layerRun) return layerRun;
    const s = store.get();
    const have = app.validLayers();
    const ids = mediaLayers().map((l) => l.id).filter((id) => !have[id]);
    if (!ids.length || !s.videos.length || !s.videos.every((v) => v.duration)) return Promise.resolve();
    const key = videosKey(s.videos);
    const jobId = s.jobId;
    let shown = -1;
    layerRun = (async () => {
      try {
        const { layers } = await runMediaAnalysis({
          videos: s.videos, timeline: app.timeline(), settings: s.detectorSettings, only: [], layers: ids,
          onProgress: ({ ratio }) => {
            if (ratio == null || Math.abs(ratio - shown) < 0.02) return;
            shown = ratio;
            if (store.get().jobId === jobId) store.set({ layerProgress: Object.fromEntries(ids.map((id) => [id, ratio])) });
          },
        });
        const now = store.get();
        if (now.jobId === jobId && videosKey(now.videos) === key) store.set({ layers: { ...now.layers, ...stampLayers(layers, key) }, layerProgress: {} });
      } catch (e) {
        console.warn('media layers', e);
        if (store.get().jobId === jobId) store.set({ layerProgress: {} });
      } finally { layerRun = null; }
    })();
    return layerRun;
  },

  /** Media analysis (if needed) + detectors, then go to review. */
  async analyze({ force = false } = {}) {
    if (layerRun) await layerRun;
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
    const have = app.validLayers();
    const missingLayers = mediaLayers().map((l) => l.id).filter((id) => force || !have[id]);
    const needsMedia = missing.length > 0 || missingLayers.length > 0;
    const noKeyframes = s.videos.filter((v) => !v.keyframes && !v.kfTried);
    if (needsMedia || !s.compat || noKeyframes.length) {
      const b = busy('เตรียมวิเคราะห์เสียง…');
      try {
        if (noKeyframes.length) {
          b.update('อ่านตำแหน่ง keyframe…', null);
          const paths = await ffmpeg.mountInputs(s.videos.map((v) => v.file));
          const videos = await Promise.all(s.videos.map(async (v, i) => {
            if (v.keyframes || v.kfTried) return v;
            const r = await keyframesViaFfprobe(paths[i]).catch(() => null);
            const fps = r && v.duration ? r.packets / v.duration : v.fps;
            return { ...v, keyframes: r?.keyframes || null, kfSource: r ? 'ffprobe' : null, fps: v.fps || fps, kfTried: true };
          }));
          store.set({ videos });
        }
        if (needsMedia) {
          const { analysis: fresh, layers } = await runMediaAnalysis({
            videos: s.videos, timeline: app.timeline(), settings: s.detectorSettings, only: missing, layers: missingLayers,
            onProgress: ({ message, ratio }) => b.update(message, ratio),
          });
          analysis = { ...analysis, ...fresh, _params: { ...used, ...Object.fromEntries(missing.map((id) => [id, paramsOf(detectors().find((d) => d.id === id))])) } };
          store.set({ layers: { ...store.get().layers, ...stampLayers(layers, key) } });
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
    app.commitEdit(applySuggestions(s.edit, suggestions, app.timeline().duration));
  },

  /** Apply an edit operation from core/cuts.js: app.updateEdit((e) => togglePiece(e, key)) */
  updateEdit(fn) { app.commitEdit(fn(store.get().edit)); },

  /** Replace the edit and remember the previous one for undo. `extra` is merged into the state too. */
  commitEdit(next, extra = {}) {
    const cur = store.get().edit;
    if (next === cur) { if (Object.keys(extra).length) store.set(extra); return; }
    history.past.push(cur);
    if (history.past.length > HISTORY_MAX) history.past.shift();
    history.future = [];
    store.set({ edit: next, ...extra });
  },
  undo() {
    if (!history.past.length) return false;
    history.future.push(store.get().edit);
    store.set({ edit: history.past.pop() });
    return true;
  },
  redo() {
    if (!history.future.length) return false;
    history.past.push(store.get().edit);
    store.set({ edit: history.future.pop() });
    return true;
  },
  canUndo: () => history.past.length > 0,
  canRedo: () => history.future.length > 0,

  /** Cut ranges and split points for the export plan. */
  planInput() { return toPlanInput(store.get().edit, app.timeline().duration); },

  /** Write the open job now (normally autosaved). */
  saveNow() { return saveJob(); },

  showHelp,
};

// ---------- saving the open job ----------
// The job record (minus the work, which lives in the store) for the open job.
let job = null;
let layerRun = null;
const stampLayers = (layers, key) => Object.fromEntries(Object.entries(layers).map(([id, d]) => [id, { ...d, key }]));
let loading = false;
let warnedStorage = false;
let warnedSave = false;
const videoFacts = (v) => ({ name: v.name, size: v.size, duration: v.duration || 0, fps: v.fps || null });
// state that is part of the work; changes to all but `analysis` count as edits (for "แก้หลังส่งออก")
const PERSISTED = ['videos', 'transcript', 'anchors', 'anchorMode', 'analysis', 'layers', 'edit', 'detectorSettings', 'exportProfile', 'exportOptions', 'exportExtras', 'outputBase'];
const NOT_EDITS = new Set(['analysis', 'layers']);
let snapshot = null;
let lastStep = null;
let lastName = null;
let saveTimer = 0;

function baseline(s) {
  snapshot = PERSISTED.map((k) => s[k]);
  lastStep = s.step;
  lastName = s.jobName;
}

store.subscribe((s) => {
  if (!job || loading || s.jobId !== job.id) return;
  const snap = PERSISTED.map((k) => s[k]);
  const edited = snapshot && PERSISTED.some((k, i) => !NOT_EDITS.has(k) && snap[i] !== snapshot[i]);
  const changed = !snapshot || snap.some((v, i) => v !== snapshot[i]);
  if (!changed && s.step === lastStep && s.jobName === lastName) return;
  if (edited) job.editedAt = Date.now();
  baseline(s);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveJob, 500);
});

async function saveJob() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const s = store.get();
  if (!job || s.jobId !== job.id) return;
  const project = serializeProject(s);
  job = {
    ...job,
    name: s.jobName || job.name,
    step: s.step === 'home' ? job.step : s.step,
    videos: s.videos.map(videoFacts),
    project,
    transcript: s.transcript || null,
    layers: s.layers || {},
    summary: jobSummary(s),
  };
  try {
    await jobsDb.putJob(job);
  } catch (e) {
    console.warn('save job', e);
    if (!warnedSave) { warnedSave = true; toast(`บันทึกงานไม่สำเร็จ: ${e.message}`, 'error', 9000); }
  }
  // a copy in the folder too, so the work survives a cleared browser and can move to another computer
  if (s.source?.kind === 'folder' && await canWriteNow(s.source.dir)) {
    await writeFileTo(s.source.dir, PROJECT_FILE, JSON.stringify(project, null, 1)).catch((e) => console.warn('project file', e));
  }
  if (store.get().jobId === job.id) store.set({ savedAt: new Date() });
}

// save before the page goes away (IndexedDB usually finishes in time)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveJob(); });
window.addEventListener('pagehide', () => { if (saveTimer) saveJob(); });

// ---------- help ----------
function showHelp() {
  ask({
    title: 'ใช้ ClipCut',
    body: h('div.help',
      h('h3', 'เริ่มงานใหม่'),
      h('p', 'เปิดโฟลเดอร์ที่มีวิดีโอ หรือเลือกไฟล์ หรือลากมาวาง ใส่ได้:'),
      h('ul',
        h('li', h('strong', 'วิดีโอ .mp4 หรือ .mov'), ' ไฟล์เดียว หรือหลายไฟล์ที่บันทึกต่อกัน แอปจะต่อตามลำดับชื่อไฟล์ (เปลี่ยนลำดับได้)'),
        h('li', h('strong', 'transcript ที่มีเวลากำกับ'), ' (.docx, .vtt, .srt หรือ .txt) ไม่มีก็ได้ แอปจะหาจากเสียงเงียบอย่างเดียว')),
      h('h3', 'งานถูกเก็บไว้ที่ไหน'),
      h('p', 'รายการงานเก็บใน browser เครื่องนี้ ไม่คัดลอกวิดีโอ งานที่เปิดจากโฟลเดอร์จะมีไฟล์ clipcut.project.json ในโฟลเดอร์นั้นด้วย เปิดโฟลเดอร์เดิมบนเครื่องอื่นก็ทำต่อได้ ผลลัพธ์อยู่ในโฟลเดอร์ output'),
      h('p', 'Edge และ Chrome บนคอมพิวเตอร์จำตำแหน่งไฟล์ได้ คลิกงานแล้วกดอนุญาตก็เปิดต่อได้ทันที browser อื่นต้องเลือกไฟล์เดิมอีกครั้ง'),
      h('h3', 'ไฟล์ไม่ออกจากเครื่อง'),
      h('p', 'ทุกอย่างประมวลผลใน browser บนคอมพิวเตอร์นี้ ไม่มีการอัปโหลดและไม่ใช้ AI'),
      h('h3', 'ปุ่มลัด'),
      h('p', 'กด ', h('kbd', '?'), ' ในหน้าตรวจจุดตัดเพื่อดูปุ่มลัดทั้งหมด')),
    buttons: [{ label: 'ปิด', value: true, kind: 'primary' }],
  });
}

// ---------- shell ----------
const root = document.getElementById('app');
const stepNav = h('ol.steps');
const saveState = h('span.save-state');
const helpBtn = h('button.ghost.small', { type: 'button', onclick: showHelp }, icon('help', 16), 'ช่วยเหลือ');
const jobName = h('button.job-title', { type: 'button', 'data-tip': 'เปลี่ยนชื่องาน', onclick: () => renameInHeader() }, h('span.job-title-text'), icon('pencil', 14));
const jobBar = h('div.jobbar',
  h('button.ghost.small.back-home', { type: 'button', onclick: () => app.goHome() }, icon('arrowLeft', 16), 'งานทั้งหมด'),
  jobName);
const header = h('header.top',
  h('button.brand', { type: 'button', onclick: () => app.goHome(), 'aria-label': 'ClipCut หน้ารายการงาน' },
    h('img.brand-mark', { src: './icons/favicon.svg', alt: '', width: 26, height: 26 }), h('span.brand-name', 'ClipCut'), h('span.brand-ver', `v${APP_VERSION}`)),
  jobBar,
  h('nav', { 'aria-label': 'ขั้นตอน' }, stepNav),
  h('div.top-right', saveState, helpBtn));
const main = h('main.screen');
root.append(header, main);

let editingName = false;
function renameInHeader() {
  if (editingName) return;
  editingName = true;
  const old = store.get().jobName;
  const input = h('input.job-title-input', { type: 'text', value: old, 'aria-label': 'ชื่องาน', maxlength: 120 });
  const done = (commit) => {
    if (!editingName) return;
    editingName = false;
    input.replaceWith(jobName);
    if (commit) store.set({ jobName: cleanJobName(input.value, old) });
    renderShell(store.get());
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  jobName.replaceWith(input);
  input.focus();
  input.select();
}

let current = { step: null, unmount: null };
function renderShell(s) {
  const home = s.step === 'home';
  header.classList.toggle('in-job', !home);
  jobBar.hidden = home;
  stepNav.hidden = home;
  helpBtn.hidden = !home;
  if (!editingName) jobName.querySelector('.job-title-text').textContent = s.jobName || 'งานไม่มีชื่อ';
  document.title = home ? 'ClipCut' : `${s.jobName || 'งาน'} — ClipCut`;
  const idx = STEPS.findIndex((x) => x.id === s.step);
  const reachable = (id) => s.videos.length > 0 && (id === 'files' || s.edit.marks.length > 0 || !!s.analysisKey);
  clear(stepNav, home ? [] : STEPS.map((st, i) => h(`li${i === idx ? '.current' : i < idx ? '.done' : ''}`,
    h('button', { type: 'button', disabled: !reachable(st.id) || i === idx, onclick: () => app.go(st.id), 'aria-current': i === idx ? 'step' : null },
      h('span.step-n', String(i + 1)), h('span.step-label', st.label)))));
  if (home) saveState.textContent = '';
  else {
    const at = s.savedAt ? `บันทึกแล้ว ${s.savedAt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : '';
    saveState.textContent = [at, s.source?.kind === 'folder' ? `โฟลเดอร์ ${s.source.name}` : ''].filter(Boolean).join(' · ');
  }

  if (s.step !== current.step) {
    current.unmount?.();
    clear(main);
    const screen = SCREENS[s.step];
    current = { step: s.step, unmount: screen.mount(main, app) };
  }
}
store.subscribe(renderShell);
renderShell(store.get());

// dropping files or a folder anywhere on the job list starts a job
let dragDepth = 0;
const dragging = (on) => document.body.classList.toggle('dragging', on && store.get().step === 'home');
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; dragging(true); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragging(false); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dragging(false);
  if (store.get().step === 'home' && e.dataTransfer?.files?.length) app.newFromDrop(e.dataTransfer);
});

// service worker for offline use
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
}

// for debugging in the console
window.clipcut = { app, store, formatTime, version: APP_VERSION, jobsDb };
