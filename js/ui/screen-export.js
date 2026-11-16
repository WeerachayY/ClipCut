import { h, clear, icon, toast } from './dom.js';
import { exportProfiles, exportExtras } from '../core/registry.js';
import { mapLines } from '../core/analysis.js';
import { lineSpans } from '../core/textedit.js';
import { estimatePartBytes } from '../core/plan.js';
import { counts, piecesOf } from '../core/cuts.js';
import { summary as composeSummary } from '../core/compose.js';
import { exportProgram, needsOf } from '../render/export-program.js';
import { gpuSupport } from '../render/gpu.js';
import { emptyArrange, clipList, moveClip, setClipOn, setClipName, resetOrder, isReordered } from '../core/arrange.js';
import { formatTime, formatBytes, formatDuration, formatClockMs } from '../core/time.js';
import { runExport, partFileName, safeName, outputExtension, profilesFor, MAX_OUTPUT_BYTES } from '../media/export.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { ensureWritable, outputDir, writeFileTo } from '../io/folder.js';

function defaultBase(videos) {
  const n = videos[0]?.name || 'video';
  return `${n.replace(/\.[^.]+$/, '')}_ตัดแล้ว`;
}

const MIME = { mp4: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', txt: 'text/plain', srt: 'application/x-subrip' };

const NEED_LABEL = { audio: 'เพลงและระดับเสียง', speed: 'ความเร็ว', visual: 'ข้อความและภาพซ้อน' };

/** Options of a profile: its defaults, then what the user picked for it. */
const optionsOf = (st, profile) => ({ ...Object.fromEntries((profile.options || []).map((x) => [x.key, x.default])), ...(st.exportProfile === profile.id ? st.exportOptions || {} : {}) });

/**
 * The export profile in use (one that fits this job: video or audio, and what was made in step "แต่ง")
 * and what will be made with it. `viaProgram` = rendered by render/export-program.js.
 */
function current(st, tl, app) {
  const profs = profilesFor(exportProfiles(), tl);
  const needs = needsOf(st.compose, app.program().program, tl.kind);
  const fits = (p) => needs.every((n) => (p.handles || []).includes(n));
  const wanted = profs.find((p) => p.id === st.exportProfile);
  const profile = wanted && fits(wanted) ? wanted : profs.find(fits) || profs[0];
  const snap = profile.snapToKeyframes !== false;
  const { plan, program } = app.program({ snap });
  const arrange = { ...emptyArrange(), ...(st.arrange || {}) };
  const clips = clipList(arrange, piecesOf(st.edit, tl.duration));
  const viaProgram = needs.length > 0 || !!profile.renderOnly;
  const options = optionsOf(st, profile);
  return { profs, profile, plan, program, needs, fits, viaProgram, options, arrange, clips, ext: outputExtension(profile, tl, options) };
}

/** Side files (captions, report…): which are on, with their options. */
function extrasState(st, ctx) {
  return exportExtras().map((x) => {
    const saved = st.exportExtras?.[x.id] || {};
    const options = { ...Object.fromEntries((x.options || []).map((o) => [o.key, o.default])), ...saved };
    const available = x.available ? x.available(ctx) : true;
    return { x, available, on: available && (saved.on ?? x.defaultOn !== false), options };
  });
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
  let signal = null;
  let gpu = null; // {ok, reason} once checked
  // only the GPU profile shows the answer, so only it is drawn again (a click elsewhere must not land on a replaced button)
  gpuSupport().then((r) => { gpu = r; if (!running && current(store.get(), app.timeline(), app).profile.render === 'gpu') render(); }).catch(() => {});

  function optionsForm(profile) {
    const st = store.get();
    const o = st.exportProfile === profile.id ? st.exportOptions : {};
    // the profile shown may have been picked for the user (what was made in "แต่ง"): choosing an option keeps it
    const pick = (key, value) => store.set(store.get().exportProfile === profile.id
      ? { exportOptions: { ...store.get().exportOptions, [key]: value } }
      : { exportProfile: profile.id, exportOptions: { [key]: value } });
    return (profile.options || []).map((opt) => h('label.field',
      h('span', opt.label),
      h('select', { disabled: running, onchange: (e) => pick(opt.key, e.target.value) },
        opt.choices.map((c) => h('option', { value: c.value, selected: (o[opt.key] ?? opt.default) === c.value }, c.label)))));
  }

  let settling = null; // end of the last run, clean-up included (a cancelled render stops at its next frame)
  async function start() {
    // the message of the last run goes at once; the button was pressed
    error = null;
    results = null;
    render();
    const st = store.get();
    const tl = app.timeline();
    const { profile, plan, program, viaProgram, options, needs } = current(st, tl, app);
    if (profile.render === 'gpu' && gpu && !gpu.ok) { error = gpu.reason; render(); return; }
    const base = st.outputBase || defaultBase(st.videos);
    let writeOutput;
    let where;
    let openOutput = null;
    const opened = [];
    let outDir = null;
    if (st.source?.kind === 'folder' && await ensureWritable(st.source.dir).catch(() => false)) {
      const out = await outputDir(st.source.dir);
      outDir = out;
      writeOutput = (name, data) => writeFileTo(out, name, data);
      // rendered video goes straight to disk as it is made (no size limit from memory)
      openOutput = async (name) => {
        const fh = await out.getFileHandle(name, { create: true });
        const writable = await fh.createWritable();
        opened.push({ name, writable });
        return { writable, size: async () => (await fh.getFile()).size };
      };
      where = `โฟลเดอร์ ${st.source.name}/output`;
    } else {
      // No folder: keep results in memory and let the user click to save each one
      // (browsers block several automatic downloads in a row).
      blobUrls.forEach((u) => URL.revokeObjectURL(u.url));
      blobUrls = [];
      writeOutput = async (name, data) => {
        const type = MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
        blobUrls.push({ name, url: URL.createObjectURL(new Blob([data], { type })) });
      };
      where = null;
    }
    // pressed again right after "ยกเลิก": let the old run finish removing its half file first
    // (same file name), and not reset this run's state when it ends
    if (settling) {
      progress = { message: 'รอให้การส่งออกครั้งก่อนหยุด…', ratio: 0, part: 0, parts: 1 };
      renderProgress();
      await settling;
    }
    let settle;
    settling = new Promise((r) => { settle = r; });
    running = true; app.exporting = true; results = null; error = null; progress = { message: 'เริ่ม…', ratio: 0, part: 0, parts: plan.parts.length };
    signal = { aborted: false };
    render();
    try {
      const files = st.videos.map((v) => v.file);
      const onProgress = (p) => { progress = p; renderProgress(); };
      const res = viaProgram
        ? await exportProgram({
          mode: profile.render || 'copy-mix', program, plan, timeline: tl, files, compose: st.compose, assets: app.assets, profile, options,
          outputBase: base, writeOutput, openOutput, onProgress, signal,
        })
        : await runExport({ plan, timeline: tl, files, profile, options, outputBase: base, writeOutput, onProgress });
      const names = res.map((r) => r.name);
      const ctx = extrasContext(st, tl, plan, base, names, viaProgram && needs.includes('speed') ? program : null);
      const sideFiles = [];
      for (const ex of extrasState(st, ctx).filter((e) => e.on)) {
        for (const f of ex.x.build({ ...ctx, options: ex.options })) {
          const bytes = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
          await writeOutput(f.name, bytes);
          sideFiles.push({ name: f.name, bytes: bytes.byteLength, duration: null });
        }
      }
      results = { files: [...res, ...sideFiles], where };
      toast('ส่งออกเสร็จแล้ว', 'success');
      app.markExported();
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
      error = running && e.name !== 'AbortError' ? e.message : 'ยกเลิกแล้ว ไฟล์ที่ยังสร้างไม่เสร็จจะไม่ถูกบันทึก';
      // a video that was being written to the folder: do not leave half a file behind
      for (const o of opened) {
        await o.writable.abort?.().catch(() => {});
        await outDir?.removeEntry(o.name).catch(() => {});
      }
    } finally {
      signal = null;
      running = false;
      app.exporting = false;
      progress = null;
      settling = null;
      settle();
      render();
    }
  }

  function cancel() {
    running = false;
    if (signal) signal.aborted = true;
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

  /** `program`: given when speed changes moved the times (captions follow the program, not the plain plan). */
  function extrasContext(st, tl, plan, base, names, program = null) {
    const spans = st.transcript ? lineSpans(mapLines(st.transcript, st.anchors, st.anchorMode), tl.duration) : [];
    return { plan, program, timeline: tl, base, fileBase: safeName(base) || 'video', names, spans, transcript: st.transcript };
  }

  function setExtra(id, patch) {
    const cur = store.get().exportExtras || {};
    store.set({ exportExtras: { ...cur, [id]: { ...(cur[id] || {}), ...patch } } });
  }

  function extrasForm(st, tl, plan, base, profile, ext) {
    const names = plan.parts.map((p) => partFileName(base, p, plan.parts.length, ext));
    const list = extrasState(st, extrasContext(st, tl, plan, base, names));
    if (!list.length) return null;
    return h('fieldset.extras', h('legend', 'ไฟล์ที่ได้เพิ่ม'),
      list.map(({ x, available, on, options }) => h('div.extra',
        h('label.tick', h('input', { type: 'checkbox', checked: on, disabled: running || !available, onchange: (e) => setExtra(x.id, { on: e.target.checked }) }),
          h('span', x.label, !available && x.unavailableHint ? h('span.hint', ` · ${x.unavailableHint}`) : null)),
        x.description ? h('p.hint', x.description) : null,
        on && x.options?.length ? h('div.extra-options', x.options.map((o) => (o.type === 'checkbox'
          ? h('label.tick.small', h('input', { type: 'checkbox', checked: options[o.key] !== false, disabled: running, onchange: (e) => setExtra(x.id, { [o.key]: e.target.checked }) }), h('span', o.label))
          : null))) : null)));
  }

  function setArrange(patch) { store.set({ arrange: { ...emptyArrange(), ...(store.get().arrange || {}), ...patch } }); }
  const changeArrange = (fn) => store.set({ arrange: fn({ ...emptyArrange(), ...(store.get().arrange || {}) }) });
  let dragKey = null;

  /** The pieces as a list: tick the ones to export, name them, drag to reorder. */
  function clipsPanel(arrange, clips, tl) {
    const ps = () => piecesOf(store.get().edit, tl.duration);
    const clock = (t) => (tl.kind === 'audio' ? formatClockMs(t, { short: tl.duration < 3600 }) : formatTime(t, { decimals: 1, short: tl.duration < 3600 }));
    const joined = arrange.output === 'joined';
    const row = (c, i) => h(`li.clip${c.on ? '' : '.off'}`, {
      draggable: !running, dataset: { key: c.key },
      ondragstart: (e) => { dragKey = c.key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.key); e.currentTarget.classList.add('dragging'); },
      ondragend: (e) => { dragKey = null; e.currentTarget.classList.remove('dragging'); body.querySelectorAll('.clip').forEach((el) => el.classList.remove('over-top', 'over-bottom')); },
      ondragover: (e) => {
        if (!dragKey || dragKey === c.key) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const below = e.clientY > r.top + r.height / 2;
        e.currentTarget.classList.toggle('over-top', !below);
        e.currentTarget.classList.toggle('over-bottom', below);
      },
      ondragleave: (e) => e.currentTarget.classList.remove('over-top', 'over-bottom'),
      ondrop: (e) => {
        if (!dragKey || dragKey === c.key) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const below = e.clientY > r.top + r.height / 2;
        const from = clips.findIndex((x) => x.key === dragKey);
        let to = i + (below ? 1 : 0);
        if (from < to) to -= 1;
        const key = dragKey;
        changeArrange((a) => moveClip(a, ps(), key, to));
      },
    },
      h('span.clip-grip', { 'aria-hidden': 'true', 'data-tip': 'ลากเพื่อเรียงลำดับ' }, icon('grip', 16)),
      h('input', { type: 'checkbox', checked: c.on, disabled: running, 'aria-label': `เลือก ${c.name}`, onchange: (e) => changeArrange((a) => setClipOn(a, c.key, e.target.checked)) }),
      h('input.clip-name', { type: 'text', value: c.named ? c.name : '', placeholder: c.name, maxlength: 60, disabled: running, 'aria-label': `ชื่อของ ${c.name}`, onchange: (e) => changeArrange((a) => setClipName(a, c.key, e.target.value)) }),
      h('span.clip-time', `${clock(c.start)} – ${clock(c.end)}`),
      h('span.clip-dur', formatDuration(c.end - c.start)),
      h('button.ghost.icon-only.small', { type: 'button', disabled: running || i === 0, 'aria-label': `เลื่อน ${c.name} ขึ้น`, onclick: () => changeArrange((a) => moveClip(a, ps(), c.key, i - 1)) }, icon('arrowUp', 15)),
      h('button.ghost.icon-only.small', { type: 'button', disabled: running || i === clips.length - 1, 'aria-label': `เลื่อน ${c.name} ลง`, onclick: () => changeArrange((a) => moveClip(a, ps(), c.key, i + 1)) }, icon('arrowDown', 15)));
    const all = clips.every((c) => c.on);
    return h('div.clips',
      clips.length < 2 ? h('p.warn', icon('alert', 16), 'ยังไม่มีจุดตัด จึงมีชิ้นเดียว ', h('button.ghost.small', { type: 'button', onclick: () => app.go('review') }, 'กลับไปมาร์กจุดตัด')) : null,
      h('div.clip-out',
        h('label.tick', h('input', { type: 'radio', name: 'clip-out', checked: !joined, disabled: running, onchange: () => setArrange({ output: 'separate' }) }), h('span', 'แยกชิ้นละไฟล์')),
        h('label.tick', h('input', { type: 'radio', name: 'clip-out', checked: joined, disabled: running, onchange: () => setArrange({ output: 'joined' }) }), h('span', 'ต่อเป็นไฟล์เดียวตามลำดับในรายการ'))),
      h('ol.clip-list', clips.map(row)),
      h('div.clip-tools',
        h('button.ghost.small', { type: 'button', disabled: running, onclick: () => changeArrange((a) => ({ ...a, off: Object.fromEntries(clips.map((c) => [c.key, all])) })) }, all ? 'ไม่เลือกทั้งหมด' : 'เลือกทั้งหมด'),
        isReordered(clips.map((c) => ({ ...c, on: true }))) ? h('button.ghost.small', { type: 'button', disabled: running, onclick: () => changeArrange(resetOrder) }, 'คืนลำดับเดิม') : null,
        h('span.hint', 'ลากที่จุด 6 จุด หรือกดลูกศร เพื่อเรียงลำดับ')));
  }

  function render() {
    const st = store.get();
    const tl = app.timeline();
    const { profs, profile, plan, program, needs, fits, viaProgram, arrange, clips, ext } = current(st, tl, app);
    const parts = viaProgram ? program.parts : plan.parts;
    const outDuration = viaProgram ? program.duration : plan.keptDuration;
    const made = composeSummary(st.compose);
    const clipMode = arrange.mode === 'clips';
    const audio = tl.kind === 'audio';
    const base = st.outputBase || defaultBase(st.videos);
    const undecided = { length: counts(st.edit, tl.duration).suggested };
    const toFolder = st.source?.kind === 'folder';
    const sizes = plan.parts.map((p) => estimatePartBytes(p, tl));

    const warnings = [];
    if (undecided.length && !clipMode) warnings.push(h('p.warn', icon('alert', 16), `ยังมี ${undecided.length} ชิ้นที่แนะนำให้ทิ้งแต่ยังไม่ได้ตัดสินใจ ชิ้นเหล่านี้จะถูกเก็บไว้ `, h('button.ghost.small', { type: 'button', onclick: () => app.go('review') }, 'กลับไปตรวจ')));
    if (st.compat && !st.compat.ok && profile.speed === 'fast') warnings.push(h('p.warn', icon('alert', 16), audio
      ? 'ไฟล์เสียงแต่ละไฟล์ถูกบันทึกด้วยการตั้งค่าต่างกัน การต่อแบบไม่เข้ารหัสใหม่อาจได้ไฟล์ที่เล่นไม่ปกติ ถ้าเจอปัญหาให้เลือกแบบเข้ารหัสใหม่'
      : 'ไฟล์วิดีโอแต่ละไฟล์ถูกบันทึกด้วยการตั้งค่าต่างกัน การต่อแบบไม่บีบอัดอาจได้ไฟล์ที่เล่นไม่ปกติ ถ้าเจอปัญหาให้เลือกแบบบีบอัด'));
    if (clipMode && plan.snapped) warnings.push(h('p.hint', 'แบบไม่บีบอัด หัวของแต่ละชิ้นจะเริ่มที่ keyframe ก่อนจุดตัด จึงอาจมีภาพก่อนหน้าติดมา 1–2 วินาที เลือกแบบบีบอัดถ้าต้องการตรงจุดเป๊ะ'));
    if (!audio && !tl.hasKeyframes) warnings.push(h('p.warn', icon('alert', 16), 'อ่าน keyframe ของบางไฟล์ไม่ได้ ภาพอาจกระตุกสั้น ๆ ที่รอยตัด'));
    plan.warnings.forEach((w) => warnings.push(h('p.warn', icon('alert', 16), w.message)));
    if (profile.render === 'gpu' && gpu && !gpu.ok) warnings.push(h('p.warn', icon('alert', 16), gpu.reason));
    if (profile.speed === 'fast' && !profile.render && sizes.some((b) => b > MAX_OUTPUT_BYTES)) warnings.push(h('p.warn', icon('alert', 16), 'บางไฟล์ผลลัพธ์จะใหญ่เกิน ~1.9 GB ซึ่ง browser สร้างไม่ได้ เพิ่มจุดแบ่งไฟล์ในขั้นตรวจจุดตัด หรือเลือกแบบบีบอัด'));

    clear(body,
      h('div.export-grid',
        h('section.panel',
          h('h2', 'ผลลัพธ์'),
          h('div.seg.mode', { role: 'tablist' },
            h('button', { type: 'button', role: 'tab', disabled: running, 'aria-selected': String(!clipMode), onclick: () => setArrange({ mode: 'cut' }) }, 'ตัดช่วงทิ้ง'),
            h('button', { type: 'button', role: 'tab', disabled: running, 'aria-selected': String(clipMode), onclick: () => setArrange({ mode: 'clips' }) }, 'เลือกและเรียงชิ้น')),
          clipMode ? clipsPanel(arrange, clips, tl) : null,
          h('div.result-head',
            h('div', h('div.big-num', formatTime(outDuration)), h('div.hint', clipMode
              ? `จาก ${formatTime(tl.duration)} · เลือก ${clips.filter((c) => c.on).length} จาก ${clips.length} ชิ้น${arrange.output === 'joined' && isReordered(clips) ? ' · เรียงลำดับใหม่' : ''}`
              : `จาก ${formatTime(tl.duration)} · ตัดออก ${formatTime(plan.removedDuration)} (${plan.removed.length} ช่วง)`),
              needs.includes('speed') ? h('div.hint', `ความเร็วที่ตั้งไว้ทำให้ยาว ${formatTime(program.duration)} (ก่อนปรับ ${formatTime(plan.keptDuration)})`) : null)),
          needs.length ? h('div.made',
            h('span', 'ที่แต่งไว้: ', [made.text && `ข้อความ ${made.text}`, made.image && `ภาพ ${made.image}`, made.video && `วิดีโอซ้อน ${made.video}`, made.audio && `เสียง ${made.audio}`, made.speed && `ความเร็ว ${made.speed} ชิ้น`,
              needs.includes('audio') && !made.audio && !made.video ? 'ระดับเสียง' : null].filter(Boolean).join(' · ')),
            h('button.ghost.small', { type: 'button', disabled: running, onclick: () => app.go('compose') }, 'แก้')) : null,
          h('table.parts',
            h('thead', h('tr', h('th', 'ไฟล์'), h('th', 'ความยาว'), h('th', profile.speed === 'fast' && !profile.render ? 'ขนาดประมาณ' : ''))),
            h('tbody', parts.map((p, i) => h('tr',
              h('td', partFileName(base, p, parts.length, ext)),
              h('td.tc', formatTime(p.duration)),
              h('td.tc', profile.speed === 'fast' && !profile.render ? formatBytes(sizes[i]) : ''))))),
          warnings),

        h('section.panel',
          h('h2', 'วิธีสร้างไฟล์'),
          h('div.profiles', profs.map((pr) => {
            const ok = fits(pr);
            const missing = needs.filter((n) => !(pr.handles || []).includes(n)).map((n) => NEED_LABEL[n]);
            return h(`label.profile${pr.id === profile.id ? '.chosen' : ''}${ok ? '' : '.unfit'}`,
              h('input', { type: 'radio', name: 'profile', value: pr.id, checked: pr.id === profile.id, disabled: running || !ok, onchange: () => store.set({ exportProfile: pr.id, exportOptions: {} }) }),
              h('span.profile-body',
                h('span.profile-name', pr.label, pr.experimental ? h('span.tag', 'ทดลอง') : null),
                h('span.hint', pr.description),
                ok ? null : h('span.hint.unfit-why', `ใช้ไม่ได้กับ${missing.join(' และ ')}ที่แต่งไว้`),
                pr.id === profile.id && pr.render === 'gpu' ? h('span.hint', gpu == null ? 'กำลังตรวจตัวเข้ารหัสวิดีโอของ browser…' : gpu.ok
                  ? 'browser นี้เข้ารหัส H.264 ได้ จะใช้การ์ดจอเมื่อเครื่องมี ไม่มีก็ใช้ CPU (ช้ากว่า)' : '') : null));
          })),
          h('div.profile-options', optionsForm(profile)),
          h('label.field',
            h('span', 'ชื่อไฟล์'),
            h('input', { type: 'text', value: base, disabled: running, onchange: (e) => store.set({ outputBase: e.target.value.trim() }) })),
          extrasForm(st, tl, plan, base, profile, ext),
          h('p.hint', toFolder ? `บันทึกลงโฟลเดอร์ output ใน “${st.source.name}”` : 'ไฟล์จะถูกดาวน์โหลดผ่าน browser'),
          h('div.export-actions',
            running
              ? h('button.secondary', { type: 'button', onclick: cancel }, icon('x', 16), 'ยกเลิก')
              : h('button.primary.big', { type: 'button', disabled: plan.parts.length === 0 || (profile.render === 'gpu' && gpu && !gpu.ok), onclick: start }, icon('download', 18), plan.parts.length > 1 ? `ส่งออก ${plan.parts.length} ไฟล์` : 'ส่งออก')),
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
        h('button.ghost', { type: 'button', disabled: running, onclick: () => app.go('compose') }, icon('arrowLeft', 16), 'กลับไปแต่ง'),
        h('span')));
    renderProgress();
  }

  render();
  // re-render only for state this screen shows: an autosave tick must not rebuild a field being typed in
  const WATCH = ['edit', 'arrange', 'compose', 'exportProfile', 'exportOptions', 'exportExtras', 'outputBase', 'videos', 'transcript', 'anchors', 'anchorMode', 'compat', 'source'];
  let seen = WATCH.map((k) => store.get()[k]);
  const unsub = store.subscribe((st) => {
    const now = WATCH.map((k) => st[k]);
    if (now.every((v, i) => v === seen[i])) return;
    seen = now;
    if (!running) render();
  });
  return () => { unsub(); blobUrls.forEach((u) => URL.revokeObjectURL(u.url)); };
}
