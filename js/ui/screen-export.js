import { h, clear, icon, toast } from './dom.js';
import { exportProfiles, getExportProfile } from '../core/registry.js';
import { buildPlan, estimatePartBytes } from '../core/plan.js';
import { formatTime, formatBytes, formatDuration } from '../core/time.js';
import { runExport, partFileName, safeName, MAX_OUTPUT_BYTES } from '../media/export.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { ensureWritable, outputDir, writeFileTo } from '../io/folder.js';

function defaultBase(videos) {
  const n = videos[0]?.name || 'meeting';
  return `${n.replace(/\.[^.]+$/, '')}_ตัดแล้ว`;
}

/** A plain-text record of what was cut, handy as chapter notes. */
function cutReport(plan, timeline, names) {
  const L = [];
  L.push(`ClipCut — สรุปการตัด (${new Date().toLocaleString('th-TH')})`);
  L.push(`ต้นฉบับ: ${timeline.files.map((f) => f.name).join(' + ')} (${formatTime(timeline.duration)})`);
  L.push(`ตัดออก: ${formatTime(plan.removedDuration)} · เหลือ: ${formatTime(plan.keptDuration)}`);
  L.push('');
  L.push('ช่วงที่ตัดออก (เวลาในต้นฉบับ):');
  plan.removed.forEach((r, i) => L.push(`  ${i + 1}. ${formatTime(r.start)} – ${formatTime(r.end)} (${formatDuration(r.end - r.start)})`));
  L.push('');
  L.push('ไฟล์ผลลัพธ์:');
  plan.parts.forEach((p, i) => L.push(`  ${names[i]}  ความยาว ${formatTime(p.duration)}  มาจาก ${formatTime(p.from)} – ${formatTime(p.to)}`));
  return L.join('\r\n');
}

export function mount(root, app) {
  const store = app.store;
  const body = h('div.export');
  root.append(body);
  let running = false;
  let results = null;
  let progress = null;
  let error = null;
  let blobUrls = [];

  function optionsForm(profile) {
    const st = store.get();
    const o = st.exportProfile === profile.id ? st.exportOptions : {};
    return (profile.options || []).map((opt) => h('label.field',
      h('span', opt.label),
      h('select', { disabled: running, onchange: (e) => store.set({ exportOptions: { ...store.get().exportOptions, [opt.key]: e.target.value } }) },
        opt.choices.map((c) => h('option', { value: c.value, selected: (o[opt.key] ?? opt.default) === c.value }, c.label)))));
  }

  async function start() {
    const st = store.get();
    const tl = app.timeline();
    const profile = getExportProfile(st.exportProfile) || exportProfiles()[0];
    const plan = buildPlan(tl, st.cuts, st.splits, { snap: profile.snapToKeyframes !== false });
    const base = st.outputBase || defaultBase(st.videos);
    let writeOutput;
    let where;
    if (st.source?.kind === 'folder' && await ensureWritable(st.source.dir).catch(() => false)) {
      const out = await outputDir(st.source.dir);
      writeOutput = (name, data) => writeFileTo(out, name, data);
      where = `โฟลเดอร์ ${st.source.name}/output`;
    } else {
      // No folder: keep results in memory and let the user click to save each one
      // (browsers block several automatic downloads in a row).
      blobUrls.forEach((u) => URL.revokeObjectURL(u.url));
      blobUrls = [];
      writeOutput = async (name, data) => {
        const type = name.endsWith('.txt') ? 'text/plain' : 'video/mp4';
        blobUrls.push({ name, url: URL.createObjectURL(new Blob([data], { type })) });
      };
      where = null;
    }
    running = true; results = null; error = null; progress = { message: 'เริ่ม…', ratio: 0, part: 0, parts: plan.parts.length };
    render();
    try {
      const res = await runExport({
        plan, timeline: tl, files: st.videos.map((v) => v.file), profile,
        options: { ...Object.fromEntries((profile.options || []).map((x) => [x.key, x.default])), ...(st.exportOptions || {}) },
        outputBase: base, writeOutput,
        onProgress: (p) => { progress = p; renderProgress(); },
      });
      const names = res.map((r) => r.name);
      const report = cutReport(plan, tl, names);
      const reportName = `${safeName(base) || 'meeting'}_สรุปการตัด.txt`;
      const reportBytes = new TextEncoder().encode(report);
      await writeOutput(reportName, reportBytes);
      results = { files: [...res, { name: reportName, bytes: reportBytes.byteLength, duration: null }], where };
      toast('ส่งออกเสร็จแล้ว', 'success');
    } catch (e) {
      console.error(e);
      error = running ? e.message : 'ยกเลิกแล้ว';
    } finally {
      running = false;
      progress = null;
      render();
    }
  }

  function cancel() {
    running = false;
    ffmpeg.cancel();
    error = 'ยกเลิกแล้ว ไฟล์ที่ยังสร้างไม่เสร็จจะไม่ถูกบันทึก';
    render();
  }

  const progressBox = h('div.progress');
  function renderProgress() {
    if (!progress) { clear(progressBox); return; }
    const p = progress;
    const speed = p.speed ? ` · เร็ว ${p.speed.toFixed(p.speed >= 10 ? 0 : 1)}× ของเวลาจริง` : '';
    clear(progressBox,
      h('div.progress-msg', `${p.message}${p.parts > 1 ? ` (${p.part + 1}/${p.parts})` : ''}${speed}`),
      h('div.bar.on', h('div.bar-fill', { style: { width: `${Math.round((p.ratio || 0) * 100)}%` } })));
  }

  function render() {
    const st = store.get();
    const tl = app.timeline();
    const profile = getExportProfile(st.exportProfile) || exportProfiles()[0];
    const plan = buildPlan(tl, st.cuts, st.splits, { snap: profile.snapToKeyframes !== false });
    const base = st.outputBase || defaultBase(st.videos);
    const undecided = st.cuts.filter((c) => c.status === 'suggested');
    const toFolder = st.source?.kind === 'folder';
    const sizes = plan.parts.map((p) => estimatePartBytes(p, tl));

    const warnings = [];
    if (undecided.length) warnings.push(h('p.warn', icon('alert', 16), `ยังมี ${undecided.length} ช่วงที่ยังไม่ได้ตัดสินใจ ช่วงเหล่านี้จะไม่ถูกตัด `, h('button.ghost.small', { type: 'button', onclick: () => app.go('review') }, 'กลับไปตรวจ')));
    if (st.compat && !st.compat.ok && profile.id === 'copy') warnings.push(h('p.warn', icon('alert', 16), 'ไฟล์วิดีโอแต่ละไฟล์ถูกบันทึกด้วยการตั้งค่าต่างกัน การต่อแบบไม่บีบอัดอาจได้ไฟล์ที่เล่นไม่ปกติ ถ้าเจอปัญหาให้เลือกแบบบีบอัด'));
    if (!tl.hasKeyframes) warnings.push(h('p.warn', icon('alert', 16), 'อ่าน keyframe ของบางไฟล์ไม่ได้ ภาพอาจกระตุกสั้น ๆ ที่รอยตัด'));
    plan.warnings.forEach((w) => warnings.push(h('p.warn', icon('alert', 16), w.message)));
    if (profile.speed === 'fast' && sizes.some((b) => b > MAX_OUTPUT_BYTES)) warnings.push(h('p.warn', icon('alert', 16), 'บางไฟล์ผลลัพธ์จะใหญ่เกิน ~1.9 GB ซึ่ง browser สร้างไม่ได้ เพิ่มจุดแบ่งไฟล์ในขั้นตรวจจุดตัด หรือเลือกแบบบีบอัด'));

    clear(body,
      h('div.export-grid',
        h('section.panel',
          h('h2', 'ผลลัพธ์'),
          h('div.result-head',
            h('div', h('div.big-num', formatTime(plan.keptDuration)), h('div.hint', `จาก ${formatTime(tl.duration)} · ตัดออก ${formatTime(plan.removedDuration)} (${plan.removed.length} ช่วง)`))),
          h('table.parts',
            h('thead', h('tr', h('th', 'ไฟล์'), h('th', 'ความยาว'), h('th', profile.speed === 'fast' ? 'ขนาดประมาณ' : ''))),
            h('tbody', plan.parts.map((p, i) => h('tr',
              h('td', partFileName(base, p, plan.parts.length, profile.outputExtension)),
              h('td.tc', formatTime(p.duration)),
              h('td.tc', profile.speed === 'fast' ? formatBytes(sizes[i]) : ''))))),
          warnings),

        h('section.panel',
          h('h2', 'วิธีสร้างไฟล์'),
          h('div.profiles', exportProfiles().map((pr) => h(`label.profile${pr.id === profile.id ? '.chosen' : ''}`,
            h('input', { type: 'radio', name: 'profile', value: pr.id, checked: pr.id === profile.id, disabled: running, onchange: () => store.set({ exportProfile: pr.id, exportOptions: {} }) }),
            h('span.profile-body',
              h('span.profile-name', pr.label, pr.experimental ? h('span.tag', 'ทดลอง') : null),
              h('span.hint', pr.description))))),
          h('div.profile-options', optionsForm(profile)),
          h('label.field',
            h('span', 'ชื่อไฟล์'),
            h('input', { type: 'text', value: base, disabled: running, onchange: (e) => store.set({ outputBase: e.target.value.trim() }) })),
          h('p.hint', toFolder ? `บันทึกลงโฟลเดอร์ output ใน “${st.source.name}” พร้อมไฟล์สรุปการตัด (.txt)` : 'ไฟล์จะถูกดาวน์โหลดผ่าน browser'),
          h('div.export-actions',
            running
              ? h('button.secondary', { type: 'button', onclick: cancel }, icon('x', 16), 'ยกเลิก')
              : h('button.primary.big', { type: 'button', disabled: plan.parts.length === 0, onclick: start }, icon('download', 18), plan.parts.length > 1 ? `ส่งออก ${plan.parts.length} ไฟล์` : 'ส่งออก')),
          progressBox,
          error ? h('p.warn.pre', icon('alert', 16), error) : null,
          results ? h('div.results',
            h('p', h('strong', results.where ? `บันทึกใน ${results.where}` : 'เสร็จแล้ว กดบันทึกทีละไฟล์')),
            h('ul', results.files.map((r) => {
              const dl = blobUrls.find((b) => b.name === r.name);
              return h('li', icon('check', 16),
                h('span', `${r.name}${r.duration != null ? ` · ${formatTime(r.duration)}` : ''} · ${formatBytes(r.bytes)}`),
                dl ? h('a.button.secondary.small', { href: dl.url, download: r.name }, icon('download', 15), 'บันทึก') : null);
            }))) : null)),
      h('div.next-bar',
        h('button.ghost', { type: 'button', disabled: running, onclick: () => app.go('review') }, icon('arrowLeft', 16), 'ตรวจจุดตัด'),
        h('span')));
    renderProgress();
  }

  render();
  const unsub = store.subscribe(() => { if (!running) render(); });
  return () => { unsub(); blobUrls.forEach((u) => URL.revokeObjectURL(u.url)); };
}
