import { h, clear, icon } from './dom.js';
import { detectors } from '../core/registry.js';
import { formatTime, formatBytes, formatDuration } from '../core/time.js';
import { TRANSCRIPT_EXT } from '../io/folder.js';

/** Generic settings form for detector plugins (driven by each plugin's `settings` list). */
export function detectorSettingsForm(app) {
  const s = app.store.get();
  const set = (id, patch) => {
    const cur = app.store.get().detectorSettings;
    app.store.set({ detectorSettings: { ...cur, [id]: { ...cur[id], ...patch } } });
  };
  return h('div.det-list', detectors().map((d) => {
    const p = { ...(d.defaults || {}), ...(s.detectorSettings[d.id] || {}) };
    const on = p.enabled !== false;
    return h('fieldset.det',
      h('legend', h('label.tick', h('input', { type: 'checkbox', checked: on, onchange: (e) => set(d.id, { enabled: e.target.checked }) }), h('span', d.label))),
      h('p.hint', d.description),
      h('div.det-fields', (d.settings || []).map((f) => h('label.field',
        h('span', f.label),
        f.type === 'text'
          ? h('textarea', { rows: 2, value: p[f.key], onchange: (e) => set(d.id, { [f.key]: e.target.value }) })
          : h('span.num', h('input', { type: 'number', value: String(p[f.key]), min: f.min, max: f.max, step: f.step || 1, onchange: (e) => set(d.id, { [f.key]: Number(e.target.value) }) }), f.unit ? h('span.unit', f.unit) : null)))));
  }));
}

export function mount(root, app) {
  const body = h('div.files');
  root.append(body);
  let settingsOpen = false;

  function render() {
    const s = app.store.get();
    const tl = app.timeline();
    const t = s.transcript;
    const lastTau = t?.lines.length ? t.lines[t.lines.length - 1].tau : null;
    const mismatch = lastTau != null && lastTau > tl.duration + 60;
    const noKf = s.videos.filter((v) => !v.keyframes);

    const videoRows = s.videos.map((v, i) => h('li.vrow',
      h('span.vnum', String(i + 1)),
      h('div.vmain',
        h('div.vname', v.name),
        h('div.vmeta', `${formatTime(v.duration)} · ${formatBytes(v.size)}`, v.keyframes ? '' : ' · อ่าน keyframe ไม่ได้', v.playable ? '' : ' · browser เล่นไฟล์นี้ไม่ได้')),
      s.videos.length > 1 ? h('span.vmove',
        h('button.ghost.icon-only', { type: 'button', disabled: i === 0, onclick: () => app.moveVideo(v.id, -1), 'aria-label': `เลื่อน ${v.name} ขึ้น` }, icon('up')),
        h('button.ghost.icon-only', { type: 'button', disabled: i === s.videos.length - 1, onclick: () => app.moveVideo(v.id, 1), 'aria-label': `เลื่อน ${v.name} ลง` }, icon('down'))) : null));

    const tInput = h('input', { type: 'file', accept: TRANSCRIPT_EXT.join(','), hidden: true, onchange: (e) => e.target.files[0] && app.setTranscript(e.target.files[0]) });
    const candidates = (s.transcriptCandidates || []).filter((f) => f.name !== t?.fileName);

    clear(body,
      h('div.files-grid',
        h('section.panel',
          h('h2', 'วิดีโอ ', h('span.count', `${s.videos.length} ไฟล์ · รวม ${formatTime(tl.duration)}`)),
          s.videos.length > 1 ? h('p.hint', 'แอปจะต่อไฟล์ตามลำดับนี้ ตรวจว่าลำดับถูกต้องตามเวลาที่บันทึก') : null,
          h('ol.vlist', videoRows),
          noKf.length ? h('p.warn', icon('alert', 16), noKf.some((v) => !v.kfTried) ? 'อ่านตำแหน่ง keyframe จากดัชนีไฟล์ไม่ได้ จะลองอีกวิธีตอนหาจุดตัด' : 'อ่าน keyframe ไม่ได้ จะตัดตรงเวลาที่ตั้ง แต่ภาพอาจกระตุกสั้น ๆ ที่รอยตัด') : null,
          s.otherFiles?.length ? h('p.hint', `ไม่ได้ใช้: ${s.otherFiles.slice(0, 6).join(', ')}${s.otherFiles.length > 6 ? ' …' : ''}`) : null),

        h('section.panel',
          h('h2', 'Transcript'),
          t ? h('div.tcard',
            h('div.tname', icon('file', 16), t.fileName),
            h('div.tmeta', `${t.parserLabel} · ${t.lines.length} บรรทัด · ${formatTime(t.lines[0]?.tau)} ถึง ${formatTime(lastTau)}`),
            t.removed ? h('div.tmeta', `ตัดบรรทัดซ้ำออก ${t.removed} บรรทัด`) : null,
            mismatch ? h('p.warn', icon('alert', 16), `transcript ยาวกว่าวิดีโอ ${formatDuration(lastTau - tl.duration)} อาจเป็นคนละประชุม หรือเวลาเริ่มไม่ตรงกัน ปรับได้ด้วยหมุดเวลาในขั้นถัดไป`) : null)
            : h('p.empty', 'ไม่มี transcript จะหาจุดตัดจากเสียงเงียบอย่างเดียว'),
          h('div.row-actions',
            candidates.map((f) => h('button.secondary.small', { type: 'button', onclick: () => app.setTranscript(f) }, `ใช้ ${f.name}`)),
            h('button.secondary.small', { type: 'button', onclick: () => tInput.click() }, t ? 'เลือกไฟล์อื่น' : 'เลือกไฟล์ transcript'),
            t ? h('button.ghost.small', { type: 'button', onclick: () => app.setTranscript(null) }, 'ไม่ใช้ transcript') : null,
            tInput))),

      h('details.panel.settings', { open: settingsOpen, ontoggle: (e) => { settingsOpen = e.target.open; } },
        h('summary', 'ตั้งค่าการหาจุดตัด'),
        detectorSettingsForm(app)),

      h('div.next-bar',
        h('button.ghost', { type: 'button', onclick: () => app.go('start') }, icon('arrowLeft', 16), 'เปิดโฟลเดอร์อื่น'),
        h('div.next-right',
          s.cuts.length ? h('button.secondary', { type: 'button', onclick: () => app.go('review') }, 'กลับไปตรวจจุดตัดเดิม') : null,
          h('button.primary', { type: 'button', disabled: !s.videos.every((v) => v.duration), onclick: () => app.analyze() }, 'หาจุดตัด', icon('arrowRight', 16)))));
  }

  render();
  let last = null;
  const unsub = app.store.subscribe((s) => {
    const sig = [s.videos, s.transcript, s.detectorSettings, s.cuts.length];
    if (last && sig.every((v, i) => v === last[i])) return;
    last = sig;
    // keep focus inside the settings form while typing
    if (document.activeElement && body.contains(document.activeElement) && document.activeElement.closest('.settings')) return;
    render();
  });
  return unsub;
}
