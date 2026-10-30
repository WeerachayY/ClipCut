// The one place where features are switched on. To add a feature, import its module and
// register it here. Order matters only for display order in the UI.
import { registerTranscriptParser, registerDetector, registerExportProfile } from '../core/registry.js';

import saraDocx from './transcript/sara-docx.js';
import vtt from './transcript/vtt.js';
import bracketText from './transcript/text.js';

import transcriptGap from './detectors/transcript-gap.js';
import keywords from './detectors/keywords.js';
import silence from './detectors/silence.js';

import copy from './export/copy.js';
import compressH264 from './export/compress-h264.js';

registerTranscriptParser(saraDocx);
registerTranscriptParser(vtt);
registerTranscriptParser(bracketText);

registerDetector(transcriptGap);
registerDetector(keywords);
registerDetector(silence);

registerExportProfile(copy);
registerExportProfile(compressH264);
