// Reads keyframe (sync sample) times from an MP4/MOV file without decoding anything.
// Only the box headers and the 'moov' box are read, so this takes milliseconds even for
// multi-gigabyte recordings whose 'moov' sits at the end of the file.
// Returns presentation times in seconds, matching what ffmpeg reports as pts_time.

async function readBytes(blob, start, length) {
  const end = Math.min(blob.size, start + length);
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const typeOf = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Find a top-level box by walking headers only. */
async function findTopLevel(blob, wanted) {
  let pos = 0;
  while (pos + 8 <= blob.size) {
    const h = await readBytes(blob, pos, 16);
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = typeOf(h, 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); header = 16; } else if (size === 0) { size = blob.size - pos; }
    if (size < header) return null;
    if (type === wanted) return { start: pos, size, header };
    pos += size;
  }
  return null;
}

function* children(buf, start, end) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const type = typeOf(buf, pos + 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(pos + 8)); header = 16; } else if (size === 0) { size = end - pos; }
    if (size < header || pos + size > end) return;
    yield { type, start: pos, end: pos + size, body: pos + header };
    pos += size;
  }
}

const child = (buf, box, type) => { for (const c of children(buf, box.body, box.end)) if (c.type === type) return c; return null; };
const path = (buf, box, ...types) => types.reduce((b, t) => (b ? child(buf, b, t) : null), box);

export function parseMoov(buf) {
  const moov = { body: 0, end: buf.length };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fullBox = (box) => ({ version: buf[box.body], flags: (buf[box.body + 1] << 16) | (buf[box.body + 2] << 8) | buf[box.body + 3], at: box.body + 4 });

  const mvhd = child(buf, moov, 'mvhd');
  let movieTimescale = 1000;
  if (mvhd) {
    const { version, at } = fullBox(mvhd);
    movieTimescale = dv.getUint32(at + (version === 1 ? 16 : 8));
  }
  if (child(buf, moov, 'mvex')) return { fragmented: true };

  for (const trak of children(buf, 0, buf.length)) {
    if (trak.type !== 'trak') continue;
    const hdlr = path(buf, trak, 'mdia', 'hdlr');
    if (!hdlr || typeOf(buf, hdlr.body + 8) !== 'vide') continue;

    const mdhd = path(buf, trak, 'mdia', 'mdhd');
    const md = fullBox(mdhd);
    const timescale = dv.getUint32(md.at + (md.version === 1 ? 16 : 8));
    const mediaDuration = md.version === 1 ? Number(dv.getBigUint64(md.at + 20)) : dv.getUint32(md.at + 12);

    const stbl = path(buf, trak, 'mdia', 'minf', 'stbl');
    if (!stbl) return null;

    // decode times (stts)
    const stts = child(buf, stbl, 'stts');
    const dts = [];
    {
      const { at } = fullBox(stts);
      const n = dv.getUint32(at);
      let t = 0;
      for (let i = 0; i < n; i++) {
        const count = dv.getUint32(at + 4 + i * 8);
        const delta = dv.getUint32(at + 8 + i * 8);
        for (let j = 0; j < count; j++) { dts.push(t); t += delta; }
      }
    }
    // composition offsets (ctts), optional
    const ctts = child(buf, stbl, 'ctts');
    const cto = new Float64Array(dts.length);
    if (ctts) {
      const { version, at } = fullBox(ctts);
      const n = dv.getUint32(at);
      let k = 0;
      for (let i = 0; i < n && k < dts.length; i++) {
        const count = dv.getUint32(at + 4 + i * 8);
        const off = version === 1 ? dv.getInt32(at + 8 + i * 8) : dv.getUint32(at + 8 + i * 8);
        for (let j = 0; j < count && k < dts.length; j++) cto[k++] = off;
      }
    }
    // sync samples (stss); absent = every sample is a keyframe
    const stss = child(buf, stbl, 'stss');
    let syncIdx;
    if (stss) {
      const { at } = fullBox(stss);
      const n = dv.getUint32(at);
      syncIdx = new Array(n);
      for (let i = 0; i < n; i++) syncIdx[i] = dv.getUint32(at + 4 + i * 4) - 1;
    } else {
      syncIdx = dts.map((_, i) => i);
    }
    // edit list: empty edits delay the track, media_time trims its start
    let shift = 0; // in media timescale units, added to (dts + cto)
    const elst = path(buf, trak, 'edts', 'elst');
    if (elst) {
      const { version, at } = fullBox(elst);
      const n = dv.getUint32(at);
      let p = at + 4;
      for (let i = 0; i < n; i++) {
        const segDur = version === 1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
        const mediaTime = version === 1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
        p += version === 1 ? 20 : 12;
        if (mediaTime === -1) { shift += (segDur / movieTimescale) * timescale; continue; }
        shift -= mediaTime;
        break;
      }
    }
    const keyframes = syncIdx
      .filter((i) => i >= 0 && i < dts.length)
      .map((i) => (dts[i] + cto[i] + shift) / timescale)
      .sort((a, b) => a - b);
    const span = dts.length > 1 ? (dts[dts.length - 1] - dts[0]) / timescale : 0;
    const fps = span > 0 ? (dts.length - 1) / span : null;
    return { keyframes, timescale, duration: mediaDuration / timescale, samples: dts.length, fps };
  }
  return null;
}

/**
 * @param {Blob} blob an MP4/MOV file
 * @returns {Promise<{keyframes:number[],duration:number}|null>} null when the file is not a plain MP4
 */
export async function readMp4Keyframes(blob) {
  try {
    const moov = await findTopLevel(blob, 'moov');
    if (!moov || moov.size > 256 * 1024 * 1024) return null;
    const buf = await readBytes(blob, moov.start + moov.header, moov.size - moov.header);
    const res = parseMoov(buf);
    if (!res || res.fragmented || !res.keyframes || res.keyframes.length === 0) return null;
    return res;
  } catch (err) {
    console.warn('readMp4Keyframes failed', err);
    return null;
  }
}
