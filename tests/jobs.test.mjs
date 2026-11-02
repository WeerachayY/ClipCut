// Job helpers: naming, card numbers, status, file matching, dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoJobName, cleanJobName, duplicateName, jobSummary, jobStatus, matchFiles, relativeTime, searchJobs, sortJobs, isProjectFileName } from '../js/core/jobs.js';
import { emptyEdit, addMark, setPieceStatus, setSplit, START } from '../js/core/cuts.js';
import { classifyFiles } from '../js/io/folder.js';
import { serializeProject, initialState } from '../js/core/store.js';

test('job names: folder name, first file, several files, cleanup', () => {
  assert.equal(autoJobName({ kind: 'folder', name: 'อบรม รุ่น 3' }, ['a.mp4']), 'อบรม รุ่น 3');
  assert.equal(autoJobName({ kind: 'files' }, ['Meeting 1.mp4']), 'Meeting 1');
  assert.equal(autoJobName({ kind: 'files' }, ['part1.mp4', 'part2.mp4', 'part3.mp4']), 'part1 และอีก 2 ไฟล์');
  assert.equal(autoJobName({ kind: 'files' }, []), 'งานใหม่');
  assert.equal(cleanJobName('   ประชุม   ทีม  ', 'เดิม'), 'ประชุม ทีม');
  assert.equal(cleanJobName('   ', 'เดิม'), 'เดิม');
  assert.equal(cleanJobName('x'.repeat(200), 'เดิม').length, 120);
  assert.equal(duplicateName('งาน A'), 'งาน A (สำเนา)');
});

test('job summary counts what is thrown away and the parts', () => {
  const videos = [{ duration: 60 }, { duration: 40 }];
  assert.deepEqual(jobSummary({ videos, edit: emptyEdit() }), { files: 2, duration: 100, cut: 0, kept: 100, marks: 0, parts: 1 });
  let e = emptyEdit();
  let r = addMark(e, 10, 100); e = r.edit; const m1 = r.id;
  r = addMark(e, 25, 100); e = r.edit;
  r = addMark(e, 70, 100); e = r.edit; const m3 = r.id;
  e = setPieceStatus(e, m1, 'delete');      // 10–25
  e = setPieceStatus(e, START, 'delete');   // 0–10
  e = setSplit(e, m3, true, 'ตอนที่ 2');
  const s = jobSummary({ videos, edit: e });
  assert.equal(s.cut, 25);
  assert.equal(s.kept, 75);
  assert.equal(s.marks, 3);
  assert.equal(s.parts, 2);
  assert.equal(jobSummary({ videos: [], edit: e }).duration, 0);
});

test('job status badge', () => {
  assert.equal(jobStatus({ summary: { marks: 0 } }).id, 'new');
  assert.equal(jobStatus({ summary: { marks: 2 } }).id, 'editing');
  assert.equal(jobStatus({ summary: { marks: 2 }, editedAt: 100, exportedAt: 200 }).id, 'exported');
  assert.equal(jobStatus({ summary: { marks: 2 }, editedAt: 300, exportedAt: 200 }).id, 'changed');
  assert.equal(jobStatus({ missing: true, exportedAt: 200 }).id, 'missing');
});

test('matching saved videos to picked files by name and size', () => {
  const saved = [{ name: 'b.mp4', size: 2 }, { name: 'a.mp4', size: 1 }];
  const files = [{ name: 'a.mp4', size: 1 }, { name: 'b.mp4', size: 2 }, { name: 'notes.docx', size: 5 }];
  const r = matchFiles(saved, files);
  assert.deepEqual(r.matched.map((f) => f.name), ['b.mp4', 'a.mp4']);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(matchFiles(saved, [{ name: 'a.mp4', size: 1 }, { name: 'b.mp4', size: 3 }]).missing, ['b.mp4']);
  // two identical names: each saved entry takes its own file
  assert.equal(matchFiles([{ name: 'x.mp4', size: 1 }, { name: 'x.mp4', size: 1 }], [{ name: 'x.mp4', size: 1 }]).missing.length, 1);
});

test('relative times in Thai', () => {
  const now = new Date(2026, 10, 2, 10, 0).getTime();
  assert.equal(relativeTime(now - 20_000, now), 'เมื่อสักครู่');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 นาทีที่แล้ว');
  assert.match(relativeTime(new Date(2026, 10, 2, 7, 5).getTime(), now), /^วันนี้ 07:05/);
  assert.match(relativeTime(new Date(2026, 10, 1, 16, 20).getTime(), now), /^เมื่อวาน 16:20/);
  assert.match(relativeTime(new Date(2026, 9, 25, 9, 0).getTime(), now), /25/);
  assert.match(relativeTime(new Date(2025, 9, 25, 9, 0).getTime(), now), /25.*25(68|25)/);
  assert.equal(relativeTime(0, now), '');
});

test('search and sort jobs', () => {
  const jobs = [
    { id: 1, name: 'ประชุมทีม', openedAt: 10, videos: [{ name: 'rec.mp4' }] },
    { id: 2, name: 'Workshop UX', openedAt: 30, source: { name: 'Design' } },
    { id: 3, name: 'อบรม', editedAt: 20 },
  ];
  assert.deepEqual(sortJobs(jobs).map((j) => j.id), [2, 3, 1]);
  assert.deepEqual(searchJobs(jobs, 'ux').map((j) => j.id), [2]);
  assert.deepEqual(searchJobs(jobs, 'design').map((j) => j.id), [2]);
  assert.deepEqual(searchJobs(jobs, 'REC.').map((j) => j.id), [1]);
  assert.equal(searchJobs(jobs, '  ').length, 3);
});

test('project files are recognised, including downloaded job files', () => {
  assert.ok(isProjectFileName('clipcut.project.json'));
  assert.ok(isProjectFileName('ประชุมทีม.clipcut.json'));
  assert.ok(isProjectFileName('ประชุมทีม.clipcut (1).json'));
  assert.ok(!isProjectFileName('data.json'));
  const c = classifyFiles([{ name: 'a.mp4' }, { name: 'งาน.clipcut.json' }, { name: 'clipcut.project.json' }]);
  assert.equal(c.project.name, 'clipcut.project.json');
  assert.equal(c.videos.length, 1);
});

test('project file carries the job id and name', () => {
  const s = { ...initialState(), jobId: 'j_1', jobName: 'ประชุม', videos: [{ name: 'a.mp4', size: 1, duration: 10 }] };
  const p = serializeProject(s);
  assert.equal(p.jobId, 'j_1');
  assert.equal(p.jobName, 'ประชุม');
  assert.equal(initialState().step, 'home');
});
