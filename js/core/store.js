// Application state with a tiny subscribe/notify loop, plus project (de)serialisation.
// Video File objects and folder handles live only in memory; the project file stores
// names, sizes and every decision so work can be resumed later.
import { defaultDetectorSettings } from './registry.js';

export const PROJECT_FILE = 'clipcut.project.json';
export const PROJECT_VERSION = 1;

let uid = 0;
export const newId = (prefix = 'id') => `${prefix}${Date.now().toString(36)}${(uid++).toString(36)}`;

export function initialState() {
  return {
    step: 'start',
    source: null,            // {kind:'folder'|'files', dir?: FileSystemDirectoryHandle, name}
    videos: [],              // [{id,name,size,lastModified,file,url,duration,keyframes,kfSource,codec}]
    transcriptFile: null,    // File
    transcript: null,        // {fileName, parserId, lines:[{tau,speaker,text,idx}], removed}
    otherFiles: [],          // names we ignored
    anchors: [],             // [{id,tau,g,lineIdx}]
    anchorMode: 'linear',
    analysis: {},            // {detectorId: [{start,end}] global}
    analysisKey: null,       // which videos the analysis belongs to
    cuts: [],                // [{id,start,end,status,confidence,reasons,origin,edited}]
    splits: [],              // [{id,at,label}]
    detectorSettings: defaultDetectorSettings(),
    exportProfile: 'copy',
    exportOptions: {},
    outputBase: '',
    selectedCutId: null,
    savedAt: null,
  };
}

export function createStore() {
  let state = initialState();
  const subs = new Set();
  let scheduled = false;
  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; subs.forEach((fn) => fn(state)); });
  };
  return {
    get: () => state,
    set(patch) { state = { ...state, ...patch }; notify(); },
    update(fn) { state = { ...state, ...fn(state) }; notify(); },
    reset(keep = {}) { state = { ...initialState(), ...keep }; notify(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export function serializeProject(s) {
  return {
    app: 'clipcut',
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    videos: s.videos.map((v) => ({ name: v.name, size: v.size, duration: v.duration })),
    transcript: s.transcript ? { fileName: s.transcript.fileName } : null,
    anchors: s.anchors,
    anchorMode: s.anchorMode,
    analysis: s.analysis,
    analysisKey: s.analysisKey,
    cuts: s.cuts,
    splits: s.splits,
    detectorSettings: s.detectorSettings,
    exportProfile: s.exportProfile,
    exportOptions: s.exportOptions,
    outputBase: s.outputBase,
  };
}

/**
 * Apply a saved project to freshly loaded videos. Videos are matched by name + size;
 * returns null (and changes nothing) when the folder no longer holds the same recordings.
 */
export function restoreProject(saved, videos) {
  if (!saved || saved.app !== 'clipcut') return null;
  const byKey = new Map(videos.map((v) => [`${v.name}|${v.size}`, v]));
  const ordered = [];
  for (const sv of saved.videos || []) {
    const v = byKey.get(`${sv.name}|${sv.size}`);
    if (!v) return null;
    ordered.push(v);
  }
  const rest = videos.filter((v) => !ordered.includes(v));
  return {
    videos: [...ordered, ...rest],
    anchors: saved.anchors || [],
    anchorMode: saved.anchorMode || 'linear',
    analysis: saved.analysis || {},
    analysisKey: saved.analysisKey || null,
    cuts: saved.cuts || [],
    splits: saved.splits || [],
    detectorSettings: { ...defaultDetectorSettings(), ...(saved.detectorSettings || {}) },
    exportProfile: saved.exportProfile || 'copy',
    exportOptions: saved.exportOptions || {},
    outputBase: saved.outputBase || '',
  };
}

/** Identifies a set of videos in order, so cached analysis is reused only for the same input. */
export const videosKey = (videos) => videos.map((v) => `${v.name}:${v.size}`).join('|');
