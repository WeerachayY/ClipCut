// Cutting by transcript and captions for exported parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineSpans, rangeOfLines, quietestNear, lineStates, speakingTime } from '../js/core/textedit.js';
import { partCues, toSrt, chunkText, twoLines } from '../js/core/captions.js';
import { emptyEdit, addMark, setPieceStatus, piecesOf, deleteRange, keepRange, toPlanInput } from '../js/core/cuts.js';
import { buildPlan } from '../js/core/plan.js';
import { Timeline } from '../js/core/timeline.js';
import { parseCues } from '../js/plugins/transcript/vtt.js';
import { mapLines } from '../js/core/analysis.js';

const L = (g, text, extra = {}) => ({ g, text, speaker: '', ...extra });

test('line spans end at the next line, but not across a long break', () => {
  const spans = lineSpans([L(0, 'สวัสดีครับ'), L(5, 'วันนี้เรามาคุยเรื่องงบประมาณ'), L(700, 'กลับมาแล้วครับ')], 900);
  assert.equal(spans[0].end, 5);
  assert.ok(spans[1].end < 20, `before the break: ${spans[1].end}`);
  assert.ok(spans[2].end > 700 && spans[2].end < 720);
  // end times from the file win
  assert.equal(lineSpans([L(10, 'x', { gEnd: 12.5 }), L(20, 'y')], 100)[0].end, 12.5);
  assert.deepEqual(rangeOfLines(spans, 1, 0), { start: 0, end: spans[1].end, count: 2 });
  assert.ok(speakingTime('abc') > 1);
});

test('a cut lands on the quietest moment near the transcript time', () => {
  const peaks = new Uint8Array(1000).fill(200);
  peaks[503] = 5; // a pause at 5.03 s
  const layer = { rate: 100, peaks };
  assert.equal(quietestNear(layer, 5.2), 5.03);
  assert.equal(quietestNear(null, 5.2), 5.2);
  assert.equal(quietestNear(layer, 9.9, 0.6) <= 10, true);
});

test('deleteRange throws away every piece inside, keepRange brings them back', () => {
  let e = emptyEdit();
  e = addMark(e, 30, 100).edit; // an existing cut point inside the range
  const r = deleteRange(e, 20, 40, 100);
  const ps = piecesOf(r.edit, 100);
  assert.deepEqual(ps.map((p) => [p.start, p.end, p.status]), [[0, 20, 'keep'], [20, 30, 'delete'], [30, 40, 'delete'], [40, 100, 'keep']]);
  assert.equal(r.keys.length, 2);
  assert.deepEqual(toPlanInput(r.edit, 100).cuts.map((c) => [c.start, c.end]), [[20, 40]]);
  const back = keepRange(r.edit, 19, 41, 100);
  assert.ok(piecesOf(back, 100).every((p) => p.status === 'keep'));
  // from the very start: no cut point at 0
  const s = deleteRange(emptyEdit(), 0, 12, 100);
  assert.deepEqual(piecesOf(s.edit, 100).map((p) => [p.start, p.end, p.status]), [[0, 12, 'delete'], [12, 100, 'keep']]);
  assert.equal(deleteRange(emptyEdit(), 5, 5.05, 100).keys.length, 0);
});

test('line states follow the pieces', () => {
  let e = deleteRange(emptyEdit(), 10, 20, 100).edit;
  e = addMark(e, 50, 100).edit;
  const ps = piecesOf(e, 100).map((p) => (p.start === 50 ? { ...p, status: 'suggested' } : p));
  const spans = [{ start: 11, end: 15 }, { start: 18, end: 24 }, { start: 30, end: 35 }, { start: 60, end: 65 }];
  assert.deepEqual(lineStates(spans, ps), ['gone', 'partly', 'kept', 'suggested']);
});

test('captions move earlier by what was cut, and split per part', () => {
  const tl = new Timeline([{ id: 'a', name: 'a.mp4', duration: 100 }]);
  let e = deleteRange(emptyEdit(), 20, 40, 100).edit;
  const m = addMark(e, 70, 100);
  e = m.edit;
  const { cuts, splits } = toPlanInput({ ...e, marks: e.marks.map((x) => (x.id === m.id ? { ...x, split: true } : x)) }, 100);
  const plan = buildPlan(tl, cuts, splits, { snap: false });
  assert.equal(plan.parts.length, 2);
  const spans = lineSpans([L(5, 'ก่อนพัก'), L(25, 'ระหว่างพัก ไม่ควรเห็น'), L(45, 'หลังพัก', { speaker: 'สมชาย' }), L(80, 'ตอนสอง')], 100);
  const c1 = partCues(plan.parts[0], spans);
  assert.deepEqual(c1.map((c) => c.text), ['ก่อนพัก', 'สมชาย: หลังพัก']);
  assert.ok(Math.abs(c1[1].start - 25) < 0.01, `45 s minus the 20 s cut: ${c1[1].start}`);
  const c2 = partCues(plan.parts[1], spans, { speakers: false });
  assert.deepEqual(c2.map((c) => c.text), ['ตอนสอง']);
  assert.ok(Math.abs(c2[0].start - 10) < 0.01, `part two starts at 70: ${c2[0].start}`);
  const srt = toSrt(c1);
  assert.match(srt, /^1\r\n00:00:05,000 --> 00:00:0\d,\d{3}\r\nก่อนพัก\r\n/);
  assert.match(srt, /\r\n2\r\n00:00:25,000 --> /);
});

test('a line across a cut stays one cue; cues never overlap', () => {
  const tl = new Timeline([{ id: 'a', name: 'a.mp4', duration: 60 }]);
  const e = deleteRange(emptyEdit(), 10, 12, 60).edit;
  const plan = buildPlan(tl, toPlanInput(e, 60).cuts, [], { snap: false });
  const cues = partCues(plan.parts[0], lineSpans([L(8, 'ประโยคยาวที่ถูกตัดกลางคัน', { gEnd: 15 }), L(14, 'ต่อ')], 60));
  assert.equal(cues.length, 2);
  assert.ok(cues[0].end <= cues[1].start);
});

test('long Thai text splits at word boundaries', () => {
  const t = 'วันนี้เราจะมาคุยกันเรื่องแผนงานไตรมาสหน้าและงบประมาณที่ต้องใช้ในการจัดอบรมพนักงานใหม่ทั้งหมดสามรุ่น';
  const chunks = chunkText(t, 40);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(''), t);
  assert.ok(chunks.every((c) => [...c].length <= 40));
  assert.match(twoLines('สวัสดีครับวันนี้เราจะมาคุยกันเรื่องแผนงานไตรมาสหน้าและงบประมาณ', 30), /\n/);
});

test('VTT end times reach the timeline', () => {
  const lines = parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v สมชาย>สวัสดีครับ</v>\n\n00:00:04.000 --> 00:00:06.000\nต่อ');
  assert.equal(lines[0].tauEnd, 3.5);
  const mapped = mapLines({ lines }, [{ id: 'a', tau: 1, g: 11 }], 'linear');
  assert.equal(mapped[0].gEnd, 13.5);
});
