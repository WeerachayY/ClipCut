// Home: start a new job, or pick up an earlier one.
import { h, clear, icon, toast, ask } from './dom.js';
import { canOpenFolder, canPickFiles, VIDEO_EXT, TRANSCRIPT_EXT } from '../io/folder.js';
import { jobStatus, relativeTime, searchJobs } from '../core/jobs.js';
import { formatTime, formatDuration } from '../core/time.js';

export function mount(root, app) {
  let jobs = null;          // null while loading
  let query = '';
  let renaming = null;      // job id being renamed on its card
  let menu = null;          // {id, el} open card menu
  const thumbs = new Map(); // job id -> {blob, url}

  const input = h('input', {
    type: 'file', multiple: true, hidden: true, accept: [...VIDEO_EXT, ...TRANSCRIPT_EXT, '.json'].join(','),
    onchange: (e) => { if (e.target.files.length) app.newFromFiles(e.target.files); e.target.value = ''; },
  });
  const pickFiles = () => (canPickFiles() ? app.newFromFiles() : input.click());

  const wrap = h('section.home');
  const dropHint = h('div.drop-hint', { 'aria-hidden': 'true' }, h('div', icon('download', 28), h('p', 'วางโฟลเดอร์หรือไฟล์เพื่อเริ่มงานใหม่')));
  root.append(wrap, dropHint, input);

  const thumbUrl = (job) => {
    if (!job.thumb) return null;
    const t = thumbs.get(job.id);
    if (t && t.blob === job.thumb) return t.url;
    if (t) URL.revokeObjectURL(t.url);
    const url = URL.createObjectURL(job.thumb);
    thumbs.set(job.id, { blob: job.thumb, url });
    return url;
  };

  function newJobCard(big) {
    return h(`div.newjob${big ? '.big' : ''}`,
      h('div.nj-icon', icon('plus', big ? 28 : 24)),
      h('div.nj-text',
        h('h2', 'งานใหม่'),
        h('p', canOpenFolder() ? 'เปิดโฟลเดอร์ที่มีวิดีโอ เลือกไฟล์ หรือลากมาวางที่หน้านี้' : 'เลือกไฟล์วิดีโอ หรือลากมาวางที่หน้านี้')),
      h('div.nj-actions',
        canOpenFolder() ? h('button.primary', { type: 'button', onclick: () => app.newFromFolder() }, icon('folder', 18), 'เปิดโฟลเดอร์') : null,
        h(canOpenFolder() ? 'button.secondary' : 'button.primary', { type: 'button', onclick: pickFiles }, icon('file', 18), 'เลือกไฟล์')));
  }

  function summaryLine(job) {
    const s = job.summary;
    if (!s || !s.duration) return `${job.videos?.length || 0} ไฟล์`;
    const bits = [`${s.files} ไฟล์`];
    if (s.cut > 0.5) bits.push(`ตัดออก ${formatDuration(s.cut)}`);
    else bits.push(s.marks ? 'ยังไม่ได้ทิ้งช่วงไหน' : 'ยังไม่ได้ตัด');
    if (s.parts > 1) bits.push(`แบ่ง ${s.parts} ตอน`);
    return bits.join(' · ');
  }

  function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    menu = null;
  }

  function openMenu(job, anchor) {
    const same = menu?.id === job.id;
    closeMenu();
    if (same) return;
    const item = (label, ic, fn, cls = '') => h(`button.menu-item${cls}`, { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); fn(); } }, icon(ic, 16), label);
    const el = h('div.job-menu', { role: 'menu' },
      item('เปิดงาน', 'arrowRight', () => open(job)),
      item('เปลี่ยนชื่อ', 'pencil', () => startRename(job)),
      item('ทำสำเนา', 'copy', () => duplicate(job)),
      item('ดาวน์โหลดไฟล์งาน', 'save', () => app.downloadJobFile(job)),
      h('hr'),
      item('ลบออกจากรายการ', 'trash', () => remove(job), '.danger'));
    anchor.closest('.job').append(el);
    menu = { id: job.id, el };
    el.querySelector('button')?.focus();
  }

  async function open(job) {
    closeMenu();
    await app.openJob(job);
    if (app.store.get().step === 'home') load(); // still here: show a "files not found" badge if it changed
  }

  function startRename(job) {
    renaming = job.id;
    render();
    const el = wrap.querySelector(`[data-job="${job.id}"] .job-name-input`);
    el?.focus();
    el?.select();
  }

  async function finishRename(job, value, commit) {
    if (renaming !== job.id) return;
    renaming = null;
    if (commit) {
      try {
        const next = await app.renameJob(job, value);
        jobs = jobs.map((j) => (j.id === job.id ? next : j));
      } catch (e) { toast(`เปลี่ยนชื่อไม่สำเร็จ: ${e.message}`, 'error'); }
    }
    render();
    wrap.querySelector(`[data-job="${job.id}"] .job-open`)?.focus();
  }

  async function duplicate(job) {
    try {
      const copy = await app.duplicateJob(job);
      jobs = [copy, ...jobs];
      render();
      toast(`ทำสำเนาเป็น “${copy.name}” แล้ว`);
    } catch (e) { toast(`ทำสำเนาไม่สำเร็จ: ${e.message}`, 'error'); }
  }

  async function remove(job) {
    const ok = await ask({
      title: `ลบ “${job.name}” ออกจากรายการ?`,
      body: job.dir
        ? 'วิดีโอ ไฟล์ที่ส่งออก และไฟล์งานในโฟลเดอร์จะไม่ถูกลบ เปิดโฟลเดอร์นี้อีกครั้งก็ทำต่อได้'
        : 'วิดีโอและไฟล์ที่ส่งออกแล้วจะไม่ถูกลบ แต่จุดตัดของงานนี้จะหายไป (ดาวน์โหลดไฟล์งานเก็บไว้ก่อนได้)',
      buttons: [{ label: 'ยกเลิก', value: false }, { label: 'ลบออกจากรายการ', value: true, kind: 'danger-fill' }],
    });
    if (!ok) return;
    try {
      await app.removeJob(job);
      jobs = jobs.filter((j) => j.id !== job.id);
      render();
    } catch (e) { toast(`ลบไม่สำเร็จ: ${e.message}`, 'error'); }
  }

  function card(job) {
    const st = jobStatus(job);
    const url = thumbUrl(job);
    const name = renaming === job.id
      ? h('input.job-name-input', {
        type: 'text', value: job.name, maxlength: 120, 'aria-label': 'ชื่องาน',
        onkeydown: (e) => { if (e.key === 'Enter') finishRename(job, e.target.value, true); if (e.key === 'Escape') finishRename(job, '', false); },
        onblur: (e) => finishRename(job, e.target.value, true),
      })
      : h('h3.job-name', { title: `${job.name} — ดับเบิลคลิกเพื่อเปลี่ยนชื่อ`, ondblclick: (e) => { e.stopPropagation(); startRename(job); } }, job.name);
    return h('article.job', {
      dataset: { job: job.id },
      onclick: (e) => { if (!e.target.closest('button, input, .job-menu, .job-name')) open(job); },
    },
      h('button.job-open', {
        type: 'button', 'aria-label': `เปิดงาน ${job.name}`, onclick: () => open(job),
        onkeydown: (e) => { if (e.key === 'F2') { e.preventDefault(); startRename(job); } },
      },
        url ? h('img', { src: url, alt: '' }) : h('span.job-ph', icon('film', 30)),
        job.summary?.duration ? h('span.job-dur', formatTime(job.summary.duration)) : null),
      h('div.job-body',
        h('div.job-head', name,
          h('button.ghost.icon-only.job-more', { type: 'button', 'aria-label': `ตัวเลือกของ ${job.name}`, 'aria-haspopup': 'menu', onclick: (e) => openMenu(job, e.currentTarget) }, icon('more', 18))),
        h('p.job-meta', icon(job.dir ? 'folder' : 'file', 14), h('span', job.dir ? job.source?.name || 'โฟลเดอร์' : (job.videos || []).map((v) => v.name).join(', '))),
        h('p.job-meta', summaryLine(job)),
        h('div.job-foot',
          h(`span.job-status.st-${st.id}`, st.label),
          h('span.job-when', relativeTime(Math.max(job.openedAt || 0, job.editedAt || 0)))),
        st.id === 'missing' ? h('button.secondary.small.job-relink', { type: 'button', onclick: () => open(job) }, 'ชี้ไฟล์ใหม่') : null));
  }

  function render() {
    closeMenu();
    if (jobs === null) { clear(wrap); return; }
    if (!jobs.length) {
      clear(wrap, h('div.home-empty',
        h('img.home-logo', { src: './icons/icon.svg', alt: '', width: 120, height: 120 }),
        h('h1', 'ClipCut'),
        h('p.lede', 'ตัดช่วงที่ไม่ต้องการออกจากวิดีโอ ต่อหลายไฟล์เป็นไฟล์เดียว หรือแบ่งเป็นหลายตอน'),
        newJobCard(true),
        h('ol.home-steps',
          h('li', h('span.n', '1'), h('div', h('strong', 'เปิดวิดีโอ'), h('p', 'พร้อม transcript ถ้ามี'))),
          h('li', h('span.n', '2'), h('div', h('strong', 'ตรวจจุดตัด'), h('p', 'แอปเสนอช่วงพักและช่วงเงียบ คุณเลือกทิ้งหรือเก็บ'))),
          h('li', h('span.n', '3'), h('div', h('strong', 'ส่งออก'), h('p', 'ได้ไฟล์ใหม่ข้างไฟล์ต้นฉบับ')))),
        privacy()));
      return;
    }
    const search = h('label.job-search', icon('search', 16), h('input', {
      type: 'search', placeholder: 'ค้นหางาน', value: query, 'aria-label': 'ค้นหางาน',
      oninput: (e) => { query = e.target.value; renderGrid(); },
    }));
    const grid = h('div.job-grid');
    const count = h('span.count');
    function renderGrid() {
      const list = searchJobs(jobs, query);
      count.textContent = query ? `${list.length} จาก ${jobs.length} งาน` : `${jobs.length} งาน`;
      clear(grid, list.length ? list.map(card) : h('p.empty', `ไม่พบงานที่ตรงกับ “${query}”`));
    }
    clear(wrap,
      newJobCard(false),
      h('div.jobs-head', h('h2', 'งานล่าสุด'), count, h('span.grow'), jobs.length > 3 ? search : null),
      grid,
      privacy());
    renderGrid();
  }

  const privacy = () => h('p.home-privacy', icon('lock', 14), 'ไฟล์ไม่ออกจากเครื่อง ประมวลผลใน browser ทั้งหมด ไม่มีการอัปโหลดและไม่ใช้ AI');

  async function load() {
    jobs = await app.listJobs();
    render();
  }

  const onDocClick = (e) => { if (menu && !e.target.closest('.job-menu, .job-more')) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape' && menu) { const id = menu.id; closeMenu(); wrap.querySelector(`[data-job="${id}"] .job-more`)?.focus(); } };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
  load();

  return () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    thumbs.forEach((t) => URL.revokeObjectURL(t.url));
  };
}
