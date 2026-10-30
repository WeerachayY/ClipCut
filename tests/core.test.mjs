// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '../js/plugins/index.js';
import { parseTimecode, formatTime, formatDuration } from '../js/core/time.js';
import { Timeline } from '../js/core/timeline.js';
import { createTimeMap, findConflicts } from '../js/core/timemap.js';
import { buildPlan, buildConcatList, effectiveCut } from '../js/core/plan.js';
import { combineCandidates } from '../js/core/suggest.js';
import { suggestCuts, proposeAnchors } from '../js/core/analysis.js';
import { findTranscriptParser } from '../js/core/registry.js';
import { dedupeLines } from '../js/plugins/transcript/common.js';
import { parseSilenceLog } from '../js/plugins/detectors/silence.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const kf = (dur, step = 2) => Array.from({ length: Math.ceil(dur / step) }, (_, i) => i * step);
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('timecodes', () => {
  assert.equal(parseTimecode('00:01:34'), 94);
  assert.equal(parseTimecode('1:05:10.5'), 3910.5);
  assert.equal(parseTimecode('05:10'), 310);
  assert.equal(parseTimecode('00:00:03,250'), 3.25);
  assert.ok(Number.isNaN(parseTimecode('abc')));
  assert.equal(formatTime(3910), '1:05:10');
  assert.equal(formatTime(70, { short: true }), '01:10');
  assert.equal(formatDuration(690), '11 นาที 30 วิ');
});

test('timeline locate, snap, split', () => {
  const tl = new Timeline([
    { id: 'a', name: 'a.mp4', duration: 120, keyframes: kf(120) },
    { id: 'b', name: 'b.mp4', duration: 90, keyframes: kf(90) },
  ]);
  assert.equal(tl.duration, 210);
  assert.deepEqual(tl.seams, [120]);
  assert.equal(tl.locate(120).index, 1);
  assert.equal(tl.locate(119.9).index, 0);
  assert.equal(tl.snapDown(69.7), 68);
  assert.equal(tl.snapDown(150.5), 150);
  assert.equal(tl.snapDown(122), 122);
  const pieces = tl.splitRange(100, 130);
  assert.equal(pieces.length, 2);
  approx(pieces[1].outpoint, 10);
});

test('time map: offset, linear drift, step jump', () => {
  assert.equal(createTimeMap([]).toTimeline(50), 50);
  const one = createTimeMap([{ id: 1, tau: 100, g: 103 }]);
  assert.equal(one.toTimeline(10), 13);
  assert.equal(one.toTranscript(13), 10);
  const lin = createTimeMap([{ id: 1, tau: 100, g: 103 }, { id: 2, tau: 1100, g: 1108 }]);
  approx(lin.toTimeline(600), 605.5);
  approx(lin.toTranscript(605.5), 600);
  assert.equal(lin.toTimeline(2000), 2008);
  const step = createTimeMap([{ id: 1, tau: 100, g: 103 }, { id: 2, tau: 1100, g: 1108 }], 'step');
  assert.equal(step.toTimeline(600), 603);
  assert.equal(findConflicts([{ id: 1, tau: 10, g: 50 }, { id: 2, tau: 20, g: 40 }]).size, 2);
});

test('plan: cut snapped to keyframe, split across files, concat list', () => {
  const tl = new Timeline([
    { id: 'a', name: "it's a.mp4", duration: 120, keyframes: kf(120) },
    { id: 'b', name: 'b.mp4', duration: 90, keyframes: kf(90) },
  ]);
  const cuts = [
    { id: 'c1', start: 41.3, end: 69.7, status: 'accepted' },
    { id: 'c2', start: 10, end: 20, status: 'suggested' },
    { id: 'c3', start: 100, end: 100.5, status: 'accepted' },
  ];
  const e = effectiveCut(tl, cuts[0]);
  assert.equal(e.effectiveEnd, 68);
  const plan = buildPlan(tl, cuts, [{ id: 's', at: 150.5, label: 'Q&A' }]);
  assert.equal(plan.warnings.filter((w) => w.type === 'ineffective-cut').length, 1);
  assert.equal(plan.parts.length, 2);
  const [p1, p2] = plan.parts;
  assert.equal(p1.segments.length, 3);
  assert.deepEqual(p1.segments.map((s) => [s.fileIndex, +s.inpoint.toFixed(3), s.outpoint == null ? null : +s.outpoint.toFixed(3)]), [[0, 0, 41.3], [0, 68, null], [1, 0, 30]]);
  assert.equal(p2.label, 'Q&A');
  assert.deepEqual(p2.segments.map((s) => [s.fileIndex, s.inpoint, s.outpoint]), [[1, 30, null]]);
  approx(plan.keptDuration + plan.removedDuration, 210, 1e-6);
  approx(plan.removedDuration, 41.3 - 41.3 + (68 - 41.3));
  const list = buildConcatList(p1, (i) => `/in/${i}/${tl.files[i].name}`);
  assert.equal(list, "ffconcat version 1.0\nfile '/in/0/it'\\''s a.mp4'\noutpoint 41.300\nfile '/in/0/it'\\''s a.mp4'\ninpoint 68.000\nfile '/in/1/b.mp4'\noutpoint 30.000\n");
});

test('plan without keyframes keeps exact times', () => {
  const tl = new Timeline([{ id: 'a', name: 'a.mp4', duration: 100, keyframes: null }]);
  const plan = buildPlan(tl, [{ id: 'c', start: 10, end: 20.25, status: 'accepted' }]);
  assert.equal(plan.snapped, false);
  assert.equal(plan.parts[0].segments[1].inpoint, 20.25);
});

test('SA+RA docx transcript parses and dedupes', async () => {
  const blob = await openAsBlob(fixture('sara-sample.docx'));
  const parser = findTranscriptParser('sara-sample.docx');
  assert.equal(parser.id, 'sara-docx');
  const { lines } = await parser.parse(blob);
  assert.equal(lines.length, 9);
  assert.equal(lines[0].speaker, 'วิทยากร');
  assert.equal(lines[8].text.includes('& อ้างอิง <ไฟล์>'), true);
  const d = dedupeLines(lines);
  assert.equal(d.removed, 1);
  assert.equal(d.lines.length, 8);
});

test('vtt and text parsers', async () => {
  const vtt = findTranscriptParser('x.vtt');
  const { lines } = await vtt.parse(await openAsBlob(fixture('sample.vtt')));
  assert.deepEqual(lines.map((l) => [l.tau, l.speaker]), [[3.12, 'วิทยากร'], [310, 'สมชาย']]);
  const txt = findTranscriptParser('x.txt', '[00:00:01] A: hi\n[00:00:05] B: yo\n[00:01:00] A: ok');
  assert.equal(txt.id, 'bracket-text');
});

test('silencedetect log parsing', () => {
  const r = parseSilenceLog([
    '[silencedetect @ 0x1] silence_start: 40.0213',
    '[silencedetect @ 0x1] silence_end: 70.0107 | silence_duration: 29.9893',
    '[silencedetect @ 0x1] silence_start: 110',
  ], 120);
  assert.deepEqual(r, [{ start: 40.0213, end: 70.0107 }, { start: 110, end: 120 }]);
});

test('suggestions: transcript gap + keywords + silence = high confidence, edges from audio', async () => {
  const { lines } = await findTranscriptParser('a.docx').parse(await openAsBlob(fixture('sara-sample.docx')));
  const transcript = { lines: dedupeLines(lines).lines };
  const tl = new Timeline([{ id: 'a', name: 'a.mp4', duration: 900, keyframes: kf(900) }]);
  // break announced at 1:56, back at 12:40. Audio is silent 2:03 -> 12:39.4
  const analysis = { silence: [{ start: 123, end: 759.4 }, { start: 300, end: 310 }] };
  const { suggestions } = suggestCuts({ timeline: tl, transcript, analysis });
  const brk = suggestions.find((s) => s.start > 100 && s.end < 800);
  assert.ok(brk, 'break found');
  assert.equal(brk.confidence, 'high');
  assert.equal(brk.start, 123);
  assert.equal(brk.end, 759.4);
  assert.ok(brk.reasons.some((r) => r.includes('พักเบรก')));
  // the tail after the last line (13:05 -> 15:00) is transcript-only
  const tail = suggestions.find((s) => s.end === 900);
  assert.equal(tail.confidence, 'check');
});

test('suggestions without transcript use long silences only', () => {
  const tl = new Timeline([{ id: 'a', name: 'a.mp4', duration: 600 }]);
  const { suggestions } = suggestCuts({ timeline: tl, transcript: null, analysis: { silence: [{ start: 100, end: 400 }, { start: 450, end: 470 }] } });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].confidence, 'check');
});

test('combine keeps edges inside transcript bounds', () => {
  const out = combineCandidates([
    { role: 'primary', source: 'gap', start: 50, end: 200, minStart: 45, maxEnd: 201, label: 'gap' },
    { role: 'refiner', source: 'silence', start: 30, end: 210, label: 'sil' },
  ], { duration: 1000 });
  assert.equal(out[0].start, 45);
  assert.equal(out[0].end, 201);
});

test('proposed anchors line up speech after silence', () => {
  const transcript = { lines: [{ tau: 10, text: 'a', idx: 0 }, { tau: 400, text: 'b', idx: 1 }] };
  const prop = proposeAnchors({ transcript, silence: [{ start: 0, end: 13 }, { start: 30, end: 404.5 }] });
  assert.equal(prop.length, 1); // first line quiet-before 10s < 60s
  assert.equal(prop[0].tau, 400);
  assert.equal(prop[0].g, 404.5);
});

test('folder classification picks videos in order and the SA+RA transcript', async () => {
  const { classifyFiles } = await import('../js/io/folder.js');
  const f = (name, t = 0) => new File(['x'], name, { lastModified: t });
  const c = classifyFiles([f('Recording 10.mp4'), f('Recording 2.mp4'), f('notes.txt', 5), f('Meeting transcript.docx', 1), f('~$temp.docx'), f('clipcut.project.json'), f('cover.png')]);
  assert.deepEqual(c.videos.map((x) => x.name), ['Recording 2.mp4', 'Recording 10.mp4']);
  assert.equal(c.transcripts[0].name, 'Meeting transcript.docx');
  assert.equal(c.project.name, 'clipcut.project.json');
  assert.deepEqual(c.ignored.map((x) => x.name), ['~$temp.docx', 'cover.png']);
});

test('saved project restores only onto the same recordings', async () => {
  const { serializeProject, restoreProject, initialState } = await import('../js/core/store.js');
  const videos = [{ id: 'v1', name: 'b.mp4', size: 2, duration: 90 }, { id: 'v2', name: 'a.mp4', size: 1, duration: 120 }];
  const s = { ...initialState(), videos: [videos[1], videos[0]], cuts: [{ id: 'c', start: 1, end: 9, status: 'accepted' }] };
  const saved = JSON.parse(JSON.stringify(serializeProject(s)));
  const r = restoreProject(saved, videos);
  assert.deepEqual(r.videos.map((v) => v.name), ['a.mp4', 'b.mp4']);
  assert.equal(r.cuts.length, 1);
  assert.equal(restoreProject(saved, [{ name: 'a.mp4', size: 999 }, videos[0]]), null);
});

test('re-suggesting keeps the user\'s decisions', async () => {
  const { mergeSuggestions } = await import('../js/core/cuts.js');
  const existing = [
    { id: 'a', start: 10, end: 20, status: 'accepted', origin: 'auto' },
    { id: 'b', start: 30, end: 40, status: 'suggested', origin: 'auto', edited: false },
    { id: 'm', start: 50, end: 55, status: 'accepted', origin: 'manual' },
  ];
  const merged = mergeSuggestions(existing, [{ start: 12, end: 22, confidence: 'high', reasons: [] }, { start: 31, end: 45, confidence: 'check', reasons: [] }]);
  assert.deepEqual(merged.map((c) => [c.start, c.end, c.status]), [[10, 20, 'accepted'], [31, 45, 'suggested'], [50, 55, 'accepted']]);
});
