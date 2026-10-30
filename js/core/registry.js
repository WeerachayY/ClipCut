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

const registries = {
  transcriptParsers: new Map(),
  detectors: new Map(),
  exportProfiles: new Map(),
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

export const transcriptParsers = () => [...registries.transcriptParsers.values()];
export const detectors = () => [...registries.detectors.values()];
export const exportProfiles = () => [...registries.exportProfiles.values()];
export const getExportProfile = (id) => registries.exportProfiles.get(id);
export const getDetector = (id) => registries.detectors.get(id);

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
