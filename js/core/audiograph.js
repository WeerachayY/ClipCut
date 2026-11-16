// The sound of one program part as one ffmpeg run: the main track (with its speed changes), extra audio
// (music, voice, sound of overlay videos) with volume, fades and ducking under speech, mixed together.
// Pure: builds the argument list only, so it can be checked without a browser.
import { speedChunks } from './speed.js';
import { DUCK } from './compose.js';

export const SR = 48000;
const f6 = (x) => Math.max(0, x).toFixed(6);
const FORMAT = `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;
// mono is copied to both sides at full level (ffmpeg's own upmix would make it 3 dB quieter)
const formatFor = (channels) => (channels === 1 ? `pan=stereo|c0=c0|c1=c0,${FORMAT}` : FORMAT);

/** Speed change for one stretch: atempo keeps the pitch; asetrate shifts it (the "chipmunk" option). */
export function tempoFilters(rate, pitch) {
  if (Math.abs(rate - 1) < 1e-4) return [];
  if (pitch) return [`asetrate=${(SR * rate).toFixed(3)}`, `aresample=${SR}`];
  const out = [];
  let r = rate;
  while (r < 0.5) { out.push('atempo=0.5'); r /= 0.5; }
  while (r > 100) { out.push('atempo=100'); r /= 100; }
  out.push(`atempo=${r.toFixed(6)}`);
  return out;
}

/**
 * @param {object} o
 * @param {object} o.part            program part (core/program.js)
 * @param {string[]} o.mainPaths     ffmpeg path of each main file (by fileIndex)
 * @param {boolean[]} o.mainHasAudio
 * @param {number[]} [o.mainChannels]  channels of each main file's sound (1 = mono)
 * @param {object[]} o.clips         clips with sound on the part's own clock (clipsInWindow): audio, and video with volume
 * @param {object} o.assetPaths      {assetId: ffmpeg path}
 * @param {object} o.assetHasAudio   {assetId: boolean}
 * @param {object} [o.assetChannels] {assetId: channels}
 * @param {number} [o.mainVolume]
 * @param {string[]} [o.leadInputs]  inputs that come first (e.g. a concat list of the video), indices 0..n-1
 * @param {string[]} o.outArgs       mapping is added here; pass codec options and the output path
 */
export function partAudioArgs({ part, mainPaths, mainHasAudio, mainChannels = [], clips = [], assetPaths = {}, assetHasAudio = {}, assetChannels = {}, mainVolume = 1, leadInputs = [], outArgs }) {
  const inputs = [...leadInputs];
  const leadCount = countInputs(leadInputs);
  const index = new Map();
  const input = (path) => {
    if (!index.has(path)) { index.set(path, leadCount + index.size); inputs.push('-i', path); }
    return index.get(path);
  };
  const chains = [];
  const mainLabels = [];

  // main track, piece by piece, in stretches of constant speed
  let n = 0;
  for (const seg of part.segments) {
    const pieceA = seg.srcStart - seg.pieceStart;
    const pieceB = seg.srcEnd - seg.pieceStart;
    for (const ch of speedChunks(seg.map, pieceA, pieceB)) {
      const label = `m${n++}`;
      const outLen = seg.map.toOut(ch.to) - seg.map.toOut(ch.from);
      if (outLen < 1e-4) continue;
      if (mainHasAudio[seg.fileIndex]) {
        const i = input(mainPaths[seg.fileIndex]);
        const a = seg.inpoint + (ch.from - pieceA);
        const b = seg.inpoint + (ch.to - pieceA);
        chains.push(`[${i}:a:0]${['atrim=start=' + f6(a) + ':end=' + f6(b), 'asetpts=PTS-STARTPTS', formatFor(mainChannels[seg.fileIndex]), ...tempoFilters(ch.rate, seg.map.pitch)].join(',')}[${label}]`);
      } else {
        chains.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${f6(outLen)}[${label}]`);
      }
      mainLabels.push(label);
    }
  }
  if (!mainLabels.length) {
    chains.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${f6(part.duration)}[m0]`);
    mainLabels.push('m0');
  }
  // exact length: tiny rounding in the speed changes must not make the sound drift from the picture
  chains.push(`${mainLabels.map((l) => `[${l}]`).join('')}concat=n=${mainLabels.length}:v=0:a=1,volume=${(+mainVolume).toFixed(3)},apad,atrim=end=${f6(part.duration)}[main]`);

  // extra sound
  const ducked = new Map(); // duck level -> labels
  const plain = [];
  clips.forEach((c, j) => {
    if (c.kind === 'video' && !assetHasAudio[c.asset]) return;
    const path = assetPaths[c.asset];
    if (!path) return;
    const vol = c.volume ?? 1;
    if (vol <= 0) return;
    const i = input(path);
    const f = [`atrim=start=${f6(c.offset || 0)}:end=${f6((c.offset || 0) + c.duration)}`, 'asetpts=PTS-STARTPTS', formatFor(assetChannels[c.asset]), `volume=${vol.toFixed(3)}`];
    const fi = Math.min(c.fadeIn || 0, c.duration / 2) - (c.cutHead || 0);
    const fo = Math.min(c.fadeOut || 0, c.duration / 2) - (c.cutTail || 0);
    if (fi > 0.01) f.push(`afade=t=in:st=0:d=${f6(fi)}`);
    if (fo > 0.01) f.push(`afade=t=out:st=${f6(c.duration - fo)}:d=${f6(fo)}`);
    if (c.start > 0.0005) f.push(`adelay=delays=${Math.round(c.start * 1000)}:all=1`);
    const label = `x${j}`;
    chains.push(`[${i}:a:0]${f.join(',')}[${label}]`);
    const level = c.kind === 'audio' && DUCK[c.duck] ? c.duck : null;
    if (level) { if (!ducked.has(level)) ducked.set(level, []); ducked.get(level).push(label); } else plain.push(label);
  });

  const toMix = [];
  if (ducked.size) {
    // speech (the main track) pushes the music down
    const sc = [...ducked.keys()].map((_, g) => `sc${g}`);
    chains.push(`[main]asplit=${sc.length + 1}[mainA]${sc.map((l) => `[${l}]`).join('')}`);
    toMix.push('mainA');
    [...ducked.entries()].forEach(([level, labels], g) => {
      let bus = labels[0];
      if (labels.length > 1) { bus = `db${g}`; chains.push(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${bus}]`); }
      chains.push(`[${bus}][sc${g}]sidechaincompress=threshold=0.015:ratio=${DUCK[level].ratio}:attack=20:release=400:makeup=1[dk${g}]`);
      toMix.push(`dk${g}`);
    });
  } else toMix.push('main');
  toMix.push(...plain);
  if (toMix.length > 1) chains.push(`${toMix.map((l) => `[${l}]`).join('')}amix=inputs=${toMix.length}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.97:level=false[aout]`);
  else chains.push(`[${toMix[0]}]anull[aout]`);

  return ['-hide_banner', ...inputs, '-filter_complex', chains.join(';'), '-map', '[aout]', ...outArgs];
}

const countInputs = (args) => args.filter((a) => a === '-i').length;

/** Output options for the sound alone, by file type. */
export function audioOut(ext, path, bitrate = '192k') {
  if (ext === 'wav') return ['-c:a', 'pcm_s16le', '-y', path];
  if (ext === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', bitrate, '-y', path];
  return ['-c:a', 'aac', '-b:a', bitrate, '-y', path];
}
