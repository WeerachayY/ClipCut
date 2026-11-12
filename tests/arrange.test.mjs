// "Pick and arrange pieces": clip list, reordering, and the export plan made from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyArrange, clipList, moveClip, setClipOn, setClipName, resetOrder, isReordered } from '../js/core/arrange.js';
import { emptyEdit, addMark, setPieceStatus, piecesOf, removeMark, START } from '../js/core/cuts.js';
import { buildClipPlan, buildConcatList } from '../js/core/plan.js';
import { Timeline } from '../js/core/timeline.js';
import { partCues } from '../js/core/captions.js';
import { formatClockMs } from '../js/core/time.js';
import { classifyFiles, mediaKind } from '../js/io/folder.js';
import '../js/plugins/index.js';
import { getExportProfile, exportProfiles } from '../js/core/registry.js';
import { outputExtension, profilesFor } from '../js/media/export.js';

function fourPieces() {
  let e = emptyEdit();
  const ids = [];
  for (const t of [10, 20, 30]) { const r = addMark(e, t, 40); e = r.edit; ids.push(r.id); }
  return { e, ids };
}

test('clips follow the pieces; thrown-away pieces start unticked', () => {
  const { e, ids } = fourPieces();
  const e2 = setPieceStatus(e, ids[0], 'delete');
  const clips = clipList(emptyArrange(), piecesOf(e2, 40));
  assert.deepEqual(clips.map((c) => [c.name, c.start, c.end, c.on]), [['ชิ้น 1', 0, 10, true], ['ชิ้น 2', 10, 20, false], ['ชิ้น 3', 20, 30, true], ['ชิ้น 4', 30, 40, true]]);
  let a = setClipOn(emptyArrange(), ids[0], true);
  a = setClipName(a, ids[0], '  เพลง   แรก ');
  assert.deepEqual(clipList(a, piecesOf(e2, 40))[1], { key: ids[0], start: 10, end: 20, number: 2, name: 'เพลง แรก', named: true, on: true });
});

test('reordering survives new and removed cut points', () => {
  const { e, ids } = fourPieces();
  const ps = piecesOf(e, 40);
  let a = moveClip(emptyArrange(), ps, ids[2], 0); // last piece first
  assert.deepEqual(clipList(a, ps).map((c) => c.number), [4, 1, 2, 3]);
  assert.equal(isReordered(clipList(a, ps)), true);
  assert.equal(isReordered(clipList(emptyArrange(), ps)), false);
  // a new cut point inside piece 2: the new piece slots in after piece 2
  const e2 = addMark(e, 15, 40).edit;
  assert.deepEqual(clipList(a, piecesOf(e2, 40)).map((c) => [c.start, c.end]), [[30, 40], [0, 10], [10, 15], [15, 20], [20, 30]]);
  // joining removes a piece from the list
  const e3 = removeMark(e, ids[2]);
  assert.deepEqual(clipList(a, piecesOf(e3, 40)).map((c) => [c.start, c.end]), [[0, 10], [10, 20], [20, 40]]);
  assert.deepEqual(clipList(resetOrder(a), ps).map((c) => c.number), [1, 2, 3, 4]);
  assert.equal(START.length > 0, true);
});

test('clip plan: one file per clip, or joined in the chosen order', () => {
  const tl = new Timeline([{ id: 'a', name: 'a.mp3', duration: 40, kind: 'audio' }]);
  const clips = [{ key: 'c', start: 30, end: 40, name: 'ท้าย' }, { key: 'a', start: 0, end: 10, name: 'หัว' }];
  const sep = buildClipPlan(tl, clips, { snap: false });
  assert.deepEqual(sep.parts.map((p) => [p.label, p.duration, p.segments[0].inpoint, p.segments[0].outpoint]), [['ท้าย', 10, 30, null], ['หัว', 10, 0, 10]]);
  const one = buildClipPlan(tl, clips, { snap: false, joined: true });
  assert.equal(one.parts.length, 1);
  assert.deepEqual(one.parts[0].segments.map((s) => [s.inpoint, s.outpoint]), [[30, null], [0, 10]]);
  assert.equal(one.keptDuration, 20);
  assert.deepEqual(one.removed, [{ start: 10, end: 30 }]);
  assert.match(buildConcatList(one.parts[0], () => '/in/a.mp3'), /inpoint 30\.000\nfile '\/in\/a\.mp3'\noutpoint 10\.000/);
  // captions follow the new order
  const cues = partCues(one.parts[0], [{ start: 2, end: 4, text: 'หัว' }, { start: 32, end: 34, text: 'ท้าย' }]);
  assert.deepEqual(cues.map((c) => [c.text, Math.round(c.start)]), [['ท้าย', 2], ['หัว', 12]]);
});

test('clip plan with keyframes: neighbours play through, other starts snap down', () => {
  const tl = new Timeline([{ id: 'v', name: 'v.mp4', duration: 40, keyframes: [0, 8, 16, 24, 32] }]);
  const joined = buildClipPlan(tl, [{ start: 10, end: 20 }, { start: 20, end: 30 }, { start: 0, end: 10 }], { joined: true });
  assert.deepEqual(joined.parts[0].segments.map((s) => [s.inpoint, s.outpoint]), [[8, 30], [0, 10]]);
  const sep = buildClipPlan(tl, [{ start: 10, end: 20 }, { start: 20, end: 30 }], { joined: false });
  assert.deepEqual(sep.parts.map((p) => p.segments[0].inpoint), [8, 16]);
  assert.equal(buildClipPlan(tl, [], {}).parts.length, 0);
});

test('audio jobs: files, profiles, extension, clock', () => {
  const c = classifyFiles([{ name: 'b.mp3' }, { name: 'a.mp3' }, { name: 'notes.txt' }]);
  assert.deepEqual(c.videos.map((f) => f.name), ['a.mp3', 'b.mp3']);
  const mixed = classifyFiles([{ name: 'talk.mp4' }, { name: 'talk.mp3' }]);
  assert.deepEqual([mixed.videos.map((f) => f.name), mixed.ignored.map((f) => f.name)], [['talk.mp4'], ['talk.mp3']]);
  assert.deepEqual([mediaKind('x.MP3'), mediaKind('x.mp4')], ['audio', 'video']);
  const audio = new Timeline([{ id: 'a', name: 'เพลง.M4A', duration: 10, kind: 'audio' }]);
  const video = new Timeline([{ id: 'v', name: 'v.mp4', duration: 10 }]);
  assert.deepEqual([audio.kind, audio.ext, video.kind], ['audio', 'm4a', 'video']);
  assert.deepEqual(profilesFor(exportProfiles(), audio).map((p) => p.id), ['audio-copy', 'audio-exact']);
  assert.deepEqual(profilesFor(exportProfiles(), video).map((p) => p.id), ['copy', 'compress-h264']);
  assert.equal(outputExtension(getExportProfile('audio-copy'), audio), 'm4a');
  assert.equal(outputExtension(getExportProfile('copy'), video), 'mp4');
  const seg = { fileIndex: 0, inpoint: 30, outpoint: 40.5, duration: 10.5 };
  assert.deepEqual(getExportProfile('audio-copy').perSegment.segmentArgs({ inputPath: '/in/a.mp3', segment: seg, outPath: '/o.mp3' }),
    ['-hide_banner', '-i', '/in/a.mp3', '-ss', '30.000', '-to', '40.500', '-map', '0:a:0', '-c', 'copy', '-y', '/o.mp3']);
  const ex = getExportProfile('audio-exact').buildArgs({ outPath: '/o.mp3', options: { bitrate: '128k' }, segments: [seg, { fileIndex: 0, inpoint: 0, outpoint: 5 }], inputPaths: ['/in/a.mp3'] });
  assert.ok(ex.join(' ').includes('[0:a:0]atrim=start=30.000000:end=40.500000,asetpts=PTS-STARTPTS[a0];[0:a:0]atrim=start=0.000000:end=5.000000,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[a]'));
  assert.ok(ex.join(' ').endsWith('-c:a libmp3lame -b:a 128k -y /o.mp3'));
  assert.equal(formatClockMs(3910.5), '1:05:10.500');
  assert.equal(formatClockMs(65.0349, { short: true }), '01:05.035');
});
