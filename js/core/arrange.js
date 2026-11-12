// "Pick and arrange pieces": the pieces made by the cut points become clips that can be chosen,
// named, reordered, and exported one file each or joined into one.
// State (kept with the job): { mode: 'cut'|'clips', output: 'separate'|'joined', order: [pieceKey], off: {key:true}, names: {key:name} }
export const emptyArrange = () => ({ mode: 'cut', output: 'separate', order: [], off: {}, names: {} });

/**
 * Clips in their output order, reconciled with the current pieces: pieces that no longer exist drop out,
 * new ones slot in after their neighbour on the timeline. A piece thrown away in the review step starts unticked.
 * @param {object} arrange
 * @param {{key:string,start:number,end:number,status:string}[]} pieces  from cuts.piecesOf (timeline order)
 */
export function clipList(arrange, pieces) {
  const a = { ...emptyArrange(), ...(arrange || {}) };
  const byKey = new Map(pieces.map((p, i) => [p.key, { p, i }]));
  const order = a.order.filter((k) => byKey.has(k));
  const seen = new Set(order);
  pieces.forEach((p, i) => {
    if (seen.has(p.key)) return;
    const prev = i > 0 ? order.indexOf(pieces[i - 1].key) : -1;
    order.splice(prev + 1, 0, p.key);
    seen.add(p.key);
  });
  return order.map((key) => {
    const { p, i } = byKey.get(key);
    return {
      key, start: p.start, end: p.end, number: i + 1,
      name: a.names[key] || `ชิ้น ${i + 1}`,
      named: !!a.names[key],
      on: a.off[key] === undefined ? p.status !== 'delete' : !a.off[key],
    };
  });
}

/** Move the clip `key` to position `to` (index in the current list). */
export function moveClip(arrange, pieces, key, to) {
  const order = clipList(arrange, pieces).map((c) => c.key);
  const from = order.indexOf(key);
  if (from < 0) return arrange;
  order.splice(from, 1);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, key);
  return { ...arrange, order };
}

export const setClipOn = (arrange, key, on) => ({ ...arrange, off: { ...arrange.off, [key]: !on } });
export const setClipName = (arrange, key, name) => {
  const names = { ...arrange.names };
  const t = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (t) names[key] = t; else delete names[key];
  return { ...arrange, names };
};
/** Back to the order of the recording. */
export const resetOrder = (arrange) => ({ ...arrange, order: [] });
/** True when the chosen clips are not in the order of the recording. */
export const isReordered = (clips) => clips.filter((c) => c.on).some((c, i, l) => i > 0 && c.start < l[i - 1].start);
