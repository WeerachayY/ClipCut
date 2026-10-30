// Review screen: player, timeline with cut points, list of pieces to throw away, transcript sync.
import { h, clear, icon, toast } from './dom.js';
import { MultiPlayer } from './player.js';
import { TimelineView } from './timeline-view.js';
import { formatTime, formatDuration } from '../core/time.js';
import { buildPlan } from '../core/plan.js';
import * as C from '../core/cuts.js';
import { mapLines, proposeAnchors } from '../core/analysis.js';
import { newId } from '../core/store.js';

const BADGE = { delete: 'ทิ้ง', high: 'แนะนำให้ทิ้ง', check: 'ควรเช็ค', rejected: 'เก็บไว้' };
const kindOf = (p) => (p.status === 'delete' ? 'delete' : p.status === 'suggested' ? (p.confidence === 'high' ? 'high' : 'check') : p.decided && p.origin === 'auto' ? 'rejected' : 'keep');

export function mount(root, app) {
  const store = app.store;
  let tl = app.timeline();
  let sideView = 'pieces';
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
      h('button.secondary.mark-btn', { type: 'button', onclick: () => markHere(), title: 'ปุ่มลัด C' }, icon('scissors', 17), 'มาร์กจุดตัด', h('kbd', 'C'))),
    h('div.tp-group.tp-right',
      h('label.tick.small', skipBox, h('span', 'เล่นแบบผลลัพธ์ (ข้ามชิ้นที่ทิ้ง)')),
      seamSel,
      h('button.ghost.icon-only', { type: 'button', onclick: showKeys, 'aria-label': 'ปุ่มลัด' }, icon('keyboard'))));

  const timelineView = new TimelineView({
    onSeek: (t) => player.seek(t),
    onSelectPiece: (key) => select({ type: 'piece', key }),
    onActivatePiece: (key) => { select({ type: 'piece', key }); act('toggle'); },
    onSelectMark: (id) => { const m = mark(id); if (m) player.seek(m.at); select({ type: 'mark', id }); },
    onMoveMark: (id, t) => edit((e) => C.moveMark(e, id, t, tl.duration)),
    getPlayhead: () => player.time,
  });

  // ---------- side panel ----------
  const segPieces = h('button', { type: 'button', role: 'tab', onclick: () => { sideView = 'pieces'; renderSide(); } });
  const segSync = h('button', { type: 'button', role: 'tab', onclick: () => { sideView = 'sync'; renderSide(); } });
  const sideBody = h('div.side-body');
  const side = h('aside.rv-side', h('div.seg', { role: 'tablist' }, segPieces, segSync), sideBody);

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
  const D = () => tl.duration;
  const pieces = () => C.piecesOf(s().edit, D());
  const marks = () => [...s().edit.marks].sort((a, b) => a.at - b.at);
  const mark = (id) => s().edit.marks.find((m) => m.id === id);
  const piece = (key) => pieces().find((p) => p.key === key);
  const edit = (fn) => app.updateEdit(fn);
  /** where lossless export resumes after a thrown-away piece (keyframe at or before its end) */
  const resumeAt = (p) => Math.max(p.start, tl.snapDown(p.end));

  function skipRanges() {
    return pieces().filter((p) => p.status === 'delete').map((p) => ({ start: p.start, end: resumeAt(p) }));
  }
  function select(sel) {
    store.set({ selection: sel });
    if (sel && sel.type === 'piece') sideView = 'pieces';
  }
  function scrollWithin(container, el, center) {
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (center) container.scrollTop += r.top - c.top - (c.height - r.height) / 2;
    else if (r.top < c.top) container.scrollTop -= c.top - r.top + 8;
    else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom + 8;
  }

  function markHere({ split = false } = {}) {
    const t = player.time;
    const r = C.addMark(s().edit, t, D(), { split, label: split ? `ตอนที่ ${C.toPlanInput(s().edit, D()).splits.length + 2}` : '' });
    if (!r.id) { toast('ตรงนี้อยู่ต้นหรือท้ายวิดีโอ ไม่ต้องมาร์ก'); return; }
    store.set({ edit: r.edit, selection: { type: 'mark', id: r.id } });
  }

  function preview(p) {
    if (p.status === 'keep') { player.seek(p.start, { play: true }); return; }
    player.previewSeam(p.start, resumeAt(p), { before: seam, after: seam });
  }

  /** Commands on the current selection; used by buttons, the floating bar and shortcuts. */
  function act(cmd) {
    const sel = s().selection;
    if (!sel) return;
    if (sel.type === 'piece') {
      const p = piece(sel.key);
      if (!p) return;
      if (cmd === 'toggle') edit((e) => (p.status === 'suggested' ? C.setPieceStatus(e, p.key, 'delete') : C.togglePiece(e, p.key)));
      if (cmd === 'delete') edit((e) => C.setPieceStatus(e, p.key, 'delete'));
      if (cmd === 'keep') edit((e) => C.setPieceStatus(e, p.key, 'keep'));
      if (cmd === 'preview') preview(p);
      if (cmd === 'start-here' && p.leftMark) edit((e) => C.moveMark(e, p.leftMark.id, player.time, D()));
      if (cmd === 'end-here' && p.rightMark) edit((e) => C.moveMark(e, p.rightMark.id, player.time, D()));
    } else {
      const m = mark(sel.id);
      if (!m) return;
      if (cmd === 'join') {
        const left = pieces().find((p) => p.rightMark?.id === m.id);
        store.set({ edit: C.removeMark(s().edit, m.id), selection: left ? { type: 'piece', key: left.key } : null });
        toast('ต่อกลับเป็นชิ้นเดียวแล้ว (ชิ้นที่ต่อจะถูกเก็บไว้)');
      }
      if (cmd === 'split') edit((e) => C.setSplit(e, m.id, !m.split, m.label || `ตอนที่ ${C.toPlanInput(e, D()).splits.length + 2}`));
      if (cmd === 'preview') player.previewSeam(m.at, m.at, { before: seam, after: seam });
      if (cmd === 'here') edit((e) => C.moveMark(e, m.id, player.time, D()));
    }
  }

  function showKeys() {
    toast(h('div.keys',
      h('strong', 'ปุ่มลัด'),
      h('div', 'Space เล่น/หยุด · ← → 5 วิ · Shift+← → 1 วิ'),
      h('div', 'C หรือ B มาร์กจุดตัดที่ตำแหน่งเล่น'),
      h('div', 'คลิกชิ้นบน timeline เพื่อเลือก · ดับเบิลคลิกเพื่อทิ้ง/เก็บ'),
      h('div', 'Delete ทิ้ง/เก็บชิ้นที่เลือก หรือต่อกลับจุดตัดที่เลือก'),
      h('div', 'A ทิ้ง · R เก็บ · P ฟังรอยต่อ · J / K ชิ้นก่อน/ถัดไป'),
      h('div', 'S แยกไฟล์ที่จุดตัดที่เลือก · [ ] ขยับขอบชิ้นมาที่ตำแหน่งเล่น · Esc ยกเลิกการเลือก')), 'info', 14000);
  }

  // ---------- floating command bar ----------
  function toolbar() {
    const sel = s().selection;
    if (!sel) return null;
    const btn = (label, cmd, cls = 'secondary', ic) => h(`button.small.${cls}`, { type: 'button', onclick: () => act(cmd) }, ic ? icon(ic, 15) : null, label);
    if (sel.type === 'piece') {
      const p = piece(sel.key);
      if (!p) return null;
      const info = h('span.tb-info', `${formatTime(p.start)}–${formatTime(p.end)} · ${formatDuration(p.end - p.start)}`);
      if (p.status === 'delete') return { t: (p.start + p.end) / 2, el: h('div.tl-toolbar', info, btn('เก็บชิ้นนี้', 'keep'), btn('ฟังรอยต่อ', 'preview', 'secondary', 'ear')) };
      if (p.status === 'suggested') return { t: (p.start + p.end) / 2, el: h('div.tl-toolbar', info, btn('ทิ้ง', 'delete', 'danger-fill', 'scissors'), btn('เก็บ', 'keep'), btn('ฟังรอยต่อ', 'preview', 'secondary', 'ear')) };
      return { t: (p.start + p.end) / 2, el: h('div.tl-toolbar', info, btn('ทิ้งชิ้นนี้', 'delete', 'danger-fill', 'scissors')) };
    }
    const m = mark(sel.id);
    if (!m) return null;
    return {
      t: m.at,
      el: h('div.tl-toolbar',
        h('span.tb-info', `จุดตัด ${formatTime(m.at, { decimals: 1 })}`),
        btn('ต่อกลับ', 'join'),
        btn(m.split ? 'ยกเลิกแยกไฟล์' : 'แยกเป็นไฟล์ใหม่ตรงนี้', 'split', 'secondary', 'split'),
        h('button.ghost.small', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, -1, D())) }, '−1'),
        h('button.ghost.small', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, 1, D())) }, '+1'),
        btn('ฟัง', 'preview', 'ghost', 'ear')),
    };
  }

  // ---------- side: pieces ----------
  function edgeCtl(p, which) {
    const m = which === 'start' ? p.leftMark : p.rightMark;
    const label = which === 'start' ? 'จุดเริ่ม' : 'จุดจบ';
    if (!m) return h('div.edge', h('span.edge-label', label), h('span.hint', which === 'start' ? 'ต้นวิดีโอ' : 'ท้ายวิดีโอ'));
    return h('div.edge',
      h('span.edge-label', label),
      h('button.ghost.small', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, -5, D())) }, '−5'),
      h('button.ghost.small', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, -1, D())) }, '−1'),
      h('button.ghost.small.tc', { type: 'button', onclick: () => player.seek(m.at), title: 'ไปที่จุดนี้' }, formatTime(m.at, { decimals: 1 })),
      h('button.ghost.small', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, 1, D())) }, '+1'),
      h('button.ghost.small', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, 5, D())) }, '+5'),
      h('button.ghost.icon-only', { type: 'button', onclick: () => edit((e) => C.moveMark(e, m.id, player.time, D())), title: `ย้ายมาที่ตำแหน่งเล่น (ปุ่มลัด ${which === 'start' ? '[' : ']'})`, 'aria-label': `ย้าย${label}มาที่ตำแหน่งเล่น` }, icon('target', 16)),
      h('button.ghost.small', { type: 'button', onclick: () => { select({ type: 'mark', id: m.id }); act('join'); }, title: 'ลบจุดตัดนี้ ชิ้นสองข้างรวมกันและถูกเก็บไว้' }, 'ต่อกลับ'));
  }

  function pieceRow(p, selected) {
    const kind = kindOf(p);
    const resume = resumeAt(p);
    const shifted = p.end - resume;
    return h(`li.cut-row.${kind}${selected ? '.selected' : ''}`, { dataset: { key: p.key } },
      h('div.cut-head', { onclick: () => { select({ type: 'piece', key: p.key }); player.seek(p.start); } },
        h('span.badge', BADGE[kind] || 'เก็บ'),
        h('span.cut-time', `${formatTime(p.start)} – ${formatTime(p.end)}`),
        h('span.cut-len', formatDuration(p.end - p.start))),
      p.reasons.length ? h('div.cut-reasons', p.reasons.join(' · ')) : h('div.cut-reasons', p.origin === 'auto' ? '' : 'มาร์กเอง'),
      h('div.cut-actions',
        h('button.secondary.small', { type: 'button', onclick: () => { select({ type: 'piece', key: p.key }); preview(p); }, title: 'ปุ่มลัด P' }, icon('ear', 16), 'ฟังรอยต่อ'),
        h(`button.small.${p.status === 'delete' ? 'on-cut' : 'secondary'}`, { type: 'button', 'aria-pressed': String(p.status === 'delete'), onclick: () => edit((e) => C.setPieceStatus(e, p.key, 'delete')) }, icon('scissors', 15), 'ทิ้ง'),
        h(`button.small.${kind === 'rejected' || (p.decided && p.status === 'keep') ? 'on-keep' : 'secondary'}`, { type: 'button', onclick: () => edit((e) => C.setPieceStatus(e, p.key, 'keep')) }, 'เก็บ')),
      selected ? h('div.cut-edit',
        edgeCtl(p, 'start'),
        edgeCtl(p, 'end'),
        p.status === 'delete' && shifted > 0.05 && shifted < p.end - p.start - 0.05
          ? h('p.hint', `แบบไม่บีบอัด วิดีโอจะกลับมาเล่นที่ ${formatTime(resume, { decimals: 1 })} (เร็วกว่าจุดจบ ${shifted.toFixed(1)} วิ ตาม keyframe เพื่อไม่ให้เนื้อหาหาย) แบบบีบอัดตัดตรงจุดเป๊ะ`) : null,
        p.status === 'delete' && resume - p.start < 0.1
          ? h('p.warn', icon('alert', 16), 'ชิ้นนี้สั้นกว่าระยะห่างของ keyframe แบบไม่บีบอัดจะตัดชิ้นนี้ไม่ได้ ถ้าต้องการตัดให้ส่งออกแบบบีบอัด') : null) : null);
  }

  function renderPieces() {
    const st = s();
    const ps = C.piecesOf(st.edit, D());
    const n = C.counts(st.edit, D());
    const { cuts, splits } = C.toPlanInput(st.edit, D());
    const plan = buildPlan(tl, cuts, splits);
    const listed = ps.filter((p) => kindOf(p) !== 'keep' || (st.selection?.type === 'piece' && st.selection.key === p.key));
    const sel = st.selection;
    const splitMarks = marks().filter((m) => m.split);
    clear(sideBody,
      h('div.cut-summary',
        h('div.big-num', formatTime(plan.removedDuration), h('span', ' ทิ้ง')),
        h('div.hint', `เหลือ ${formatTime(plan.keptDuration)} จาก ${formatTime(tl.duration)}${plan.parts.length > 1 ? ` · ${plan.parts.length} ไฟล์` : ''}`),
        h('div.hint', `จุดตัด ${n.marks} · ทิ้ง ${n.delete} ชิ้น · รอตัดสินใจ ${n.suggested} · เก็บไว้ ${n.rejected}`),
        n.high ? h('button.secondary.small', { type: 'button', onclick: () => edit((e) => C.deleteAllSuggested(e)) }, icon('check', 15), `ทิ้งทุกชิ้นที่แนะนำ (${n.high})`) : null),
      listed.length
        ? h('ul.cut-list', listed.map((p) => pieceRow(p, sel?.type === 'piece' && sel.key === p.key)))
        : h('div.empty-how',
          h('p', h('strong', 'ยังไม่มีชิ้นที่จะทิ้ง')),
          h('ol',
            h('li', 'เล่นวิดีโอไปถึงจุดที่จะผ่า แล้วกด “มาร์กจุดตัด” (C)'),
            h('li', 'ผ่าอีกจุดที่ปลายช่วงที่ไม่ต้องการ'),
            h('li', 'คลิกชิ้นตรงกลางบน timeline แล้วกด “ทิ้งชิ้นนี้”'))),
      h('h3', 'แยกเป็นหลายไฟล์'),
      splitMarks.length
        ? h('ul.split-list', splitMarks.map((m) => h('li.split-row',
          h('button.ghost.small.tc', { type: 'button', onclick: () => { player.seek(m.at); select({ type: 'mark', id: m.id }); } }, formatTime(m.at)),
          h('input', { type: 'text', value: m.label || '', 'aria-label': 'ชื่อไฟล์ช่วงนี้', onchange: (e) => edit((x) => C.setMarkLabel(x, m.id, e.target.value)) }),
          h('button.ghost.small', { type: 'button', title: 'ยกเลิกแยกไฟล์ (จุดตัดยังอยู่)', onclick: () => edit((x) => C.setSplit(x, m.id, false)) }, 'ยกเลิก'))))
        : h('p.hint', 'คลิกจุดตัดบน timeline แล้วเลือก “แยกเป็นไฟล์ใหม่ตรงนี้” เพื่อให้ส่งออกเป็นหลายไฟล์ เช่น แยกตามหัวข้อ'));
    const selEl = sideBody.querySelector('.cut-row.selected');
    if (selEl) scrollWithin(sideBody, selEl, false);
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
    const n = C.counts(st.edit, D());
    segPieces.textContent = `ชิ้นที่ทิ้ง (${n.delete + n.suggested})`;
    segSync.textContent = 'Transcript และหมุดเวลา';
    segPieces.setAttribute('aria-selected', String(sideView === 'pieces'));
    segSync.setAttribute('aria-selected', String(sideView === 'sync'));
    if (sideView === 'pieces') renderPieces(); else renderSync();
  }

  function renderTimeline() {
    const st = s();
    const ps = C.piecesOf(st.edit, D());
    // faint ticks where a lossless export really resumes after a thrown-away piece
    const ticks = ps.filter((p) => p.status === 'delete').map((p) => ({ t: resumeAt(p), end: p.end })).filter((x) => x.t < x.end - 0.05).map((x) => x.t);
    timelineView.render({ timeline: tl, pieces: ps, marks: marks(), selection: st.selection, anchorsG: st.anchors.map((a) => a.g), ticks });
    const tb = toolbar();
    timelineView.showToolbar(tb?.el || null, tb?.t || 0);
    const { cuts, splits } = C.toPlanInput(st.edit, D());
    const plan = buildPlan(tl, cuts, splits);
    const n = C.counts(st.edit, D());
    clear(summary, `ผลลัพธ์ ${formatTime(plan.keptDuration)}${plan.parts.length > 1 ? ` ใน ${plan.parts.length} ไฟล์` : ''}`, n.suggested ? h('span.hint', ` · รอตัดสินใจ ${n.suggested} ชิ้น`) : null);
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
    const k = e.key;
    const st = s();
    const sel = st.selection;
    const handled = () => e.preventDefault();
    const nav = (dir) => {
      const list = C.piecesOf(st.edit, D()).filter((p) => kindOf(p) !== 'keep');
      if (!list.length) return;
      const cur = sel?.type === 'piece' ? list.findIndex((p) => p.key === sel.key) : -1;
      const next = list[cur < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + dir))];
      select({ type: 'piece', key: next.key });
      player.seek(next.start);
    };
    if (k === ' ') { handled(); player.toggle(); }
    else if (k === 'ArrowLeft') { handled(); player.seek(player.time - (e.shiftKey ? 1 : 5)); }
    else if (k === 'ArrowRight') { handled(); player.seek(player.time + (e.shiftKey ? 1 : 5)); }
    else if (k === 'c' || k === 'C' || k === 'b' || k === 'B') { handled(); markHere(); }
    else if (k === 'Escape') { handled(); select(null); }
    else if (k === 'j' || k === 'J') { handled(); nav(-1); }
    else if (k === 'k' || k === 'K') { handled(); nav(1); }
    else if (k === 's' || k === 'S') { handled(); if (sel?.type === 'mark') act('split'); else markHere({ split: true }); }
    else if (!sel) { /* the rest need a selection */ }
    else if (k === 'Delete' || k === 'Backspace' || k === 'x' || k === 'X') { handled(); act(sel.type === 'mark' ? 'join' : 'toggle'); }
    else if (k === 'p' || k === 'P') { handled(); act('preview'); }
    else if (sel.type === 'piece' && (k === 'a' || k === 'A')) { handled(); act('delete'); }
    else if (sel.type === 'piece' && (k === 'r' || k === 'R')) { handled(); act('keep'); }
    else if (sel.type === 'piece' && k === '[') { handled(); act('start-here'); }
    else if (sel.type === 'piece' && k === ']') { handled(); act('end-here'); }
  }
  document.addEventListener('keydown', onKey);
  const onResize = () => { timelineView.resize(); renderTimeline(); };
  window.addEventListener('resize', onResize);

  // ---------- store wiring ----------
  let last = null;
  const unsub = store.subscribe((st) => {
    const sig = [st.edit, st.anchors, st.anchorMode, st.selection, st.transcript, st.videos];
    if (last && sig.every((v, i) => v === last[i])) return;
    const linesChanged = !last || last[1] !== sig[1] || last[2] !== sig[2] || last[4] !== sig[4];
    last = sig;
    tl = app.timeline();
    // drop a selection that no longer exists (e.g. after joining)
    if (st.selection && ((st.selection.type === 'piece' && !piece(st.selection.key)) || (st.selection.type === 'mark' && !mark(st.selection.id)))) {
      store.set({ selection: null });
      return;
    }
    renderTimeline();
    if (sideView === 'pieces' || linesChanged) renderSide();
  });

  player.load(tl, s().videos.map((v) => v.url));
  renderTimeline();
  renderSide();
  last = [s().edit, s().anchors, s().anchorMode, s().selection, s().transcript, s().videos];
  const firstPiece = C.piecesOf(s().edit, D()).find((p) => kindOf(p) !== 'keep');
  if (firstPiece) player.seek(Math.max(0, firstPiece.start - seam));
  requestAnimationFrame(() => { timelineView.resize(); renderTimeline(); });

  return () => {
    unsub();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    player.pause();
    video.removeAttribute('src');
    video.load();
  };
}
