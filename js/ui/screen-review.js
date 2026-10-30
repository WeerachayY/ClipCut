// Review screen: player, timeline with cut points, list of pieces to throw away, transcript sync.
import { h, clear, icon, toast, ask } from './dom.js';
import { MultiPlayer } from './player.js';
import { TimelineView } from './timeline-view.js';
import { formatTime, formatDuration, formatTimecode } from '../core/time.js';
import { buildPlan } from '../core/plan.js';
import * as C from '../core/cuts.js';
import { mapLines, proposeAnchors } from '../core/analysis.js';
import { newId } from '../core/store.js';

const BADGE = { delete: 'ทิ้ง', high: 'แนะนำให้ทิ้ง', check: 'ควรเช็ค', rejected: 'เก็บไว้' };
// [keys, what it does, how CapCut does it (true = same)]
const SHORTCUTS = [
  ['Space', 'เล่น / หยุด', true],
  ['← / →', 'ถอย / ไปข้างหน้า 1 เฟรม', true],
  ['Shift + ← / Shift + →', 'ถอย / ไปข้างหน้า 1 วินาที', 'CapCut ขยับ 5 เฟรม'],
  ['Ctrl + ← / Ctrl + →', 'ถอย / ไปข้างหน้า 10 วินาที', null],
  ['Home / End', 'ไปต้น / ท้ายวิดีโอ', true],
  ['↑ / ↓', 'ไปจุดตัดก่อนหน้า / ถัดไป', 'เหมือนกัน (edit point)'],
  ['K / L', 'หยุด / เล่น (กด L ซ้ำเพื่อเร่ง 1.5× 2× 4×)', 'เหมือนกัน (J เล่นถอยหลังยังไม่รองรับ)'],
  ['C / B / Ctrl + B', 'มาร์กจุดตัดที่ตำแหน่งเล่น', 'Ctrl + B'],
  ['Q', 'ทิ้งส่วนก่อนตำแหน่งเล่นในชิ้นนั้น', true],
  ['W', 'ทิ้งส่วนหลังตำแหน่งเล่นในชิ้นนั้น', true],
  ['Delete / Backspace', 'ทิ้ง/เก็บชิ้นที่เลือก หรือต่อกลับจุดตัดที่เลือก', 'Delete = ลบคลิปที่เลือก'],
  ['Ctrl + Z', 'ย้อนกลับ', true],
  ['Ctrl + Shift + Z / Ctrl + Y', 'ทำซ้ำ', true],
  ['Ctrl + = / Ctrl + -', 'ซูม timeline เข้า / ออก (หรือ Ctrl + ล้อเมาส์)', true],
  ['Ctrl + 0', 'timeline พอดีจอ', true],
  [', / .', 'ขยับจุดตัดที่เลือก 1 เฟรม', null],
  ['Shift + , / Shift + .', 'ขยับจุดตัดที่เลือก 1 วินาที', null],
  ['A / R', 'ทิ้ง / เก็บ ชิ้นที่เลือก', null],
  ['S', 'แยกเป็นไฟล์ใหม่ที่จุดตัด', null],
  ['P', 'ฟังรอยต่อ', null],
  ['Shift + ↑ / Shift + ↓', 'ชิ้นที่ทิ้งหรือแนะนำ ก่อนหน้า / ถัดไป', null],
  ['[ / ]', 'ย้ายขอบเริ่ม / จบของชิ้นมาที่ตำแหน่งเล่น', null],
  ['Esc', 'ยกเลิกการเลือก', null],
  ['?', 'เปิดหน้านี้', null],
];

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
  const timeLabel = h('span.time-now', '0:00:00:00');
  const playBtn = h('button.primary.icon-only.play', { type: 'button', onclick: () => player.toggle(), 'aria-label': 'เล่น/หยุด', 'data-tip': 'เล่น / หยุด · Space' }, icon('play', 20));
  const skipBox = h('input', { type: 'checkbox', onchange: (e) => { player.skipRanges = e.target.checked ? skipRanges : null; } });
  const rateSel = h('select', { 'aria-label': 'ความเร็ว', onchange: (e) => player.setRate(Number(e.target.value)) },
    ['1', '1.5', '2', '4'].map((r) => h('option', { value: r }, `${r}×`)));
  const seamSel = h('select', { 'aria-label': 'ระยะฟังรอยต่อ', onchange: (e) => { seam = Number(e.target.value); } },
    [3, 5, 10].map((v) => h('option', { value: String(v), selected: v === seam }, `ฟังรอยต่อ ±${v} วิ`)));
  const BIG = 10; // seconds for Ctrl+arrow
  const tbtn = (ic, tip, fn) => h('button.tp-btn', { type: 'button', onclick: fn, 'aria-label': tip.split(' · ')[0], 'data-tip': tip }, icon(ic, 18));
  const undoBtn = h('button.tp-btn', { type: 'button', onclick: () => app.undo(), 'aria-label': 'ย้อนกลับ', 'data-tip': 'ย้อนกลับ · Ctrl Z' }, icon('undo', 18));
  const redoBtn = h('button.tp-btn', { type: 'button', onclick: () => app.redo(), 'aria-label': 'ทำซ้ำ', 'data-tip': 'ทำซ้ำ · Ctrl Shift Z' }, icon('redo', 18));

  const transport = h('div.transport',
    h('div.tp-group.tp-nav',
      tbtn('toStart', 'ไปต้นวิดีโอ · Home', () => player.seek(0)),
      tbtn('chev3L', `ถอย ${BIG} วินาที · Ctrl ←`, () => player.jump(-BIG)),
      tbtn('chev2L', 'ถอย 1 วินาที · Shift ←', () => player.jump(-1)),
      tbtn('chev1L', 'ถอย 1 เฟรม · ←', () => player.stepFrames(-1)),
      playBtn,
      tbtn('chev1R', 'ไปข้างหน้า 1 เฟรม · →', () => player.stepFrames(1)),
      tbtn('chev2R', 'ไปข้างหน้า 1 วินาที · Shift →', () => player.jump(1)),
      tbtn('chev3R', `ไปข้างหน้า ${BIG} วินาที · Ctrl →`, () => player.jump(BIG)),
      tbtn('toEnd', 'ไปท้ายวิดีโอ · End', () => player.seek(tl.duration)),
      h('span.time', timeLabel, h('span.time-total', ` / ${formatTimecode(tl.duration, tl.fps)}`)),
      h('span.fps', { 'data-tip': 'อัตราเฟรมของวิดีโอ ปุ่ม ← → เดินทีละเฟรมตามนี้' }, `${tl.fps} fps`)),
    h('div.tp-group',
      h('button.secondary.mark-btn', { type: 'button', onclick: () => markHere(), 'data-tip': 'ผ่าที่ตำแหน่งเล่น · C หรือ Ctrl B' }, icon('scissors', 17), 'มาร์กจุดตัด', h('kbd', 'C')),
      undoBtn, redoBtn,
      rateSel),
    h('div.tp-group.tp-right',
      h('label.tick.small', skipBox, h('span', 'เล่นแบบผลลัพธ์ (ข้ามชิ้นที่ทิ้ง)')),
      seamSel,
      h('button.tp-btn', { type: 'button', onclick: showKeys, 'aria-label': 'ปุ่มลัด', 'data-tip': 'ปุ่มลัดทั้งหมด · ?' }, icon('keyboard', 18))));

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

  const fps = () => tl.fps || 30;
  const tc = (t) => formatTimecode(t, fps(), { short: tl.duration < 3600 });
  /** cut points always sit on a frame boundary */
  const frameAt = (t) => Math.round(t * fps()) / fps();

  function markHere({ split = false } = {}) {
    const t = frameAt(player.time);
    const r = C.addMark(s().edit, t, D(), { split, label: split ? `ตอนที่ ${C.toPlanInput(s().edit, D()).splits.length + 2}` : '' });
    if (!r.id) { toast('ตรงนี้อยู่ต้นหรือท้ายวิดีโอ ไม่ต้องมาร์ก'); return; }
    app.commitEdit(r.edit, { selection: { type: 'mark', id: r.id } });
  }

  /** CapCut Q / W: throw away the part of the current piece left / right of the playhead. */
  function trim(side) {
    const t = frameAt(player.time);
    let e = s().edit;
    e = C.addMark(e, t, D()).edit;
    const ps = C.piecesOf(e, D());
    const target = side === 'left'
      ? ps.find((p) => Math.abs(p.end - t) < 0.06 || (t >= D() - 0.06 && p.end === D()))
      : ps.find((p) => Math.abs(p.start - t) < 0.06 || (t <= 0.06 && p.start === 0));
    if (!target) return;
    app.commitEdit(C.setPieceStatus(e, target.key, 'delete'), { selection: { type: 'piece', key: target.key } });
    toast(side === 'left' ? 'ทิ้งส่วนก่อนตำแหน่งเล่นในชิ้นนี้แล้ว' : 'ทิ้งส่วนหลังตำแหน่งเล่นในชิ้นนี้แล้ว');
  }

  /** Up / Down: previous / next cut point (CapCut: previous / next edit point) */
  function gotoMark(dir) {
    const t = player.time;
    const list = marks();
    const m = dir < 0 ? [...list].reverse().find((x) => x.at < t - 0.5 / fps()) : list.find((x) => x.at > t + 0.5 / fps());
    if (!m) { player.seek(dir < 0 ? 0 : D()); return; }
    player.seek(m.at);
    select({ type: 'mark', id: m.id });
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
      if (cmd === 'start-here' && p.leftMark) edit((e) => C.moveMark(e, p.leftMark.id, frameAt(player.time), D()));
      if (cmd === 'end-here' && p.rightMark) edit((e) => C.moveMark(e, p.rightMark.id, frameAt(player.time), D()));
    } else {
      const m = mark(sel.id);
      if (!m) return;
      if (cmd === 'join') {
        const left = pieces().find((p) => p.rightMark?.id === m.id);
        app.commitEdit(C.removeMark(s().edit, m.id), { selection: left ? { type: 'piece', key: left.key } : null });
        toast('ต่อกลับเป็นชิ้นเดียวแล้ว (ชิ้นที่ต่อจะถูกเก็บไว้)');
      }
      if (cmd === 'split') edit((e) => C.setSplit(e, m.id, !m.split, m.label || `ตอนที่ ${C.toPlanInput(e, D()).splits.length + 2}`));
      if (cmd === 'preview') player.previewSeam(m.at, m.at, { before: seam, after: seam });
      if (cmd === 'here') edit((e) => C.moveMark(e, m.id, frameAt(player.time), D()));
      if (cmd === 'nudge-frame-') edit((e) => C.nudgeMark(e, m.id, -1 / fps(), D()));
      if (cmd === 'nudge-frame+') edit((e) => C.nudgeMark(e, m.id, 1 / fps(), D()));
      if (cmd === 'nudge-sec-') edit((e) => C.nudgeMark(e, m.id, -1, D()));
      if (cmd === 'nudge-sec+') edit((e) => C.nudgeMark(e, m.id, 1, D()));
    }
  }

  function showKeys() {
    const rows = SHORTCUTS.map(([keys, what, capcut]) => h('tr',
      h('td', keys.split(' / ').map((k, i) => [i ? ' / ' : '', ...k.split(' + ').map((x, j) => [j ? ' + ' : '', h('kbd', x)])])),
      h('td', what),
      h('td.cc', capcut === true ? 'เหมือนกัน' : capcut || '—')));
    ask({
      title: 'ปุ่มลัด',
      body: h('div.keys-wrap', h('table.keys-table', h('thead', h('tr', h('th', 'ปุ่ม'), h('th', 'ทำอะไร'), h('th', 'เทียบ CapCut'))), h('tbody', rows))),
      buttons: [{ label: 'ปิด', value: 'close', kind: 'primary' }],
    });
  }

  // ---------- floating command bar ----------
  function toolbar() {
    const sel = s().selection;
    if (!sel) return null;
    const btn = (label, cmd, cls = 'secondary', ic) => h(`button.small.${cls}`, { type: 'button', onclick: () => act(cmd) }, ic ? icon(ic, 15) : null, label);
    if (sel.type === 'piece') {
      const p = piece(sel.key);
      if (!p) return null;
      const info = h('span.tb-info', `${tc(p.start)} – ${tc(p.end)} · ${formatDuration(p.end - p.start)}`);
      if (p.status === 'delete') return { t: (p.start + p.end) / 2, el: h('div.tl-toolbar', info, btn('เก็บชิ้นนี้', 'keep'), btn('ฟังรอยต่อ', 'preview', 'secondary', 'ear')) };
      if (p.status === 'suggested') return { t: (p.start + p.end) / 2, el: h('div.tl-toolbar', info, btn('ทิ้ง', 'delete', 'danger-fill', 'scissors'), btn('เก็บ', 'keep'), btn('ฟังรอยต่อ', 'preview', 'secondary', 'ear')) };
      return { t: (p.start + p.end) / 2, el: h('div.tl-toolbar', info, btn('ทิ้งชิ้นนี้', 'delete', 'danger-fill', 'scissors')) };
    }
    const m = mark(sel.id);
    if (!m) return null;
    return {
      t: m.at,
      el: h('div.tl-toolbar',
        h('span.tb-info', `จุดตัด ${tc(m.at)}`),
        h('button.small.secondary', { type: 'button', onclick: () => act('join'), 'data-tip': 'ลบจุดตัด ชิ้นสองข้างรวมกันและถูกเก็บไว้ · Delete' }, 'ต่อกลับ'),
        h('button.small.secondary', { type: 'button', onclick: () => act('split'), 'data-tip': 'ส่งออกเป็นไฟล์ใหม่ตั้งแต่จุดนี้ · S' }, icon('split', 15), m.split ? 'ยกเลิกแยกไฟล์' : 'แยกเป็นไฟล์ใหม่ตรงนี้'),
        h('span.tb-sep'),
        h('button.tp-btn.sm', { type: 'button', onclick: () => act('nudge-sec-'), 'data-tip': 'ขยับซ้าย 1 วินาที · Shift ,' }, icon('chev2L', 15)),
        h('button.tp-btn.sm', { type: 'button', onclick: () => act('nudge-frame-'), 'data-tip': 'ขยับซ้าย 1 เฟรม · ,' }, icon('chev1L', 15)),
        h('button.tp-btn.sm', { type: 'button', onclick: () => act('nudge-frame+'), 'data-tip': 'ขยับขวา 1 เฟรม · .' }, icon('chev1R', 15)),
        h('button.tp-btn.sm', { type: 'button', onclick: () => act('nudge-sec+'), 'data-tip': 'ขยับขวา 1 วินาที · Shift .' }, icon('chev2R', 15)),
        h('span.tb-sep'),
        h('button.small.ghost', { type: 'button', onclick: () => act('preview'), 'data-tip': 'ฟังรอบจุดนี้ · P' }, icon('ear', 15), 'ฟัง')),
    };
  }

  // ---------- side: pieces ----------
  function edgeCtl(p, which) {
    const m = which === 'start' ? p.leftMark : p.rightMark;
    const label = which === 'start' ? 'จุดเริ่ม' : 'จุดจบ';
    if (!m) return h('div.edge', h('span.edge-label', label), h('span.hint', which === 'start' ? 'ต้นวิดีโอ' : 'ท้ายวิดีโอ'));
    return h('div.edge',
      h('span.edge-label', label),
      h('button.tp-btn.sm', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, -1, D())), 'data-tip': 'ขยับ −1 วินาที' }, icon('chev2L', 14)),
      h('button.tp-btn.sm', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, -1 / fps(), D())), 'data-tip': 'ขยับ −1 เฟรม' }, icon('chev1L', 14)),
      h('button.ghost.small.tc', { type: 'button', onclick: () => player.seek(m.at), 'data-tip': 'ไปที่จุดนี้' }, tc(m.at)),
      h('button.tp-btn.sm', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, 1 / fps(), D())), 'data-tip': 'ขยับ +1 เฟรม' }, icon('chev1R', 14)),
      h('button.tp-btn.sm', { type: 'button', onclick: () => edit((e) => C.nudgeMark(e, m.id, 1, D())), 'data-tip': 'ขยับ +1 วินาที' }, icon('chev2R', 14)),
      h('button.tp-btn.sm', { type: 'button', onclick: () => edit((e) => C.moveMark(e, m.id, frameAt(player.time), D())), 'data-tip': `ย้ายมาที่ตำแหน่งเล่น · ${which === 'start' ? '[' : ']'}`, 'aria-label': `ย้าย${label}มาที่ตำแหน่งเล่น` }, icon('target', 15)),
      h('button.ghost.small', { type: 'button', onclick: () => { select({ type: 'mark', id: m.id }); act('join'); }, 'data-tip': 'ลบจุดตัดนี้ ชิ้นสองข้างรวมกันและถูกเก็บไว้' }, 'ต่อกลับ'));
  }

  function pieceRow(p, selected) {
    const kind = kindOf(p);
    const resume = resumeAt(p);
    const shifted = p.end - resume;
    return h(`li.cut-row.${kind}${selected ? '.selected' : ''}`, { dataset: { key: p.key } },
      h('div.cut-head', { onclick: () => { select({ type: 'piece', key: p.key }); player.seek(p.start); } },
        h('span.badge', BADGE[kind] || 'เก็บ'),
        h('span.cut-time', `${tc(p.start)} – ${tc(p.end)}`),
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
          ? h('p.hint', `แบบไม่บีบอัด วิดีโอจะกลับมาเล่นที่ ${tc(resume)} (เร็วกว่าจุดจบ ${shifted.toFixed(1)} วิ ตาม keyframe เพื่อไม่ให้เนื้อหาหาย) แบบบีบอัดตัดตรงจุดเป๊ะ`) : null,
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
    timeLabel.textContent = formatTimecode(t, fps());
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

  // ---------- keyboard (aligned with CapCut where CapCut has the same action) ----------
  const RATES = [1, 1.5, 2, 4];
  function setRate(r) { player.setRate(r); rateSel.value = String(r); }
  function nav(dir) {
    const sel = s().selection;
    const list = C.piecesOf(s().edit, D()).filter((p) => kindOf(p) !== 'keep');
    if (!list.length) return;
    const cur = sel?.type === 'piece' ? list.findIndex((p) => p.key === sel.key) : -1;
    const next = list[cur < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + dir))];
    select({ type: 'piece', key: next.key });
    player.seek(next.start);
  }
  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const { shiftKey: shift, altKey: alt } = e;
    const sel = s().selection;
    const done = () => e.preventDefault();
    const lower = k.length === 1 ? k.toLowerCase() : k;

    if (ctrl && lower === 'z') { done(); if (shift) app.redo(); else app.undo(); return; }
    if (ctrl && lower === 'y') { done(); app.redo(); return; }
    if (ctrl && (k === '=' || k === '+')) { done(); timelineView.zoomIn(); return; }
    if (ctrl && (k === '-' || k === '_')) { done(); timelineView.zoomOut(); return; }
    if (ctrl && k === '0') { done(); timelineView.setZoom(0); return; }
    if (ctrl && lower === 'b') { done(); markHere(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (alt) return; // Alt+arrow is the browser's back/forward
      done();
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (ctrl) player.jump(dir * BIG); else if (shift) player.jump(dir); else player.stepFrames(dir);
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') { done(); const dir = k === 'ArrowUp' ? -1 : 1; if (shift) nav(dir); else gotoMark(dir); return; }
    if (ctrl || alt) return; // leave other browser shortcuts alone

    if (k === ' ') { done(); player.toggle(); return; }
    if (k === 'Home') { done(); player.seek(0); return; }
    if (k === 'End') { done(); player.seek(D()); return; }
    if (lower === 'c' || lower === 'b') { done(); markHere(); return; }
    if (lower === 'q') { done(); trim('left'); return; }
    if (lower === 'w') { done(); trim('right'); return; }
    if (lower === 'k') { done(); player.pause(); setRate(1); return; }
    if (lower === 'l') { done(); if (!player.playing) { setRate(1); player.play(); } else setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(player.video.playbackRate) + 1)] || 1); return; }
    if (k === 'Escape') { done(); select(null); return; }
    if (k === '?') { done(); showKeys(); return; }
    if (lower === 's') { done(); if (sel?.type === 'mark') act('split'); else markHere({ split: true }); return; }
    if (!sel) return;
    if (k === 'Delete' || k === 'Backspace' || lower === 'x') { done(); act(sel.type === 'mark' ? 'join' : 'toggle'); return; }
    if (lower === 'p') { done(); act('preview'); return; }
    if (sel.type === 'mark' && (k === ',' || k === '<')) { done(); act(shift || k === '<' ? 'nudge-sec-' : 'nudge-frame-'); return; }
    if (sel.type === 'mark' && (k === '.' || k === '>')) { done(); act(shift || k === '>' ? 'nudge-sec+' : 'nudge-frame+'); return; }
    if (sel.type === 'piece' && lower === 'a') { done(); act('delete'); return; }
    if (sel.type === 'piece' && lower === 'r') { done(); act('keep'); return; }
    if (sel.type === 'piece' && k === '[') { done(); act('start-here'); return; }
    if (sel.type === 'piece' && k === ']') { done(); act('end-here'); }
  }
  document.addEventListener('keydown', onKey);
  const onResize = () => { timelineView.resize(); renderTimeline(); };
  window.addEventListener('resize', onResize);

  // ---------- store wiring ----------
  let last = null;
  const unsub = store.subscribe((st) => {
    undoBtn.disabled = !app.canUndo();
    redoBtn.disabled = !app.canRedo();
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
  undoBtn.disabled = !app.canUndo();
  redoBtn.disabled = !app.canRedo();
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
