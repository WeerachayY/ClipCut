// Plugin registries. Adding a feature = write one module that matches an interface below,
// then add one import + register line in js/plugins/index.js. See docs/EXTENDING.md.
//
// Transcript parser
//   { id, label, extensions: ['.docx'], sniff?(text):boolean, parse(file: File|Blob) -> Promise<{lines:[{tau,speaker,text}]}> }
//
// Detector (finds candidate cuts; must be deterministic, no network)
//   { id, label, description, needs: 'transcript'|'audio', defaults: {...},
//     settings?: [{key,label,type:'number'|'text'|'boolean',unit?,min?,max?,step?}],
//     detect(ctx, params) -> Promise<Candidate[]>|Candidate[] }      (see core/suggest.js for Candidate)
//
// Export profile (turns a concat list into an output file)
//   { id, label, description, speed: 'fast'|'slow', experimental?, options: [{key,label,type:'select',choices:[{value,label}],default}],
//     outputExtension: 'mp4', buildArgs({listPath, outPath, options}) -> string[] }
//
// Media layer (data measured from the recordings once, kept with the job, drawn by tracks or used by detectors)
//   { id, label, version, needs: 'audio',
//     ffmpegOutput(outPath) -> string[]            output args added to the shared per-file ffmpeg pass
//     collect({bytes, file}) -> perFileData        bytes = what ffmpeg wrote to outPath, file = {start,duration}
//     combine(perFile:[{data,file}], duration) -> layerData }   (global time)
//
// Timeline track (one lane of the editing strip, drawn on a canvas of the visible stretch only)
//   { id, label, order, height, enabledByDefault?, layer?: 'mediaLayerId',
//     draw(view) }   view = {g, width, height, t0, t1, pxPerSec, x(t), duration, timeline, layer, progress, frames, analysis, colors, redraw()}
//
// Export extra (a side file written next to each export, e.g. captions or a report)
//   { id, label, description, defaultOn, available?(ctx) -> boolean,
//     options?: [{key,label,type:'checkbox',default}],
//     build(ctx) -> [{name, data: string|Uint8Array}] }
//     ctx = {plan, timeline, names (output file per part), base, fileBase, spans (transcript lines on the timeline), transcript, options}

const registries = {
  transcriptParsers: new Map(),
  detectors: new Map(),
  exportProfiles: new Map(),
  mediaLayers: new Map(),
  tracks: new Map(),
  exportExtras: new Map(),
};

function add(kind, plugin, required) {
  for (const key of required) {
    if (plugin[key] == null) throw new Error(`${kind} plugin "${plugin.id || '?'}" is missing "${key}"`);
  }
  registries[kind].set(plugin.id, plugin);
  return plugin;
}

export const registerTranscriptParser = (p) => add('transcriptParsers', p, ['id', 'label', 'extensions', 'parse']);
export const registerDetector = (p) => add('detectors', p, ['id', 'label', 'needs', 'detect']);
export const registerExportProfile = (p) => add('exportProfiles', p, ['id', 'label', 'buildArgs']);
export const registerMediaLayer = (p) => add('mediaLayers', p, ['id', 'label', 'version', 'needs', 'ffmpegOutput', 'collect', 'combine']);
export const registerTrack = (p) => add('tracks', p, ['id', 'label', 'height', 'draw']);
export const registerExportExtra = (p) => add('exportExtras', p, ['id', 'label', 'build']);

export const transcriptParsers = () => [...registries.transcriptParsers.values()];
export const detectors = () => [...registries.detectors.values()];
export const exportProfiles = () => [...registries.exportProfiles.values()];
export const getExportProfile = (id) => registries.exportProfiles.get(id);
export const getDetector = (id) => registries.detectors.get(id);
export const mediaLayers = () => [...registries.mediaLayers.values()];
export const tracks = () => [...registries.tracks.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
export const exportExtras = () => [...registries.exportExtras.values()];

/** Pick a parser for a file name (and optionally its text, for formats that share an extension). */
export function findTranscriptParser(name, text) {
  const lower = name.toLowerCase();
  const byExt = transcriptParsers().filter((p) => p.extensions.some((ext) => lower.endsWith(ext)));
  if (text != null) {
    const sniffed = byExt.find((p) => p.sniff && p.sniff(text));
    if (sniffed) return sniffed;
  }
  return byExt[0] || null;
}

/** Default parameter object for every registered detector: {detectorId: {enabled, ...defaults}} */
export function defaultDetectorSettings() {
  const out = {};
  for (const d of detectors()) out[d.id] = { enabled: d.enabledByDefault !== false, ...(d.defaults || {}) };
  return out;
}
