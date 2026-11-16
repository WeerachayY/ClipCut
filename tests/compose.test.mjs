// Speed curves, the program clock, composition editing, and the audio mix graph (run through desktop ffmpeg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speedMap, normalizeSpeed, speedChunks, speedAt, curvePoints, speedLabel, isNormal } from '../js/core/speed.js';
import { buildProgram, locate, toProgram, clipsInWindow } from '../js/core/program.js';
import { emptyCompose, addClip, moveClip, trimClip, splitClip, removeClip, updateClip, setSpeed, textClipFromPreset, drawOrder, hasVisual, hasAudioMix, hasSpeed, isEmpty, summary, prunePieces, activeAt } from '../js/core/compose.js';
import { partAudioArgs, tempoFilters, audioOut } from '../js/core/audiograph.js';
import { buildPlan, buildClipPlan } from '../js/core/plan.js';
import { Timeline } from '../js/core/timeline.js';
import { emptyEdit, addMark, setPieceStatus, piecesOf, toPlanInput } from '../js/core/cuts.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('speed: constant and curves, both directions', () => {
  const c = speedMap({ mode: 'constant', rate: 2 }, 10);
  assert.equal(c.outDur, 5);
  assert.equal(c.toSrc(2.5), 5);
  assert.equal(normalizeSpeed({ mode: 'constant', rate: 1 }).mode, 'normal');
  assert.equal(normalizeSpeed({ mode: 'constant', rate: 50 }).rate, 10);
  // a flat curve at 2× is the same as constant 2×
  const flat = speedMap({ mode: 'curve', points: [{ x: 0, y: 2 }, { x: 1, y: 2 }] }, 10);
  assert.ok(near(flat.outDur, 5));
  // ramp 1× → 3×: output length = L * ln(3)/2 for a linear ramp in source position
  const ramp = speedMap({ mode: 'curve', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] }, 10);
  assert.ok(near(ramp.outDur, (10 * Math.log(3)) / 2, 1e-3), String(ramp.outDur));
  for (const s of [0, 1.7, 4.2, 9.99]) assert.ok(near(ramp.toSrc(ramp.toOut(s)), s, 1e-3));
  assert.ok(near(speedAt({ mode: 'curve', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] }, 0.5), 2));
  const hero = speedMap({ mode: 'curve', curve: 'hero' }, 20);
  assert.ok(hero.outDur > 0 && hero.speed(10) < 1, 'hero slows down in the middle');
  assert.equal(curvePoints('flash-in')[0].y, 6);
  assert.equal(speedLabel({ mode: 'constant', rate: 1.5 }), '1.5×');
  assert.equal(speedLabel({ mode: 'curve', curve: 'hero' }), 'โค้ง: ฮีโร่');
  assert.ok(isNormal(null) && !isNormal({ mode: 'curve', curve: 'bullet' }));
});

test('speed chunks add up to the curve exactly', () => {
  const m = speedMap({ mode: 'curve', curve: 'montage' }, 12);
  const ch = speedChunks(m, 0, 12);
  assert.ok(ch.length >= 20);
  const total = ch.reduce((a, c) => a + (c.to - c.from) / c.rate, 0);
  assert.ok(near(total, m.outDur, 1e-6));
  assert.deepEqual(speedChunks(speedMap({ mode: 'constant', rate: 2 }, 10), 2, 6), [{ from: 2, to: 6, rate: 2 }]);
  assert.deepEqual(tempoFilters(1, false), []);
  assert.deepEqual(tempoFilters(0.2, false), ['atempo=0.5', 'atempo=0.5', 'atempo=0.800000']);
  assert.deepEqual(tempoFilters(2, true), ['asetrate=96000.000', 'aresample=48000']);
});

function setup() {
  // one 100 s recording, cut points at 20 / 40 / 70; piece 20–40 thrown away, piece 40–70 at 2×
  const tl = new Timeline([{ id: 'a', name: 'a.mp4', duration: 100 }]);
  let e = emptyEdit();
  const ids = [];
  for (const t of [20, 40, 70]) { const r = addMark(e, t, 100); e = r.edit; ids.push(r.id); }
  e = setPieceStatus(e, ids[0], 'delete');
  const pieces = piecesOf(e, 100);
  const { cuts, splits } = toPlanInput(e, 100);
  const plan = buildPlan(tl, cuts, splits, { snap: false });
  return { tl, e, ids, pieces, plan };
}

test('program clock: cuts and speed', () => {
  const { pieces, plan, ids } = setup();
  const prog = buildProgram(plan, { pieces, speed: { [ids[1]]: { mode: 'constant', rate: 2 } } });
  // 0–20 (20 s) + 40–70 at 2× (15 s) + 70–100 (30 s)
  assert.ok(near(prog.duration, 65));
  assert.equal(prog.speedChanged, true);
  assert.deepEqual(prog.parts[0].segments.map((s) => [s.srcStart, s.srcEnd, +s.duration.toFixed(3)]), [[0, 20, 20], [40, 70, 15], [70, 100, 30]]);
  const l = locate(prog, 27.5); // 7.5 s into the fast piece = 15 s of source
  assert.ok(near(l.src, 55) && near(l.local, 55) && near(l.speed, 2));
  assert.ok(near(locate(prog, 40).src, 75));
  assert.ok(near(toProgram(prog, 55), 27.5));
  assert.equal(toProgram(prog, 30), null, 'cut away');
  const none = buildProgram(plan, { pieces });
  assert.ok(near(none.duration, 80) && none.speedChanged === false);
});

test('program clock: arranged clips in a new order, as parts', () => {
  const { tl, pieces } = setup();
  const plan = buildClipPlan(tl, [{ start: 70, end: 100, name: 'ท้าย' }, { start: 0, end: 20, name: 'หัว' }], { snap: false });
  const prog = buildProgram(plan, { pieces });
  assert.deepEqual(prog.parts.map((p) => [p.start, p.duration, p.label]), [[0, 30, 'ท้าย'], [30, 20, 'หัว']]);
  assert.ok(near(locate(prog, 35).src, 5));
  const w = clipsInWindow([{ id: 'x', start: 25, duration: 10, offset: 1 }], 30, 50);
  assert.deepEqual(w.map((c) => [c.start, c.duration, c.offset, c.cutHead]), [[0, 5, 6, 5]]);
});

test('composition: placing, moving, trimming, splitting clips', () => {
  let c = emptyCompose();
  let r = addClip(c, textClipFromPreset('hook-big', 0));
  c = r.compose;
  const hook = r.id;
  assert.equal(c.tracks.length, 1);
  assert.equal(c.clips[0].duration, 3);
  // a second text at the same time gets a new track, on top
  r = addClip(c, textClipFromPreset('plain', 1));
  c = r.compose;
  assert.equal(c.tracks.length, 2);
  assert.equal(c.clips.find((k) => k.id === r.id).track, c.tracks[0].id);
  // later text reuses the track nearest the main track
  r = addClip(c, textClipFromPreset('plain', 10));
  c = r.compose;
  assert.equal(c.clips.find((k) => k.id === r.id).track, c.clips.find((k) => k.id === hook).track);
  // drawing: bottom track first
  assert.equal(drawOrder(c, c.clips.filter((k) => k.start < 3))[0].id, hook);
  // moving into a neighbour stops at its edge
  const later = r.id;
  c = moveClip(c, later, 1);
  assert.equal(c.clips.find((k) => k.id === later).start, 3);
  // music below the main track; trimming respects the media length
  r = addClip(c, { kind: 'audio', asset: 'm', start: 0, duration: 30, offset: 0, volume: 0.5, duck: 'medium' });
  c = r.compose;
  const music = r.id;
  c = trimClip(c, music, 'end', 100, 45);
  assert.equal(c.clips.find((k) => k.id === music).duration, 45);
  c = trimClip(c, music, 'start', 5, 45);
  assert.deepEqual((({ start, duration, offset }) => ({ start, duration, offset }))(c.clips.find((k) => k.id === music)), { start: 5, duration: 40, offset: 5 });
  const s = splitClip(c, music, 20);
  c = s.compose;
  const right = c.clips.find((k) => k.id === s.id);
  assert.deepEqual([right.start, right.duration, right.offset], [20, 25, 20]);
  c = updateClip(c, hook, { text: 'ใหม่', style: { color: '#ff0000' } });
  const h = c.clips.find((k) => k.id === hook);
  assert.equal(h.style.color, '#ff0000');
  assert.equal(h.style.font, 'Kanit');
  assert.deepEqual(activeAt(c, 2).map((k) => k.kind).sort(), ['text', 'text']);
  c = setSpeed(c, 'p1', { mode: 'curve', curve: 'hero' });
  assert.deepEqual(summary(c), { text: 3, image: 0, video: 0, audio: 2, speed: 1 });
  assert.ok(hasVisual(c) && hasAudioMix(c) && hasSpeed(c) && !isEmpty(c));
  assert.deepEqual(prunePieces(c, ['p2']).speed, {});
  c = removeClip(removeClip(c, music), s.id);
  assert.equal(c.tracks.filter((t) => t.lane === 'audio').length, 0, 'empty track removed');
  assert.ok(isEmpty(emptyCompose()));
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('audio mix graph runs in ffmpeg: speed curve, ducked music, fades', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'clipcut-mix-'));
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  const voice = join(dir, 'voice.wav');
  const music = join(dir, 'music.mp3');
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*300*t)*lt(mod(t,10),6)':s=48000:d=100", voice]);
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*600*t)':s=44100:d=60", music]);
  const { pieces, plan, ids } = setup();
  const prog = buildProgram(plan, { pieces, speed: { [ids[1]]: { mode: 'curve', curve: 'hero' }, [ids[2]]: { mode: 'constant', rate: 0.5, pitch: true } } });
  const part = prog.parts[0];
  const clips = clipsInWindow([{ id: 'm', kind: 'audio', asset: 'music', start: 2, duration: 50, offset: 3, volume: 0.6, fadeIn: 1, fadeOut: 2, duck: 'medium' }], part.start, part.start + part.duration);
  const out = join(dir, 'mix.m4a');
  const args = partAudioArgs({ part, mainPaths: [voice], mainHasAudio: [true], clips, assetPaths: { music }, assetHasAudio: { music: true }, outArgs: audioOut('m4a', out) });
  ff(args.slice(1));
  assert.ok(Math.abs(dur(out) - prog.duration) < 0.06, `${dur(out)} vs ${prog.duration}`);
  // a file without sound still gets a track of the right length
  const silent = join(dir, 'silent.mp3');
  const args2 = partAudioArgs({ part, mainPaths: [voice], mainHasAudio: [false], outArgs: audioOut('mp3', silent) });
  ff(args2.slice(1));
  assert.ok(Math.abs(dur(silent) - prog.duration) < 0.1);
});

test('captions follow speed changes', async () => {
  const { partCues } = await import('../js/core/captions.js');
  const { pieces, plan, ids } = setup();
  const prog = buildProgram(plan, { pieces, speed: { [ids[1]]: { mode: 'constant', rate: 2 } } });
  const cues = partCues(prog.parts[0], [{ start: 50, end: 54, text: 'เร็ว' }, { start: 80, end: 82, text: 'หลัง' }]);
  // 50 s of source = 20 + (50-40)/2 = 25 s; 80 s = 20 + 15 + 10 = 45 s
  assert.deepEqual(cues.map((c) => [c.text, +c.start.toFixed(3)]), [['เร็ว', 25], ['หลัง', 45]]);
  assert.ok(near(cues[0].end - cues[0].start, 2, 0.01) || cues[0].end - cues[0].start < 2.01);
});

test('ducking: music drops under speech and comes back in the pauses; mono speech keeps its level', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'clipcut-duck-'));
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  const voice = join(dir, 'voice.wav');
  const music = join(dir, 'music.wav');
  // mono speech-like tone 0–5 s of every 10 s, music all along
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)*lt(mod(t,10),5)':s=48000:d=30", '-ac', '1', voice]);
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*800*t)|0.3*sin(2*PI*800*t)':s=48000:d=30", music]);
  const tl = new Timeline([{ id: 'a', name: 'voice.wav', duration: 30, kind: 'audio' }]);
  const plan = buildPlan(tl, [], [], { snap: false });
  const prog = buildProgram(plan, { pieces: piecesOf(emptyEdit(), 30) });
  const level = (file, from, to, hz) => {
    // RMS of one frequency band over a stretch
    const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(from), '-to', String(to), '-i', file, '-af', `bandpass=f=${hz}:width_type=q:w=8,astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-']).toString();
    const vals = [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => Number(m[1]));
    return vals[vals.length - 1];
  };
  const run = (duck) => {
    const out = join(dir, `mix-${duck}.wav`);
    const clips = [{ id: 'm', kind: 'audio', asset: 'music', start: 0, duration: 30, offset: 0, volume: 1, duck }];
    ff(partAudioArgs({ part: prog.parts[0], mainPaths: [voice], mainHasAudio: [true], mainChannels: [1], clips, assetPaths: { music }, assetHasAudio: { music: true }, assetChannels: { music: 2 }, outArgs: audioOut('wav', out) }).slice(1));
    return out;
  };
  const off = run('off');
  const on = run('medium');
  const musicSpeech = level(on, 1, 4, 800);
  const musicPause = level(on, 6, 9, 800);
  assert.ok(musicPause - musicSpeech > 8, `music should drop under speech: speech ${musicSpeech} dB, pause ${musicPause} dB`);
  assert.ok(Math.abs(level(off, 1, 4, 800) - level(off, 6, 9, 800)) < 1, 'no ducking when off');
  // speech level equals the mono source (not 3 dB down)
  assert.ok(Math.abs(level(off, 1, 4, 300) - level(voice, 1, 4, 300)) < 1, `${level(off, 1, 4, 300)} vs ${level(voice, 1, 4, 300)}`);
});
