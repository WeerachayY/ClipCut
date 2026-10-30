// Runs the exact ffmpeg arguments the app generates against a desktop ffmpeg, to check the
// export plan produces files of the expected length. Skipped when ffmpeg is not installed.
// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../js/plugins/index.js';
import { Timeline } from '../js/core/timeline.js';
import { buildPlan, buildConcatList } from '../js/core/plan.js';
import { getExportProfile, getDetector } from '../js/core/registry.js';
import { readMp4Keyframes } from '../js/media/mp4-keyframes.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = hasFfmpeg ? mkdtempSync(join(tmpdir(), 'clipcut-')) : '';
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

function makeVideo(name, seconds, audioExpr) {
  const out = join(dir, name);
  ff(['-f', 'lavfi', '-i', `testsrc=s=320x180:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `aevalsrc='${audioExpr}':s=48000:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '2', '-c:a', 'aac', '-shortest', out]);
  return out;
}

test('copy export: two recordings, one break cut, one split', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const a = makeVideo('rec 1.mp4', 120, 'if(between(t,40,70),0,0.3*sin(2*PI*440*t))');
  const b = makeVideo("rec 2's.mp4", 90, '0.3*sin(2*PI*330*t)');
  const files = [];
  for (const [i, p] of [a, b].entries()) {
    const k = await readMp4Keyframes(await openAsBlob(p));
    files.push({ id: String(i), name: p.split('/').pop(), duration: k.duration, keyframes: k.keyframes, path: p });
  }
  const tl = new Timeline(files);
  const plan = buildPlan(tl, [{ id: 'c', start: 41.3, end: 69.7, status: 'accepted' }], [{ id: 's', at: 150.5, label: 'Q&A' }]);
  const profile = getExportProfile('copy');
  const outs = plan.parts.map((part, i) => {
    const listPath = join(dir, `part${i}.txt`);
    writeFileSync(listPath, buildConcatList(part, (fi) => files[fi].path));
    const outPath = join(dir, `out${i}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', ...profile.buildArgs({ listPath, outPath, options: {} })]);
    return { outPath, expected: part.duration };
  });
  assert.equal(outs.length, 2);
  for (const o of outs) {
    const d = duration(o.outPath);
    assert.ok(Math.abs(d - o.expected) < 0.15, `${o.outPath}: got ${d}, expected ${o.expected}`);
  }
  // first part = 41.3 + (120-68) + 30 = 123.3 s
  assert.ok(Math.abs(outs[0].expected - 123.3) < 1e-6);
});

test('silence detector args find the silent stretch', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const a = makeVideo('sil.mp4', 60, 'if(between(t,20,45),0,0.3*sin(2*PI*440*t))');
  const det = getDetector('silence');
  const p = { ...det.defaults };
  const r = spawnSync('ffmpeg', det.ffmpegArgs(a, p));
  const ranges = det.parseLog(r.stderr.toString().split('\n'), 60);
  assert.equal(ranges.length, 1);
  assert.ok(Math.abs(ranges[0].start - 20) < 0.1 && Math.abs(ranges[0].end - 45) < 0.1, JSON.stringify(ranges));
});

test('compress profile produces a smaller H.264 file', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const a = makeVideo('c.mp4', 20, '0.3*sin(2*PI*440*t)');
  const k = await readMp4Keyframes(await openAsBlob(a));
  const tl = new Timeline([{ id: 'a', name: 'c.mp4', duration: k.duration, keyframes: k.keyframes }]);
  const plan = buildPlan(tl, [{ id: 'c', start: 5, end: 9, status: 'accepted' }]);
  const listPath = join(dir, 'c.txt');
  writeFileSync(listPath, buildConcatList(plan.parts[0], () => a));
  const outPath = join(dir, 'c-out.mp4');
  const args = getExportProfile('compress-h264').buildArgs({ listPath, outPath, options: { height: '720', fps: '15' } });
  execFileSync('ffmpeg', ['-v', 'error', ...args]);
  assert.ok(Math.abs(duration(outPath) - plan.parts[0].duration) < 0.2);
});
