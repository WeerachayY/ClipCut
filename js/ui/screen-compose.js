// Step "แต่ง": make the cut video nicer, CapCut style. Text and hooks, pictures and logos, overlay video
// above the recording; music and voice below it (ducked under speech); speed and speed curves per piece.
// Everything sits on the program clock (core/program.js), previewed live with the same drawing code the
// export uses (render/draw.js), and kept in store.compose (core/compose.js).
import { h, clear, icon, toast, ask, busy } from './dom.js';
import { ProgramPlayer } from './program-player.js';
import { ComposeTimeline } from './compose-timeline.js';
import { speedEditor, curveThumb } from './speed-editor.js';
import { FrameSource } from '../media/frames.js';
import { formatTime, formatDuration } from '../core/time.js';
import * as K from '../core/compose.js';
import { CURVES, normalizeSpeed, speedMap, isNormal, curvePoints, SPEED_MIN, SPEED_MAX } from '../core/speed.js';
import { piecesOf } from '../core/cuts.js';
import { kindOfFile } from '../render/assets.js';

const SHORTCUTS = [
  ['Space', 'เล่น / หยุด'],
  ['← / →', 'ถอย / ไปข้างหน้า 1 เฟรม'],
  ['Shift + ← / Shift + →', 'ถอย / ไปข้างหน้า 1 วินาที'],
  ['Home / End', 'ไปต้น / ท้าย'],
  ['Ctrl + B หรือ S', 'แยกคลิปที่เลือกตรงตำแหน่งเล่น'],
  ['Delete / Backspace', 'ลบคลิปที่เลือก'],
  ['Ctrl + D', 'ทำซ้ำคลิปที่เลือก'],
  ['T', 'ใส่ข้อความที่ตำแหน่งเล่น'],
  ['Ctrl + Z / Ctrl + Shift + Z', 'ย้อนกลับ / ทำซ้ำ'],
  ['Ctrl + = / Ctrl + - / Ctrl + 0', 'ซูม timeline เข้า / ออก / พอดีจอ'],
  ['Esc', 'ยกเลิกการเลือก'],
  ['?', 'เปิดหน้านี้'],
];

const pct = (v) => `${Math.round(v * 100)}%`;
const secs = (v) => `${(+v).toFixed(1)} วิ`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** '#rrggbb' and 0..1 from any colour the presets use ('#abc', '#aabbcc', 'rgba(r,g,b,a)'). */
function splitColor(c) {
  const m = String(c || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
  if (m) return { hex: `#${[m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')}`, a: m[4] != null ? +m[4] : 1 };
  let hex = String(c || '#000000');
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = `#${[...hex.slice(1)].map((x) => x + x).join('')}`;
  return { hex: /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000', a: 1 };
}
const joinColor = (hex, a) => {
  if (a >= 0.999) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${+a.toFixed(2)})`;
};

export function mount(root, app) {
  const store = app.store;
  const tl = app.timeline();
  const audioOnly = tl.kind === 'audio';
  const fps = tl.fps || 30;
  let sel = null; // {type:'clip', id} | {type:'piece', key}
  let built = { key: null, program: null };
  let sideMade = null; // the composition as the side panel last left it (its own change: no rebuild)

  const compose = () => store.get().compose || K.emptyCompose();
  const program = () => {
    const st = store.get();
    const key = [st.edit, st.arrange, st.compose?.speed, st.videos];
    if (!built.key || !key.every((v, i) => v === built.key[i])) built = { key, program: app.program().program };
    return built.program;
  };
  const D = () => program().duration;
  const layer = () => app.validLayers().waveform || null;
  const clipOf = (id) => compose().clips.find((c) => c.id === id) || null;
  const pieces = () => piecesOf(store.get().edit, tl.duration);

  // speed settings of pieces that no longer exist (cut points changed in step "ตัด") go away
  {
    const c = compose();
    const pruned = K.prunePieces(c, pieces().map((p) => p.key));
    if (pruned !== c || !store.get().compose) store.set({ compose: pruned });
  }

  const commit = (next, opts) => app.commitCompose(next, {}, opts);
  const change = (fn, opts) => commit(fn(compose()), opts);
  /** Changes made from the side panel: the panel itself is not rebuilt (keeps the cursor in a field). */
  const sideChange = (fn, opts) => { change(fn, opts); sideMade = compose(); };
  const endDrag = () => app.endComposeDrag();

  // ---------- preview ----------
  const canvas = h('canvas.cp-canvas');
  const handles = ['nw', 'ne', 'sw', 'se'].map((k) => h(`span.cp-handle.${k}`, { dataset: { corner: k } }));
  const selBox = h('div.cp-sel', handles);
  const guideV = h('div.cp-guide.v');
  const guideH = h('div.cp-guide.h');
  const hidden = h('div.cp-hidden', { 'aria-hidden': 'true' });
  const st0 = store.get();
  const stage = h(`div.cp-stage${audioOnly ? '.audio' : ''}`,
    canvas, guideV, guideH, selBox,
    audioOnly ? h('div.audio-card', icon('music', 22), h('span', tl.files.map((f) => f.name).join(' + '))) : null);
  const player = new ProgramPlayer({ canvas, host: hidden, urls: st0.videos.map((v) => v.url), audioOnly });
  player.addEventListener('size', () => {
    const s = player.size;
    if (s && !audioOnly) { stage.style.aspectRatio = `${s.width} / ${s.height}`; requestAnimationFrame(() => player.resize()); }
  });

  // ---------- transport ----------
  const timeLabel = h('span.time-now', '0:00.0');
  const totalLabel = h('span.time-total');
  const playBtn = h('button.primary.icon-only.play', { type: 'button', onclick: () => player.toggle(), 'aria-label': 'เล่น/หยุด', 'data-tip': 'เล่น / หยุด · Space' }, icon('play', 20));
  const tbtn = (ic, tip, fn) => h('button.tp-btn', { type: 'button', onclick: fn, 'aria-label': tip.split(' · ')[0], 'data-tip': tip }, icon(ic, 18));
  const undoBtn = tbtn('undo', 'ย้อนกลับ · Ctrl Z', () => app.undo());
  const redoBtn = tbtn('redo', 'ทำซ้ำ · Ctrl Shift Z', () => app.redo());
  const stepBy = (n) => { player.pause(); player.seek((Math.round(player.T * fps) + n) / fps + 0.25 / fps); };
  const transport = h('div.transport',
    h('div.tp-group.tp-nav',
      tbtn('toStart', 'ไปต้น · Home', () => player.seek(0)),
      tbtn('chev2L', 'ถอย 1 วินาที · Shift ←', () => player.seek(player.T - 1)),
      tbtn('chev1L', 'ถอย 1 เฟรม · ←', () => stepBy(-1)),
      playBtn,
      tbtn('chev1R', 'ไปข้างหน้า 1 เฟรม · →', () => stepBy(1)),
      tbtn('chev2R', 'ไปข้างหน้า 1 วินาที · Shift →', () => player.seek(player.T + 1)),
      tbtn('toEnd', 'ไปท้าย · End', () => player.seek(D())),
      h('span.time', timeLabel, totalLabel)),
    h('div.tp-group', undoBtn, redoBtn, tbtn('keyboard', 'ปุ่มลัดทั้งหมด · ?', showKeys)));

  // ---------- add bar ----------
  const fileInput = (accept, label) => {
    const input = h('input', { type: 'file', accept, multiple: true, hidden: true, 'aria-label': label, onchange: () => { const files = [...input.files]; input.value = ''; addFiles(files, player.T); } });
    return input;
  };
  const imgIn = fileInput('image/png,image/jpeg,image/webp,image/gif', 'เลือกรูป');
  const vidIn = fileInput('video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm', 'เลือกวิดีโอ');
  const audIn = fileInput('audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac', 'เลือกไฟล์เสียง');
  const menu = h('div.cp-menu', { hidden: true, role: 'menu' },
    K.TEXT_PRESETS.map((p) => h('button.cp-preset', { type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; addText(p.id); } },
      presetSwatch(p), h('span.cp-preset-name', p.label, p.hook ? h('span.tag', 'hook') : null))));
  const textBtn = h('button.secondary', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, h('span.cp-t', 'T'), 'ข้อความ', icon('chevDown', 14));
  const onDocClick = (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== textBtn) menu.hidden = true; };
  document.addEventListener('click', onDocClick);
  const splitBtn = h('button.ghost.small', { type: 'button', onclick: () => splitSelected(), 'data-tip': 'แยกคลิปที่เลือกตรงตำแหน่งเล่น · Ctrl B' }, icon('scissors', 16), 'แยก');
  const dupBtn = h('button.ghost.small', { type: 'button', onclick: () => duplicateSelected(), 'data-tip': 'ทำซ้ำคลิปที่เลือก · Ctrl D' }, icon('copy', 16), 'ทำซ้ำ');
  const delBtn = h('button.ghost.small', { type: 'button', onclick: () => removeSelected(), 'data-tip': 'ลบคลิปที่เลือก · Delete' }, icon('trash', 16), 'ลบ');

  const timeline = new ComposeTimeline({
    onSeek: (T) => player.seek(T),
    onSelect: (s) => select(s),
    onMove: (id, start, track) => commit(K.moveClip(compose(), id, start, track), { live: true }),
    onTrim: (id, side, t) => {
      const c = clipOf(id);
      const len = c?.asset ? app.assets.get(c.asset)?.duration ?? Infinity : Infinity;
      commit(K.trimClip(compose(), id, side, t, c?.kind === 'video' || c?.kind === 'audio' ? len : Infinity), { live: true });
    },
    onDragEnd: endDrag,
    onDropFiles: (files, T) => addFiles(files, Math.min(T, D())),
  });
  const addBar = h('div.cp-tools',
    h('div.cp-add',
      audioOnly ? null : h('span.cp-menu-wrap', textBtn, menu),
      audioOnly ? null : h('button.secondary', { type: 'button', onclick: () => imgIn.click() }, icon('file', 16), 'รูป / โลโก้'),
      audioOnly ? null : h('button.secondary', { type: 'button', onclick: () => vidIn.click() }, icon('film', 16), 'วิดีโอซ้อน'),
      h('button.secondary', { type: 'button', onclick: () => audIn.click() }, icon('music', 16), 'เพลง / เสียง'),
      imgIn, vidIn, audIn),
    h('div.cp-edit', splitBtn, dupBtn, delBtn),
    timeline.zoomBox);

  // ---------- side panel ----------
  const sideBody = h('div.side-body');
  const side = h('aside.cp-side', sideBody);
  let sideRefresh = null; // updates read-outs of the open panel after its own changes

  const summaryEl = h('div.next-summary');
  const nextBar = h('div.next-bar',
    h('button.ghost', { type: 'button', onclick: () => app.go('review') }, icon('arrowLeft', 16), 'กลับไปตัด'),
    summaryEl,
    h('button.primary', { type: 'button', onclick: () => app.go('export') }, 'ไปขั้นส่งออก', icon('arrowRight', 16)));

  root.append(h('section.compose',
    h('div.cp-top', h('div.cp-view', stage, transport), side),
    addBar, timeline.el, hidden), nextBar);

  // ---------- adding ----------
  /** Where a new clip of this length starts: at the playhead, moved back so it ends inside the video. */
  const startFor = (T, dur) => Math.max(0, Math.min(T, D() - Math.min(dur, D())));

  function addText(presetId, T = player.T) {
    const clip = K.textClipFromPreset(presetId);
    clip.start = startFor(T, clip.duration);
    const { compose: next, id } = K.addClip(compose(), clip);
    commit(next);
    select({ type: 'clip', id });
    player.seek(Math.max(player.T, clip.start + Math.min(0.6, clip.duration / 2)));
    requestAnimationFrame(() => { const ta = sideBody.querySelector('textarea'); ta?.focus(); ta?.select(); });
  }

  async function addFiles(files, T) {
    for (const file of files) {
      const kind = kindOfFile(file);
      if (!kind) { toast(`ใส่ ${file.name} ไม่ได้: รองรับรูป (png, jpg, webp) วิดีโอ (mp4, mov, webm) และเสียง (mp3, m4a, wav)`, 'error', 7000); continue; }
      if (audioOnly && kind !== 'audio') { toast('งานเสียงใส่ได้เฉพาะไฟล์เสียง', 'error'); continue; }
      const b = busy(`กำลังเพิ่ม ${file.name}…`);
      let a;
      try { a = await app.assets.add(file); } catch (e) { toast(`ใส่ ${file.name} ไม่ได้: ${e.message}`, 'error', 7000); continue; } finally { b.close(); }
      const total = D();
      let clip;
      if (kind === 'image') {
        const s = player.size;
        const slide = s && a.width >= 640 && Math.abs(a.width / a.height - s.width / s.height) < 0.08;
        const dur = Math.min(5, total) || 5;
        clip = { kind, asset: a.id, start: startFor(T, dur), duration: dur, box: slide ? { x: 0.5, y: 0.5, w: 1 } : { x: 0.86, y: 0.14, w: 0.2 }, opacity: 1, fadeIn: 0, fadeOut: 0 };
      } else if (kind === 'video') {
        const dur = Math.max(0.5, Math.min(a.duration || 5, total || 5));
        clip = { kind, asset: a.id, start: startFor(T, dur), duration: dur, offset: 0, box: { x: 0.75, y: 0.72, w: 0.42 }, opacity: 1, volume: 0, fadeIn: 0, fadeOut: 0 };
      } else {
        const at = T > total - 1 ? 0 : T;
        const dur = Math.max(0.5, Math.min(a.duration || 5, Math.max(1, total - at)));
        clip = { kind, asset: a.id, start: at, duration: dur, offset: 0, volume: 0.8, fadeIn: Math.min(0.5, dur / 4), fadeOut: Math.min(2, dur / 4), duck: 'medium' };
      }
      const { compose: next, id } = K.addClip(compose(), clip);
      commit(next);
      select({ type: 'clip', id });
    }
  }

  // ---------- editing the selection ----------
  function splitSelected() {
    if (sel?.type !== 'clip') { toast(audioOnly ? 'เลือกคลิปเสียงก่อน (การตัดเสียงหลักทำในขั้นตัด)' : 'เลือกคลิปก่อน (การตัดวิดีโอหลักทำในขั้นตัด)'); return; }
    const { compose: next, id } = K.splitClip(compose(), sel.id, player.T);
    if (!id) { toast('เลื่อนตำแหน่งเล่นไปไว้ในคลิปที่เลือกก่อน'); return; }
    commit(next);
  }
  function removeSelected() {
    if (sel?.type !== 'clip') return;
    const id = sel.id;
    select(null);
    commit(K.removeClip(compose(), id));
  }
  function duplicateSelected() {
    if (sel?.type !== 'clip') return;
    const c = clipOf(sel.id);
    if (!c) return;
    const { id: _id, track: _t, ...rest } = c;
    const { compose: next, id } = K.addClip(compose(), JSON.parse(JSON.stringify({ ...rest, start: c.start + c.duration })));
    commit(next);
    select({ type: 'clip', id });
  }

  function select(next) {
    const same = (sel && next && sel.type === next.type && (sel.id ?? sel.key) === (next.id ?? next.key)) || (!sel && !next);
    sel = next;
    if (!same) renderSide();
    syncTimeline();
    player.draw();
  }

  // ---------- picking and dragging on the preview ----------
  let boxDrag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (audioOnly || e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const px = (e.clientX - r.left) * sx;
    const py = (e.clientY - r.top) * sx;
    const corner = e.target.dataset?.corner;
    let hit = null;
    if (corner && sel?.type === 'clip') hit = player.hits.find((x) => x.id === sel.id) || null;
    if (!hit) for (let i = player.hits.length - 1; i >= 0; i--) { const b = player.hits[i]; if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { hit = b; break; } }
    if (!hit) { if (sel?.type === 'clip') select(null); return; }
    const c = clipOf(hit.id);
    if (!c) return;
    e.preventDefault();
    player.pause();
    if (sel?.id !== c.id) select({ type: 'clip', id: c.id });
    stage.setPointerCapture(e.pointerId);
    boxDrag = { id: c.id, corner, x0: px, y0: py, box: { x: 0.5, y: 0.5, w: 0.5, ...c.box }, size: c.style?.size, hit, moved: false, W: canvas.width, H: canvas.height };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!boxDrag) return;
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const dx = (e.clientX - r.left) * sx - boxDrag.x0;
    const dy = (e.clientY - r.top) * sx - boxDrag.y0;
    if (!boxDrag.moved && Math.hypot(dx, dy) < 3 * sx) return;
    boxDrag.moved = true;
    const c = clipOf(boxDrag.id);
    if (!c) return;
    const { W, H, box } = boxDrag;
    if (boxDrag.corner) {
      // corners scale around the centre: text grows its letters, pictures their width
      const cx = box.x * W;
      const cy = box.y * H;
      const d0 = Math.hypot(boxDrag.x0 - cx, boxDrag.y0 - cy) || 1;
      const d1 = Math.hypot(boxDrag.x0 + dx - cx, boxDrag.y0 + dy - cy);
      const f = clamp(d1 / d0, 0.15, 6);
      const patch = c.kind === 'text' ? { style: { size: clamp((boxDrag.size || 0.05) * f, 0.015, 0.3) }, box: { w: clamp(box.w * f, 0.1, 1) } } : { box: { w: clamp(box.w * f, 0.03, 2) } };
      commit(K.updateClip(compose(), c.id, patch), { live: true });
      return;
    }
    let x = clamp(box.x + dx / W, 0, 1);
    let y = clamp(box.y + dy / H, 0, 1);
    const snapX = Math.abs(x - 0.5) < 0.012;
    const snapY = Math.abs(y - 0.5) < 0.012;
    if (snapX) x = 0.5;
    if (snapY) y = 0.5;
    guideV.classList.toggle('on', snapX);
    guideH.classList.toggle('on', snapY);
    commit(K.updateClip(compose(), c.id, { box: { x: +x.toFixed(4), y: +y.toFixed(4) } }), { live: true });
  });
  const dropBox = () => { if (boxDrag?.moved) endDrag(); boxDrag = null; guideV.classList.remove('on'); guideH.classList.remove('on'); };
  stage.addEventListener('pointerup', dropBox);
  stage.addEventListener('pointercancel', dropBox);
  stage.addEventListener('dblclick', () => { if (sel?.type === 'clip' && clipOf(sel.id)?.kind === 'text') sideBody.querySelector('textarea')?.focus(); });

  /** The selection box over the picture, where the selected overlay was drawn. */
  function placeSel() {
    const hit = sel?.type === 'clip' ? player.hits.find((x) => x.id === sel.id) : null;
    if (!hit || audioOnly) { selBox.hidden = true; return; }
    const r = canvas.getBoundingClientRect();
    const s = r.width / canvas.width;
    selBox.hidden = false;
    Object.assign(selBox.style, { left: `${canvas.offsetLeft + hit.x * s}px`, top: `${canvas.offsetTop + hit.y * s}px`, width: `${hit.w * s}px`, height: `${hit.h * s}px` });
  }
  player.addEventListener('draw', placeSel);
  player.addEventListener('time', (e) => {
    const T = e.detail.t;
    timeLabel.textContent = formatTime(T, { decimals: 1, short: D() < 3600 });
    timeline.setTime(T, { playing: player.playing });
    sideTime?.(T);
  });
  player.addEventListener('state', () => clear(playBtn, icon(player.playing ? 'pause' : 'play', 20)));

  // ---------- side panel ----------
  let sideTime = null;
  function section(title, ...kids) { return h('section.cp-sec', title ? h('h3', title) : null, kids); }
  /** A slider that changes the composition live and makes one undo step per drag. */
  function slider({ label, min, max, step, value, fmt, set, tip }) {
    const out = h('span.cp-val', fmt(value));
    const input = h('input', {
      type: 'range', min, max, step, value, 'aria-label': label, 'data-tip': tip || null,
      oninput: (e) => { const v = +e.target.value; out.textContent = fmt(v); sideChange((c) => set(c, v), { live: true }); },
      onchange: endDrag,
    });
    return h('label.cp-field', h('span.cp-label', h('span', label), out), input);
  }
  function choice({ label, value, options, set }) {
    return h('label.cp-field', h('span.cp-label', h('span', label)),
      h('select', { onchange: (e) => sideChange((c) => set(c, e.target.value)) }, options.map(([v, l]) => h('option', { value: v, selected: String(value) === String(v) }, l))));
  }
  function colorField(label, value, set, alpha = false) {
    const { hex, a } = splitColor(value);
    let cur = { hex, a };
    const input = h('input.cp-color', { type: 'color', value: hex, 'aria-label': label, oninput: (e) => { cur = { ...cur, hex: e.target.value }; sideChange((c) => set(c, joinColor(cur.hex, cur.a)), { live: true }); }, onchange: endDrag });
    const op = alpha ? h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: a, 'aria-label': `${label} ความทึบ`, oninput: (e) => { cur = { ...cur, a: +e.target.value }; sideChange((c) => set(c, joinColor(cur.hex, cur.a)), { live: true }); }, onchange: endDrag }) : null;
    return h('label.cp-field.cp-color-row', h('span.cp-label', h('span', label)), h('span.cp-color-ctl', input, op));
  }
  const upd = (id, patch) => (c) => K.updateClip(c, id, patch);
  function timingFields(c) {
    const num = (label, value, onSet, min = 0) => h('label.cp-field.cp-num', h('span.cp-label', h('span', label)),
      h('input', { type: 'number', min, step: 0.1, value: (+value).toFixed(2), onchange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) sideChange((k) => onSet(k, v)); } }));
    return h('div.cp-row',
      num('เริ่มที่ (วิ)', c.start, (k, v) => K.moveClip(k, c.id, v)),
      num('ยาว (วิ)', c.duration, (k, v) => K.trimClip(k, c.id, 'end', clipOf(c.id).start + v, mediaLen(c)), 0.1));
  }
  /** A clip whose media is gone from this browser: pick the file again (same clip, new media). */
  const relinkButton = (c, accept) => {
    const input = h('input', {
      type: 'file', accept, hidden: true,
      onchange: async () => {
        const f = input.files[0];
        if (!f) return;
        const b = busy(`กำลังเพิ่ม ${f.name}…`);
        try {
          const a = await app.assets.add(f);
          if (a.kind !== c.kind) { toast(`${f.name} ไม่ใช่${c.kind === 'audio' ? 'ไฟล์เสียง' : c.kind === 'image' ? 'รูป' : 'วิดีโอ'}`, 'error'); return; }
          change((k) => K.updateClip(k, c.id, { asset: a.id }));
        } catch (e) { toast(`ใส่ ${f.name} ไม่ได้: ${e.message}`, 'error', 7000); } finally { b.close(); }
      },
    });
    return h('p.warn', icon('alert', 16), h('span', 'ไฟล์นี้ไม่อยู่ใน browser นี้แล้ว (เช่น เปิดงานบนเครื่องอื่น) ',
      h('button.secondary.small', { type: 'button', onclick: () => input.click() }, 'เลือกไฟล์อีกครั้ง'), input));
  };
  const mediaLen = (c) => (c.kind === 'video' || c.kind === 'audio' ? app.assets.get(c.asset)?.duration ?? Infinity : Infinity);
  const clipActions = (c) => h('div.cp-actions',
    h('button.secondary.small', { type: 'button', onclick: duplicateSelected }, icon('copy', 15), 'ทำซ้ำ'),
    h('button.secondary.small', { type: 'button', onclick: () => { player.seek(c.start); } }, icon('target', 15), 'ไปที่คลิป'),
    h('button.ghost.small.danger', { type: 'button', onclick: removeSelected }, icon('trash', 15), 'ลบ'));

  function renderSide() {
    sideRefresh = null;
    sideTime = null;
    const c = sel?.type === 'clip' ? clipOf(sel.id) : null;
    if (c?.kind === 'text') return clear(sideBody, textPanel(c));
    if (c && (c.kind === 'image' || c.kind === 'video')) return clear(sideBody, picturePanel(c));
    if (c?.kind === 'audio') return clear(sideBody, audioPanel(c));
    if (sel?.type === 'piece') return clear(sideBody, piecePanel(sel.key));
    return clear(sideBody, overviewPanel());
  }

  function overviewPanel() {
    const cmp = compose();
    const s = K.summary(cmp);
    return [
      h('div.cp-head', h('h2', audioOnly ? 'แต่งเสียง' : 'แต่งวิดีโอ'), h('p.hint', audioOnly
        ? 'ใส่เพลงประกอบที่เบาลงเองตอนมีคนพูด และปรับความเร็วเป็นช่วง ๆ ได้ คลิกชิ้นบนแทร็กหลักเพื่อปรับความเร็ว'
        : 'ใส่ข้อความ hook โลโก้ วิดีโอซ้อน เพลงประกอบ และปรับความเร็วเป็นช่วง ๆ คลิกสิ่งที่อยู่บน timeline หรือบนภาพเพื่อแก้')),
      audioOnly ? null : section('ข้อความสำเร็จรูป',
        h('div.cp-presets', K.TEXT_PRESETS.map((p) => h('button.cp-preset', { type: 'button', onclick: () => addText(p.id) }, presetSwatch(p), h('span.cp-preset-name', p.label, p.hook ? h('span.tag', 'hook') : null)))),
        h('p.hint', 'ใส่ที่ตำแหน่งเล่น · hook ควรอยู่ใน 3 วินาทีแรก')),
      section('เสียงของวิดีโอหลัก',
        slider({ label: 'ระดับเสียง', min: 0, max: 2, step: 0.05, value: cmp.mainVolume ?? 1, fmt: pct, set: (k, v) => ({ ...k, mainVolume: v }) }),
        (cmp.mainVolume ?? 1) > 1 ? h('p.hint', 'ตัวอย่างดังได้สูงสุด 100% ไฟล์ที่ส่งออกจะดังตามที่ตั้ง') : null),
      section('ความเร็ว', h('p.hint', 'คลิกชิ้นบนแทร็กหลัก (แถบที่มีภาพและคลื่นเสียง) เพื่อตั้งความเร็วคงที่หรือเส้นโค้งแบบ CapCut')),
      K.isEmpty(cmp) ? null : section('ที่ใส่ไว้',
        h('ul.cp-list',
          s.text ? h('li', `ข้อความ ${s.text}`) : null,
          s.image ? h('li', `ภาพ ${s.image}`) : null,
          s.video ? h('li', `วิดีโอซ้อน ${s.video}`) : null,
          s.audio ? h('li', `เพลง / เสียง ${s.audio}`) : null,
          s.speed ? h('li', `ปรับความเร็ว ${s.speed} ชิ้น`) : null)),
    ];
  }

  function textPanel(c) {
    const st = c.style || {};
    const font = K.FONTS.find((f) => f.id === st.font) || K.FONTS[1];
    const id = c.id;
    const ta = h('textarea', { rows: 3, 'aria-label': 'ข้อความ', oninput: (e) => sideChange(upd(id, { text: e.target.value }), { live: true }), onchange: endDrag });
    ta.value = c.text || '';
    const alignBtn = (v, label) => h('button', { type: 'button', 'aria-pressed': String((st.align || 'center') === v), onclick: () => { sideChange(upd(id, { style: { align: v } })); renderSide(); } }, label);
    return [
      h('div.cp-head', h('h2', 'ข้อความ'), h('span.hint', `${formatTime(c.start, { decimals: 1 })} · ${secs(c.duration)}`)),
      section(null, ta),
      section('แบบ', h('div.cp-presets.small', K.TEXT_PRESETS.map((p) => h(`button.cp-preset${p.id === c.preset ? '.on' : ''}`, {
        type: 'button', 'aria-pressed': String(p.id === c.preset),
        onclick: () => { sideChange((k) => K.applyPreset(k, id, p.id)); renderSide(); },
      }, presetSwatch(p), h('span.cp-preset-name', p.label))))),
      section('ตัวอักษร',
        h('div.cp-row',
          choice({ label: 'ฟอนต์', value: font.id, options: K.FONTS.map((f) => [f.id, f.label]), set: (k, v) => { const f = K.FONTS.find((x) => x.id === v); return K.updateClip(k, id, { style: { font: v, weight: f.weights.includes(st.weight) ? st.weight : f.weights[f.weights.length - 1] } }); } }),
          choice({ label: 'น้ำหนัก', value: st.weight || 600, options: font.weights.map((w) => [w, { 400: 'ปกติ', 600: 'หนา', 700: 'หนา', 800: 'หนามาก' }[w] || w]), set: (k, v) => K.updateClip(k, id, { style: { weight: +v } }) })),
        slider({ label: 'ขนาด', min: 0.02, max: 0.2, step: 0.002, value: st.size || 0.05, fmt: (v) => `${(v * 100).toFixed(1)}% ของความสูง`, set: (k, v) => K.updateClip(k, id, { style: { size: v } }) }),
        colorField('สีตัวอักษร', st.color || '#FFFFFF', (k, v) => K.updateClip(k, id, { style: { color: v } })),
        h('div.cp-row',
          colorField('สีขอบ', st.stroke || '#000000', (k, v) => K.updateClip(k, id, { style: { stroke: v } })),
          slider({ label: 'ขอบหนา', min: 0, max: 0.3, step: 0.01, value: st.strokeWidth || 0, fmt: (v) => (v ? v.toFixed(2) : 'ไม่มี'), set: (k, v) => K.updateClip(k, id, { style: { strokeWidth: v } }) })),
        h('div.cp-row',
          h('div.cp-field', h('span.cp-label', h('span', 'จัดวาง')), h('div.cp-seg', alignBtn('left', 'ซ้าย'), alignBtn('center', 'กลาง'), alignBtn('right', 'ขวา'))),
          h('label.tick.small.cp-shadow', h('input', { type: 'checkbox', checked: !!st.shadow, onchange: (e) => sideChange(upd(id, { style: { shadow: e.target.checked } })) }), h('span', 'เงา')))),
      section('พื้นหลัง',
        choice({ label: 'แบบ', value: st.bg || 'none', options: [['none', 'ไม่มี'], ['box', 'กล่องมุมมน'], ['bar', 'แถบมีเส้นสีด้านซ้าย']], set: (k, v) => { const out = K.updateClip(k, id, { style: { bg: v, bgColor: st.bgColor || 'rgba(0,0,0,0.6)' } }); queueMicrotask(renderSide); return out; } }),
        st.bg && st.bg !== 'none' ? colorField('สีพื้น (และความทึบ)', st.bgColor || '#000000', (k, v) => K.updateClip(k, id, { style: { bgColor: v } }), true) : null,
        st.bg === 'bar' ? colorField('สีเส้น', st.accent || '#FFD60A', (k, v) => K.updateClip(k, id, { style: { accent: v } })) : null),
      section('ตำแหน่ง',
        h('p.hint', 'ลากข้อความบนภาพได้เลย ลากมุมเพื่อย่อขยาย'),
        slider({ label: 'แนวนอน', min: 0, max: 1, step: 0.005, value: c.box?.x ?? 0.5, fmt: pct, set: (k, v) => K.updateClip(k, id, { box: { x: v } }) }),
        slider({ label: 'แนวตั้ง', min: 0, max: 1, step: 0.005, value: c.box?.y ?? 0.5, fmt: pct, set: (k, v) => K.updateClip(k, id, { box: { y: v } }) }),
        slider({ label: 'ความกว้างก่อนขึ้นบรรทัดใหม่', min: 0.1, max: 1, step: 0.01, value: c.box?.w ?? 0.9, fmt: pct, set: (k, v) => K.updateClip(k, id, { box: { w: v } }) })),
      section('การเคลื่อนไหว',
        h('div.cp-row',
          choice({ label: 'ตอนเข้า', value: c.anim?.in || 'none', options: K.ANIMS_IN, set: (k, v) => K.updateClip(k, id, { anim: { in: v } }) }),
          choice({ label: 'ตอนออก', value: c.anim?.out || 'none', options: K.ANIMS_OUT, set: (k, v) => K.updateClip(k, id, { anim: { out: v } }) })),
        slider({ label: 'ความยาวตอนเข้า', min: 0.1, max: 3, step: 0.05, value: c.anim?.dur || 0.35, fmt: secs, set: (k, v) => K.updateClip(k, id, { anim: { dur: v } }) })),
      section('เวลา', timingFields(c)),
      clipActions(c),
    ];
  }

  function picturePanel(c) {
    const id = c.id;
    const a = app.assets.get(c.asset);
    const video = c.kind === 'video';
    return [
      h('div.cp-head', h('h2', video ? 'วิดีโอซ้อน' : 'ภาพ'), h('span.hint', a ? a.name : 'หาไฟล์ไม่เจอ')),
      !a ? relinkButton(c, video ? 'video/*,.mp4,.mov,.m4v,.webm' : 'image/*') : null,
      section('ขนาดและตำแหน่ง',
        h('p.hint', 'ลากบนภาพเพื่อย้าย ลากมุมเพื่อย่อขยาย'),
        h('div.cp-actions',
          h('button.secondary.small', { type: 'button', onclick: () => { sideChange(upd(id, { box: { x: 0.5, y: 0.5, w: 1 } })); renderSide(); } }, 'เต็มจอ'),
          h('button.secondary.small', { type: 'button', onclick: () => { sideChange(upd(id, { box: { x: 0.86, y: 0.14, w: 0.2 } })); renderSide(); } }, 'มุมขวาบน (โลโก้)'),
          h('button.secondary.small', { type: 'button', onclick: () => { sideChange(upd(id, { box: { x: 0.75, y: 0.72, w: 0.42 } })); renderSide(); } }, 'มุมขวาล่าง')),
        slider({ label: 'ขนาด (ความกว้าง)', min: 0.03, max: 1.5, step: 0.005, value: c.box?.w ?? 0.5, fmt: pct, set: (k, v) => K.updateClip(k, id, { box: { w: v } }) }),
        slider({ label: 'แนวนอน', min: 0, max: 1, step: 0.005, value: c.box?.x ?? 0.5, fmt: pct, set: (k, v) => K.updateClip(k, id, { box: { x: v } }) }),
        slider({ label: 'แนวตั้ง', min: 0, max: 1, step: 0.005, value: c.box?.y ?? 0.5, fmt: pct, set: (k, v) => K.updateClip(k, id, { box: { y: v } }) }),
        slider({ label: 'ความทึบ', min: 0.05, max: 1, step: 0.01, value: c.opacity ?? 1, fmt: pct, set: (k, v) => K.updateClip(k, id, { opacity: v }) })),
      section('ค่อย ๆ ปรากฏ / หาย',
        slider({ label: 'ตอนเข้า', min: 0, max: 3, step: 0.1, value: c.fadeIn || 0, fmt: (v) => (v ? secs(v) : 'ไม่มี'), set: (k, v) => K.updateClip(k, id, { fadeIn: v }) }),
        slider({ label: 'ตอนออก', min: 0, max: 3, step: 0.1, value: c.fadeOut || 0, fmt: (v) => (v ? secs(v) : 'ไม่มี'), set: (k, v) => K.updateClip(k, id, { fadeOut: v }) })),
      video ? section('เสียงของวิดีโอนี้',
        a && !a.hasAudio ? h('p.hint', 'ไฟล์นี้ไม่มีเสียง') : slider({ label: 'ระดับเสียง', min: 0, max: 2, step: 0.05, value: c.volume ?? 0, fmt: (v) => (v ? pct(v) : 'ปิด'), set: (k, v) => K.updateClip(k, id, { volume: v }) })) : null,
      section('เวลา', timingFields(c), video && a ? h('p.hint', `ไฟล์ยาว ${formatDuration(a.duration)} · เริ่มจากวินาทีที่ ${(c.offset || 0).toFixed(1)} ของไฟล์ (ลากขอบซ้ายของคลิปเพื่อเลื่อน)`) : null),
      clipActions(c),
    ];
  }

  function audioPanel(c) {
    const id = c.id;
    const a = app.assets.get(c.asset);
    const duckBtn = (v, label) => h('button', { type: 'button', 'aria-pressed': String((c.duck || 'off') === v), onclick: () => { sideChange(upd(id, { duck: v })); renderSide(); } }, label);
    const end = D();
    return [
      h('div.cp-head', h('h2', 'เพลง / เสียง'), h('span.hint', a ? a.name : 'หาไฟล์ไม่เจอ')),
      !a ? relinkButton(c, 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac') : null,
      section('ระดับเสียง',
        slider({ label: 'ความดัง', min: 0, max: 2, step: 0.05, value: c.volume ?? 1, fmt: pct, set: (k, v) => K.updateClip(k, id, { volume: v }) })),
      section('ลดเสียงเพลงตอนมีคนพูด',
        h('div.cp-seg.wide', duckBtn('off', 'ไม่ลด'), duckBtn('light', 'น้อย'), duckBtn('medium', 'กลาง'), duckBtn('strong', 'มาก')),
        h('p.hint', 'เพลงจะเบาลงเองเมื่อเสียงในวิดีโอหลักมีคนพูด แล้วค่อย ๆ ดังกลับเมื่อเงียบ (ใช้กับเพลงประกอบ ปิดไว้ถ้าเป็นเสียงบรรยาย)')),
      section('ค่อย ๆ ดัง / ค่อย ๆ เบา',
        slider({ label: 'ตอนเริ่ม', min: 0, max: 8, step: 0.1, value: c.fadeIn || 0, fmt: (v) => (v ? secs(v) : 'ไม่มี'), set: (k, v) => K.updateClip(k, id, { fadeIn: v }) }),
        slider({ label: 'ตอนจบ', min: 0, max: 8, step: 0.1, value: c.fadeOut || 0, fmt: (v) => (v ? secs(v) : 'ไม่มี'), set: (k, v) => K.updateClip(k, id, { fadeOut: v }) })),
      section('เวลา', timingFields(c),
        a ? h('p.hint', `ไฟล์ยาว ${formatDuration(a.duration)} · เริ่มจากวินาทีที่ ${(c.offset || 0).toFixed(1)} ของเพลง (ลากขอบซ้ายของคลิปเพื่อข้ามช่วงต้นเพลง)`) : null,
        h('div.cp-actions',
          h('button.secondary.small', { type: 'button', onclick: () => { sideChange((k) => K.trimClip(K.moveClip(k, id, 0), id, 'end', end, mediaLen(c))); renderSide(); } }, 'ตั้งแต่ต้นจนจบวิดีโอ'),
          a && a.duration - (c.offset || 0) < end - c.start - 0.5 ? h('span.hint', 'เพลงสั้นกว่าวิดีโอ ใส่เพลงซ้ำต่อท้ายได้ด้วยปุ่ม “ทำซ้ำ”') : null)),
      clipActions(c),
    ];
  }

  function piecePanel(key) {
    const p = pieces().find((x) => x.key === key);
    if (!p) return overviewPanel();
    const len = p.end - p.start;
    const sp = normalizeSpeed(compose().speed?.[key]);
    const setSp = (next, opts) => sideChange((k) => K.setSpeed(k, key, next), opts);
    const outLabel = h('strong');
    const updateInfo = () => {
      const now = normalizeSpeed(compose().speed?.[key]);
      outLabel.textContent = formatDuration(speedMap(now, len).outDur);
    };
    updateInfo();
    sideRefresh = updateInfo;
    const tab = (mode, label) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(sp.mode === mode),
      onclick: () => {
        if (mode === sp.mode) return;
        if (mode === 'normal') setSp(null);
        if (mode === 'constant') setSp({ mode: 'constant', rate: 1.5, pitch: sp.pitch });
        if (mode === 'curve') setSp({ mode: 'curve', curve: 'montage', points: curvePoints('montage'), pitch: sp.pitch });
        renderSide();
      },
    }, label);

    let body = null;
    if (sp.mode === 'constant') {
      const toPos = (v) => Math.round((Math.log10(v) + 1) * 500);
      const fromPos = (x) => +(10 ** (x / 500 - 1)).toFixed(2);
      const num = h('input', { type: 'number', min: SPEED_MIN, max: SPEED_MAX, step: 0.05, value: sp.rate, 'aria-label': 'ความเร็ว (เท่า)', onchange: (e) => { const v = clamp(Number(e.target.value) || 1, SPEED_MIN, SPEED_MAX); setSp({ mode: 'constant', rate: v, pitch: sp.pitch }); range.value = toPos(v); updateInfo(); } });
      const range = h('input', {
        type: 'range', min: 0, max: 1000, step: 1, value: toPos(sp.rate), 'aria-label': 'ความเร็ว',
        oninput: (e) => { const v = fromPos(+e.target.value); const vv = Math.abs(v - 1) < 0.04 ? 1 : v; num.value = vv; setSp({ mode: 'constant', rate: vv, pitch: sp.pitch }, { live: true }); updateInfo(); },
        onchange: endDrag,
      });
      body = h('div.cp-speed',
        h('div.cp-speed-row', range, h('span.cp-speed-num', num, '×')),
        h('div.cp-scale', h('span', '0.1×'), h('span', '1×'), h('span', '10×')),
        h('div.cp-chips', [0.5, 0.75, 1.25, 1.5, 2, 3, 5].map((v) => h('button.chip', { type: 'button', onclick: () => { setSp({ mode: 'constant', rate: v, pitch: sp.pitch }); renderSide(); } }, `${v}×`))));
    } else if (sp.mode === 'curve') {
      const ed = speedEditor({
        points: sp.points,
        onChange: (pts, { live }) => { setSp({ mode: 'curve', curve: 'custom', points: pts, pitch: sp.pitch }, { live }); updateInfo(); if (!live) markPresets('custom'); },
      });
      const presetBtns = CURVES.map((cv) => h(`button.cp-curve${sp.curve === cv.id ? '.on' : ''}`, {
        type: 'button', dataset: { curve: cv.id }, 'data-tip': cv.hint,
        onclick: () => {
          const pts = cv.id === 'custom' ? (sp.mode === 'curve' ? sp.points : curvePoints('montage')) : curvePoints(cv.id);
          setSp({ mode: 'curve', curve: cv.id, points: pts, pitch: sp.pitch });
          renderSide();
        },
      }, curveThumb(cv.id === 'custom' ? [[0, 1], [0.3, 0.5], [0.6, 2.5], [1, 1]] : cv.points), h('span', cv.label)));
      const markPresets = (id) => presetBtns.forEach((b) => b.classList.toggle('on', b.dataset.curve === id));
      sideTime = (T) => {
        const prog = program();
        const seg = prog.parts.flatMap((x) => x.segments).find((s) => s.pieceKey === key && T >= s.progStart && T <= s.progStart + s.duration);
        ed.mark(seg ? clamp(seg.map.toSrc(seg.outOffset + (T - seg.progStart)) / Math.max(1e-6, len), 0, 1) : null);
      };
      sideTime(player.T);
      // the graph first (what is being edited), the ready-made curves under it
      body = h('div.cp-speed', ed.el, h('p.hint', 'ลากจุดขึ้นลงเพื่อเปลี่ยนความเร็ว (เส้นประ = 1×) · ดับเบิลคลิกบนเส้นเพื่อเพิ่มจุด · ดับเบิลคลิกที่จุดเพื่อลบ'), h('div.cp-curves', presetBtns));
    }

    const kept = program().parts.flatMap((x) => x.segments).map((s) => s.pieceKey).filter(Boolean);
    return [
      h('div.cp-head', h('h2', 'ความเร็วของชิ้นนี้'),
        h('span.hint', `ต้นฉบับ ${formatTime(p.start, { decimals: 1 })} – ${formatTime(p.end, { decimals: 1 })} · ยาว ${formatDuration(len)} → `, outLabel)),
      h('div.seg.mode', { role: 'tablist' }, tab('normal', 'ปกติ'), tab('constant', 'คงที่'), tab('curve', 'เส้นโค้ง')),
      body,
      sp.mode !== 'normal' ? h('label.tick.small.cp-pitch', h('input', { type: 'checkbox', checked: !!sp.pitch, onchange: (e) => { setSp({ ...sp, pitch: e.target.checked }); renderSide(); } }),
        h('span', 'ให้เสียงสูง-ต่ำตามความเร็ว (เสียงแบบการ์ตูนเมื่อเร่ง) · ปิดไว้ = เสียงคนพูดปกติ')) : null,
      h('div.cp-actions',
        sp.mode !== 'normal' ? h('button.secondary.small', {
          type: 'button',
          onclick: () => { sideChange((k) => [...new Set(kept)].reduce((acc, kk) => K.setSpeed(acc, kk, sp), k)); toast(`ใช้ความเร็วนี้กับทุกชิ้น (${new Set(kept).size} ชิ้น)`); },
        }, 'ใช้กับทุกชิ้น') : null,
        Object.keys(compose().speed || {}).length ? h('button.ghost.small', { type: 'button', onclick: () => { sideChange((k) => ({ ...k, speed: {} })); renderSide(); } }, 'คืนความเร็วปกติทุกชิ้น') : null),
      section('เสียงของวิดีโอหลัก',
        slider({ label: 'ระดับเสียง (ทั้งวิดีโอ)', min: 0, max: 2, step: 0.05, value: compose().mainVolume ?? 1, fmt: pct, set: (k, v) => ({ ...k, mainVolume: v }) })),
      h('p.hint', 'ความเร็วผูกกับชิ้นที่ตัดไว้ในขั้นตัด ถ้าย้ายจุดตัด ความเร็วของชิ้นนั้นจะยังอยู่ ถ้าลบจุดตัดออก ความเร็วจะหายไป'),
    ];
  }

  // ---------- keyboard ----------
  function showKeys() {
    ask({
      title: 'ปุ่มลัด ขั้นแต่ง',
      body: h('div.keys-wrap', h('table.keys-table', h('thead', h('tr', h('th', 'ปุ่ม'), h('th', 'ทำอะไร'))),
        h('tbody', SHORTCUTS.map(([k, d]) => h('tr', h('td', k.split(' / ').map((x, i) => [i ? ' / ' : null, x.split(' + ').map((y, j) => [j ? ' + ' : null, h('kbd', y)])])), h('td', d)))))),
      buttons: [{ label: 'ปิด', value: true, kind: 'primary' }],
    });
  }
  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const done = () => e.preventDefault();
    if (ctrl && lower === 'z') { done(); if (e.shiftKey) app.redo(); else app.undo(); return; }
    if (ctrl && lower === 'y') { done(); app.redo(); return; }
    if (ctrl && (k === '=' || k === '+')) { done(); timeline.zoomIn(); return; }
    if (ctrl && (k === '-' || k === '_')) { done(); timeline.zoomOut(); return; }
    if (ctrl && k === '0') { done(); timeline.setZoom(1); return; }
    if (ctrl && lower === 'b') { done(); splitSelected(); return; }
    if (ctrl && lower === 'd') { done(); duplicateSelected(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (e.altKey) return;
      done();
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) player.seek(player.T + dir); else stepBy(dir);
      return;
    }
    if (ctrl || e.altKey) return;
    if (k === ' ') { done(); player.toggle(); return; }
    if (k === 'Home') { done(); player.seek(0); return; }
    if (k === 'End') { done(); player.seek(D()); return; }
    if (lower === 's') { done(); splitSelected(); return; }
    if (lower === 't' && !audioOnly) { done(); addText('plain'); return; }
    if (k === 'Delete' || k === 'Backspace') { done(); removeSelected(); return; }
    if (k === 'Escape') { done(); menu.hidden = true; select(null); return; }
    if (k === '?') { done(); showKeys(); }
  }
  document.addEventListener('keydown', onKey);

  // ---------- wiring ----------
  const frames = audioOnly ? null : new FrameSource({ timeline: tl, videos: store.get().videos });
  function syncTimeline() {
    timeline.set({ program: program(), compose: compose(), assets: app.assets, frames, layer: layer(), kind: tl.kind, selection: sel });
  }
  function renderSummary() {
    const s = K.summary(compose());
    const bits = [s.text && `ข้อความ ${s.text}`, s.image && `ภาพ ${s.image}`, s.video && `วิดีโอซ้อน ${s.video}`, s.audio && `เสียง ${s.audio}`, s.speed && `ปรับความเร็ว ${s.speed} ชิ้น`].filter(Boolean);
    summaryEl.textContent = `${bits.length ? bits.join(' · ') : 'ยังไม่ได้แต่ง (ข้ามได้)'} · ยาว ${formatTime(D())}`;
    totalLabel.textContent = ` / ${formatTime(D(), { decimals: 1, short: D() < 3600 })}`;
  }

  let last = null;
  const unsub = store.subscribe((st) => {
    undoBtn.disabled = !app.canUndo();
    redoBtn.disabled = !app.canRedo();
    const sig = [st.compose, st.edit, st.arrange, st.videos, st.layers];
    if (last && sig.every((v, i) => v === last[i])) return;
    const progChanged = !last || last[1] !== sig[1] || last[2] !== sig[2] || last[3] !== sig[3] || last[0]?.speed !== sig[0]?.speed;
    last = sig;
    let lost = false;
    if (sel?.type === 'clip' && !clipOf(sel.id)) { sel = null; lost = true; }
    if (sel?.type === 'piece' && !program().parts.some((p) => p.segments.some((s) => s.pieceKey === sel.key))) { sel = null; lost = true; }
    if (progChanged) player.setProgram(program());
    player.setCompose(compose(), app.assets, layer());
    syncTimeline();
    renderSummary();
    if (lost || st.compose !== sideMade) renderSide(); else sideRefresh?.();
  });

  const onResize = () => { player.resize(); timeline.resize(); };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => player.resize()) : null;
  ro?.observe(stage);

  player.setProgram(program());
  player.setCompose(compose(), app.assets, layer());
  player.seek(0);
  last = [store.get().compose, store.get().edit, store.get().arrange, store.get().videos, store.get().layers];
  syncTimeline();
  renderSide();
  renderSummary();
  undoBtn.disabled = !app.canUndo();
  redoBtn.disabled = !app.canRedo();
  app.ensureLayers();
  requestAnimationFrame(() => { player.resize(); timeline.resize(); });
  if (window.clipcut) window.clipcut.compose = { player, timeline, select, get selection() { return sel; } }; // for the console

  return () => {
    if (window.clipcut) delete window.clipcut.compose;
    unsub();
    ro?.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('resize', onResize);
    timeline.dispose();
    frames?.dispose();
    player.dispose();
  };
}

/** A button face that looks like the text preset (colours and weight). */
function presetSwatch(p) {
  const st = p.style;
  const bg = st.bg && st.bg !== 'none' ? st.bgColor : '#3A4250';
  return h('span.cp-swatch', {
    style: {
      fontFamily: `"${st.font}", "Plex Thai", sans-serif`, fontWeight: String(st.weight), color: st.color, background: bg,
      textShadow: st.stroke && st.strokeWidth ? `0 0 2px ${st.stroke}, 0 0 2px ${st.stroke}` : 'none',
      borderLeft: st.bg === 'bar' ? '3px solid #FFD60A' : null,
    },
  }, 'กข Aa');
}
