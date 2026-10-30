import { h, clear, icon, toast } from './dom.js';
import { MultiPlayer } from './player.js';
import { TimelineView } from './timeline-view.js';
import { formatTime, formatDuration } from '../core/time.js';
import { effectiveCut, buildPlan } from '../core/plan.js';
import { setStatus, nudge, setEdge, addManual, removeCut, acceptAllHigh, counts } from '../core/cuts.js';
import { mapLines, proposeAnchors } from '../core/analysis.js';
import { newId } from '../core/store.js';

const CONF_LABEL = { high: 'แนะนำ', check: 'ควรเช็ค', manual: 'เพิ่มเอง' };

export function mount(root, app) {
  const store = app.store;
  let tl = app.timeline();
  let markIn = null;
  let sideView = 'cuts';
  let follow = true;
  let seam = 5;
  let lines = [];
  let lineEls = [];
  let currentLine = -1;
  let proposals = null;

  // ---------- player + transport ----------
  const video = h('video.player', { playsinline: true, preload: 'auto' });
  const player = new MultiPlayer(video);
  const fileTag = h('span.file-tag');
  const timeLabel = h('span.time-now', '0:00:00');
  const playBtn = h('button.primary.icon-only.play', { type: 'button', onclick: () => player.toggle(), 'aria-label': 'เล่น/หยุด (Space)' }, icon('play', 20));
  const markLabel = h('span.mark-label');
  const skipBox = h('input', { type: 'checkbox', onchange: (e) => { player.skipRanges = e.target.checked ? skipRanges : null; } });
  const rateSel = h('select', { 'aria-label': 'ความเร็ว', onchange: (e) => player.setRate(Number(e.target.value)) },
    ['1', '1.5', '2', '4'].map((r) => h('option', { value: r }, `${r}×`)));
  const seamSel = h('select', { 'aria-label': 'ระยะฟังรอยต่อ', onchange: (e) => { seam = Number(e.target.value); } },
    [3, 5, 10].map((v) => h('option', { value: String(v), selected: v === seam }, `ฟังรอยต่อ ±${v} วิ`)));
  const jump = (d) => () => player.seek(player.time + d);

  const transport = h('div.transport',
    h('div.tp-group',
      h('button.ghost.icon-only', { type: 'button', onclick: jump(-5), 'aria-label': 'ถอย 5 วินาที (←)' }, icon('back')),
      h('button.ghost.small', { type: 'button', onclick: jump(-1), 'aria-label': 'ถอย 1 วินาที (Shift+←)' }, '−1'),
      playBtn,
      h('button.ghost.small', { type: 'button', onclick: jump(1), 'aria-label': 'ไปข้างหน้า 1 วินาที (Shift+→)' }, '+1'),
      h('button.ghost.icon-only', { type: 'button', onclick: jump(5), 'aria-label': 'ไปข้างหน้า 5 วินาที (→)' }, icon('fwd')),
      h('span.time', timeLabel, h('span.time-total', ` / ${formatTime(tl.duration)}`)),
      rateSel),
    h('div.tp-group',
      h('button.secondary.small', { type: 'button', onclick: () => markInOut('in'), title: 'ปุ่มลัด I' }, icon('scissors', 16), 'เริ่มช่วงตัด'),
      h('button.secondary.small', { type: 'button', onclick: () => markInOut('out'), title: 'ปุ่มลัด O' }, 'จบช่วงตัด'),
      h('button.secondary.small', { type: 'button', onclick: addSplit, title: 'ปุ่มลัด S' }, icon('split', 16), 'แบ่งไฟล์ที่นี่'),
      markLabel),
    h('div.tp-group.tp-right',
      h('label.tick.small', skipBox, h('span', 'เล่นแบบผลลัพธ์ (ข้ามช่วงที่ตัด)')),
      seamSel,
      h('button.ghost.icon-only', { type: 'button', onclick: showKeys, 'aria-label': 'ปุ่มลัด' }, icon('keyboard'))));

  const timelineView = new TimelineView({
    onSeek: (t) => player.seek(t),
    onSelectCut: (id) => select(id, true),
  });

  // ---------- side panel ----------
  const segCuts = h('button', { type: 'button', role: 'tab', onclick: () => { sideView = 'cuts'; renderSide(); } });
  const segSync = h('button', { type: 'button', role: 'tab', onclick: () => { sideView = 'sync'; renderSide(); } });
  const sideBody = h('div.side-body');
  const side = h('aside.rv-side', h('div.seg', { role: 'tablist' }, segCuts, segSync), sideBody);

  const summary = h('div.next-summary');
  const nextBar = h('div.next-bar',
    h('button.ghost', { type: 'button', onclick: () => app.go('files') }, icon('arrowLeft', 16), 'ตรวจไฟล์'),
    summary,
    h('button.primary', { type: 'button', onclick: () => app.go('export') }, 'ไปขั้นส่งออก', icon('arrowRight', 16)));

  root.append(h('section.review',
    h('div.rv-main', h('div.player-wrap', video, fileTag), transport, timelineView.el),
    side), nextBar);

  // ---------- helpers ----------
  const s = () => store.get();
  function scrollWithin(container, el, center) {
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (center) container.scrollTop += r.top - c.top - (c.height - r.height) / 2;
    else if (r.top < c.top) container.scrollTop -= c.top - r.top + 8;
    else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom + 8;
  }
  const eff = (c) => effectiveCut(tl, c);
  function skipRanges() {
    return s().cuts.filter((c) => c.status === 'accepted').map((c) => ({ start: c.start, end: eff(c).effectiveEnd }));
  }
  function select(id, seek) {
    store.set({ selectedCutId: id });
    const c = s().cuts.find((x) => x.id === id);
    if (c && seek) player.seek(c.start);
    sideView = 'cuts';
  }
  function preview(c) {
    select(c.id, false);
    player.previewSeam(c.start, eff(c).effectiveEnd, { before: seam, after: seam });
  }
  function markInOut(which) {
    const t = player.time;
    if (which === 'in') { markIn = t; markLabel.textContent = `เริ่มช่วงตัดที่ ${formatTime(t)} แล้วกด “จบช่วงตัด” ที่จุดจบ`; return; }
    if (markIn == null) { toast('กด “เริ่มช่วงตัด” (I) ที่จุดเริ่มก่อน'); return; }
    const res = addManual(s().cuts, markIn, t);
    markIn = null;
    markLabel.textContent = '';
    if (!res.id) { toast('ช่วงตัดสั้นเกินไป'); return; }
    store.set({ cuts: res.cuts, selectedCutId: res.id });
  }
  function addSplit() {
    const at = Math.round(player.time * 10) / 10;
    const n = s().splits.length + 2;
    store.set({ splits: [...s().splits, { id: newId('s'), at, label: `ช่วงที่ ${n}` }].sort((a, b) => a.at - b.at) });
    toast(`แบ่งไฟล์ที่ ${formatTime(at)}`);
  }
  function showKeys() {
    toast(h('div.keys',
      h('strong', 'ปุ่มลัด'),
      h('div', 'Space เล่น/หยุด · ← → 5 วิ · Shift+← → 1 วิ'),
      h('div', 'I เริ่มช่วงตัด · O จบช่วงตัด · S แบ่งไฟล์'),
      h('div', 'J / K ช่วงก่อนหน้า/ถัดไป · P ฟังรอยต่อ'),
      h('div', 'A ตัด · R ไม่ตัด · [ ] ตั้งขอบเริ่ม/จบจากตำแหน่งเล่น')), 'info', 12000);
  }

  // ---------- side: cuts ----------
  function cutRow(c, selected) {
    const e = eff(c);
    const kind = c.status === 'suggested' ? (c.confidence === 'high' ? 'high' : 'check') : c.status;
    const D = tl.duration;
    const upd = (fn) => app.updateCuts(fn);
    const edgeCtl = (edge, label) => h('div.edge',
      h('span.edge-label', label),
      h('button.ghost.small', { type: 'button', onclick: () => upd((cs) => nudge(cs, c.id, edge, -5, D)) }, '−5'),
      h('button.ghost.small', { type: 'button', onclick: () => upd((cs) => nudge(cs, c.id, edge, -1, D)) }, '−1'),
      h('button.ghost.small.tc', { type: 'button', onclick: () => player.seek(c[edge]), title: 'ไปที่จุดนี้' }, formatTime(c[edge], { decimals: 1 })),
      h('button.ghost.small', { type: 'button', onclick: () => upd((cs) => nudge(cs, c.id, edge, 1, D)) }, '+1'),
      h('button.ghost.small', { type: 'button', onclick: () => upd((cs) => nudge(cs, c.id, edge, 5, D)) }, '+5'),
      h('button.ghost.icon-only', { type: 'button', onclick: () => upd((cs) => setEdge(cs, c.id, edge, player.time, D)), title: `ใช้ตำแหน่งเล่นตอนนี้ (ปุ่มลัด ${edge === 'start' ? '[' : ']'})`, 'aria-label': `ตั้ง${label}จากตำแหน่งเล่น` }, icon('target', 16)));

    return h(`li.cut-row.${kind}${selected ? '.selected' : ''}`, { dataset: { id: c.id } },
      h('div.cut-head', { onclick: () => select(c.id, true) },
        h('span.badge', c.status === 'accepted' ? 'ตัด' : c.status === 'rejected' ? 'เก็บไว้' : CONF_LABEL[c.confidence] || 'แนะนำ'),
        h('span.cut-time', `${formatTime(c.start)} – ${formatTime(c.end)}`),
        h('span.cut-len', formatDuration(c.end - c.start))),
      h('div.cut-reasons', (c.reasons || []).join(' · ')),
      h('div.cut-actions',
        h('button.secondary.small', { type: 'button', onclick: () => preview(c), title: 'ปุ่มลัด P' }, icon('ear', 16), 'ฟังรอยต่อ'),
        h(`button.small.${c.status === 'accepted' ? 'on-cut' : 'secondary'}`, { type: 'button', 'aria-pressed': String(c.status === 'accepted'), onclick: () => upd((cs) => setStatus(cs, c.id, c.status === 'accepted' ? 'suggested' : 'accepted')) }, icon('scissors', 15), 'ตัด'),
        h(`button.small.${c.status === 'rejected' ? 'on-keep' : 'secondary'}`, { type: 'button', 'aria-pressed': String(c.status === 'rejected'), onclick: () => upd((cs) => setStatus(cs, c.id, c.status === 'rejected' ? 'suggested' : 'rejected')) }, 'ไม่ตัด')),
      selected ? h('div.cut-edit',
        edgeCtl('start', 'จุดเริ่ม'),
        edgeCtl('end', 'จุดจบ'),
        e.shifted > 0.05 ? h('p.hint', `วิดีโอจะกลับมาเล่นที่ ${formatTime(e.effectiveEnd, { decimals: 1 })} (เร็วกว่าจุดจบ ${e.shifted.toFixed(1)} วิ ตาม keyframe เพื่อไม่ให้เนื้อหาหาย)`) : null,
        e.ineffective ? h('p.warn', icon('alert', 16), 'ช่วงนี้สั้นกว่าระยะห่างของ keyframe จึงตัดแบบไม่ encode ใหม่ไม่ได้') : null,
        h('button.ghost.small.danger', { type: 'button', onclick: () => upd((cs) => removeCut(cs, c.id)) }, icon('trash', 15), 'ลบช่วงนี้')) : null);
  }

  function renderCuts() {
    const st = s();
    const n = counts(st.cuts);
    const plan = buildPlan(tl, st.cuts, st.splits);
    const splitRows = st.splits.map((sp) => h('li.split-row',
      h('button.ghost.small.tc', { type: 'button', onclick: () => player.seek(sp.at) }, formatTime(sp.at)),
      h('input', { type: 'text', value: sp.label || '', 'aria-label': 'ชื่อช่วง', onchange: (e) => store.set({ splits: s().splits.map((x) => (x.id === sp.id ? { ...x, label: e.target.value } : x)) }) }),
      h('button.ghost.icon-only', { type: 'button', 'aria-label': 'ลบจุดแบ่ง', onclick: () => store.set({ splits: s().splits.filter((x) => x.id !== sp.id) }) }, icon('trash', 15))));
    clear(sideBody,
      h('div.cut-summary',
        h('div.big-num', formatTime(plan.removedDuration), h('span', ' ตัดออก')),
        h('div.hint', `เหลือ ${formatTime(plan.keptDuration)} จาก ${formatTime(tl.duration)}${plan.parts.length > 1 ? ` · ${plan.parts.length} ไฟล์` : ''}`),
        h('div.hint', `ตัด ${n.accepted} · รอตัดสินใจ ${n.suggested} · เก็บไว้ ${n.rejected}`),
        n.high ? h('button.secondary.small', { type: 'button', onclick: () => app.updateCuts(acceptAllHigh) }, icon('check', 15), `ตัดทุกช่วงที่แนะนำ (${n.high})`) : null),
      st.cuts.length
        ? h('ul.cut-list', st.cuts.map((c) => cutRow(c, c.id === st.selectedCutId)))
        : h('p.empty', 'ยังไม่มีช่วงตัด กด “เริ่มช่วงตัด” และ “จบช่วงตัด” ระหว่างดูวิดีโอเพื่อเพิ่มเอง'),
      h('h3', 'จุดแบ่งไฟล์'),
      st.splits.length ? h('ul.split-list', splitRows) : h('p.hint', 'กด “แบ่งไฟล์ที่นี่” (S) เพื่อแยกวิดีโอเป็นหลายไฟล์ เช่น แยกตามหัวข้อ'));
    const sel = sideBody.querySelector('.cut-row.selected');
    if (sel) scrollWithin(sideBody, sel, false);
  }

  // ---------- side: transcript + sync anchors ----------
  function renderSync() {
    const st = s();
    if (!st.transcript) {
      clear(sideBody, h('p.empty', 'ไม่มี transcript ในงานนี้ เพิ่มได้ที่ขั้น “ตรวจไฟล์”'));
      return;
    }
    lines = mapLines(st.transcript, st.anchors, st.anchorMode);
    const anchors = [...st.anchors].sort((a, b) => a.tau - b.tau);
    const setAnchors = (list) => { store.set({ anchors: list }); app.resuggest(); };
    lineEls = lines.map((l) => h('li.tline', { dataset: { g: l.g } },
      h('button.ghost.small.tc', { type: 'button', onclick: () => player.seek(l.g - 1, { play: true }), title: 'เล่นจากบรรทัดนี้' }, formatTime(l.g)),
      h('div.tl-text', l.speaker ? h('span.spk', `${l.speaker}: `) : null, l.text),
      h('button.ghost.icon-only.pin', { type: 'button', title: 'ปักหมุด: บรรทัดนี้เริ่มพูดตรงตำแหน่งเล่นตอนนี้', 'aria-label': 'ปักหมุดเวลา',
        onclick: () => { setAnchors([...s().anchors.filter((a) => a.tau !== l.tau), { id: newId('a'), tau: l.tau, g: Math.round(player.time * 10) / 10, lineIdx: l.idx }]); toast(`ปักหมุด: ${formatTime(l.tau)} ใน transcript = ${formatTime(player.time)} ในวิดีโอ`); } },
      icon('pin', 16))));
    currentLine = -1;

    const anchorRows = anchors.map((a) => h('li.anchor-row',
      h('span.tc', formatTime(a.tau)), h('span', '→'), h('button.ghost.small.tc', { type: 'button', onclick: () => player.seek(a.g - 1, { play: true }) }, formatTime(a.g, { decimals: 1 })),
      h('span.shift', `${a.g - a.tau >= 0 ? '+' : ''}${(a.g - a.tau).toFixed(1)} วิ`),
      h('button.ghost.icon-only', { type: 'button', 'aria-label': 'ลบหมุด', onclick: () => setAnchors(s().anchors.filter((x) => x.id !== a.id)) }, icon('trash', 15))));

    const silence = st.analysis?.silence;
    const propBox = proposals ? h('div.proposals',
      proposals.length ? h('ul', proposals.map((p) => h('li.anchor-row',
        h('span.tc', formatTime(p.tau)), h('span', '→'), h('span.tc', formatTime(p.g, { decimals: 1 })),
        h('span.shift', `${p.shift >= 0 ? '+' : ''}${p.shift.toFixed(1)} วิ`),
        h('button.ghost.small', { type: 'button', onclick: () => player.seek(p.g - 2, { play: true }) }, 'ฟัง'),
        h('button.secondary.small', { type: 'button', onclick: () => { proposals = proposals.filter((x) => x !== p); setAnchors([...s().anchors.filter((a) => a.tau !== p.tau), { id: newId('a'), tau: p.tau, g: p.g, lineIdx: p.lineIdx }]); } }, 'ใช้'))))
        : h('p.hint', 'ไม่พบจุดที่จับคู่ได้ชัดเจน')) : null;

    clear(sideBody,
      h('div.sync-head',
        h('p.hint', 'ถ้าบรรทัดที่ไฮไลต์ขึ้นก่อนหรือหลังเสียงจริง ให้เล่นวิดีโอ แล้วกดหมุดของบรรทัดนั้นตอนที่ได้ยินประโยคเริ่ม ปักหลายจุดได้ถ้าเวลาคลาดไม่เท่ากันทั้งไฟล์'),
        h('label.field.inline', h('span', 'ระหว่างหมุด'),
          h('select', { onchange: (e) => { store.set({ anchorMode: e.target.value }); app.resuggest(); } },
            h('option', { value: 'linear', selected: st.anchorMode === 'linear' }, 'ค่อย ๆ ไล่เวลา (เวลาคลาดสะสม)'),
            h('option', { value: 'step', selected: st.anchorMode === 'step' }, 'กระโดดที่หมุด (บันทึกถูกหยุดแล้วเริ่มใหม่)'))),
        anchors.length ? h('ul.anchor-list', anchorRows) : h('p.hint', 'ยังไม่มีหมุด ใช้เวลาตาม transcript ตรง ๆ'),
        silence ? h('button.secondary.small', { type: 'button', onclick: () => { proposals = proposeAnchors({ transcript: st.transcript, anchors: st.anchors, anchorMode: st.anchorMode, silence }); renderSync(); } }, icon('target', 15), 'หาหมุดจากจุดที่เสียงกลับมา') : null,
        propBox,
        h('label.tick.small', h('input', { type: 'checkbox', checked: follow, onchange: (e) => { follow = e.target.checked; } }), h('span', 'เลื่อนตามตำแหน่งเล่น'))),
      h('ol.tlines', lineEls));
  }

  function renderSide() {
    const st = s();
    segCuts.textContent = `ช่วงตัด (${st.cuts.length})`;
    segSync.textContent = 'Transcript และหมุดเวลา';
    segCuts.setAttribute('aria-selected', String(sideView === 'cuts'));
    segSync.setAttribute('aria-selected', String(sideView === 'sync'));
    if (sideView === 'cuts') renderCuts(); else renderSync();
  }

  function renderTimeline() {
    const st = s();
    timelineView.render({ timeline: tl, cuts: st.cuts, splits: st.splits, anchorsG: st.anchors.map((a) => a.g), selectedCutId: st.selectedCutId, effectiveEnd: (c) => eff(c).effectiveEnd });
    const plan = buildPlan(tl, st.cuts, st.splits);
    const undecided = st.cuts.filter((c) => c.status === 'suggested').length;
    clear(summary, `ผลลัพธ์ ${formatTime(plan.keptDuration)}${plan.parts.length > 1 ? ` ใน ${plan.parts.length} ไฟล์` : ''}`, undecided ? h('span.hint', ` · ยังไม่ได้ตัดสินใจ ${undecided} ช่วง`) : null);
  }

  // ---------- time updates ----------
  function onTime(t) {
    timeLabel.textContent = formatTime(t);
    timelineView.setTime(t);
    if (sideView === 'sync' && lineEls.length) {
      let lo = 0; let hi = lines.length - 1; let idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].g <= t + 0.05) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx !== currentLine) {
        lineEls[currentLine]?.classList.remove('now');
        currentLine = idx;
        const el = lineEls[idx];
        if (el) { el.classList.add('now'); if (follow) scrollWithin(sideBody, el, true); }
      }
    }
  }
  player.addEventListener('time', (e) => onTime(e.detail.t));
  player.addEventListener('state', () => clear(playBtn, icon(player.playing ? 'pause' : 'play', 20)));
  player.addEventListener('file', (e) => { fileTag.textContent = tl.files.length > 1 ? `ไฟล์ ${e.detail.index + 1}: ${tl.files[e.detail.index].name}` : ''; });

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const st = s();
    const idx = st.cuts.findIndex((c) => c.id === st.selectedCutId);
    const cur = st.cuts[idx];
    const k = e.key;
    const handled = () => e.preventDefault();
    if (k === ' ') { handled(); player.toggle(); } else if (k === 'ArrowLeft') { handled(); player.seek(player.time - (e.shiftKey ? 1 : 5)); } else if (k === 'ArrowRight') { handled(); player.seek(player.time + (e.shiftKey ? 1 : 5)); } else if (k === 'i' || k === 'I') { handled(); markInOut('in'); } else if (k === 'o' || k === 'O') { handled(); markInOut('out'); } else if (k === 's' || k === 'S') { handled(); addSplit(); } else if (k === 'j' || k === 'J') { handled(); const c = st.cuts[Math.max(0, idx - 1)]; if (c) select(c.id, true); } else if (k === 'k' || k === 'K') { handled(); const c = st.cuts[Math.min(st.cuts.length - 1, idx + 1)]; if (c) select(c.id, true); } else if (cur && (k === 'p' || k === 'P')) { handled(); preview(cur); } else if (cur && (k === 'a' || k === 'A')) { handled(); app.updateCuts((cs) => setStatus(cs, cur.id, 'accepted')); } else if (cur && (k === 'r' || k === 'R')) { handled(); app.updateCuts((cs) => setStatus(cs, cur.id, 'rejected')); } else if (cur && k === '[') { handled(); app.updateCuts((cs) => setEdge(cs, cur.id, 'start', player.time, tl.duration)); } else if (cur && k === ']') { handled(); app.updateCuts((cs) => setEdge(cs, cur.id, 'end', player.time, tl.duration)); }
  }
  document.addEventListener('keydown', onKey);
  const onResize = () => timelineView.resize();
  window.addEventListener('resize', onResize);

  // ---------- store wiring ----------
  let last = null;
  const unsub = store.subscribe((st) => {
    const sig = [st.cuts, st.splits, st.anchors, st.anchorMode, st.selectedCutId, st.transcript, st.videos];
    if (last && sig.every((v, i) => v === last[i])) return;
    const linesChanged = !last || last[2] !== sig[2] || last[3] !== sig[3] || last[5] !== sig[5];
    last = sig;
    tl = app.timeline();
    renderTimeline();
    if (sideView === 'cuts' || linesChanged) renderSide();
  });

  player.load(tl, s().videos.map((v) => v.url));
  renderTimeline();
  renderSide();
  last = [s().cuts, s().splits, s().anchors, s().anchorMode, s().selectedCutId, s().transcript, s().videos];
  const first = s().cuts.find((c) => c.id === s().selectedCutId) || s().cuts[0];
  if (first) player.seek(Math.max(0, first.start - seam));
  requestAnimationFrame(() => timelineView.resize());

  return () => {
    unsub();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    player.pause();
    video.removeAttribute('src');
    video.load();
  };
}
