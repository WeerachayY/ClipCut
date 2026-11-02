// Small DOM helpers, icons, toasts and dialogs. No framework.

/** h('button.primary', {onclick}, 'text', child) */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const P = {
  play: '<path d="M7 5v14l11-7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  back: '<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/>',
  chev1L: '<path d="M14 6l-6 6 6 6"/>',
  chev2L: '<path d="M11 6l-6 6 6 6M18 6l-6 6 6 6"/>',
  chev3L: '<path d="M8 6l-6 6 6 6M14 6l-6 6 6 6M20 6l-6 6 6 6"/>',
  chev1R: '<path d="M10 6l6 6-6 6"/>',
  chev2R: '<path d="M6 6l6 6-6 6M13 6l6 6-6 6"/>',
  chev3R: '<path d="M4 6l6 6-6 6M10 6l6 6-6 6M16 6l6 6-6 6"/>',
  toStart: '<path d="M6 5v14M18 6l-8 6 8 6z"/>',
  toEnd: '<path d="M18 5v14M6 6l8 6-8 6z"/>',
  undo: '<path d="M9 4L4 9l5 5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 4l5 5-5 5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  fwd: '<path d="M13 7l5 5-5 5M6 7l5 5-5 5"/>',
  scissors: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5L19 18M8 15.5L19 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  ear: '<path d="M7 9.5a5 5 0 0 1 10 0c0 3-3 3.5-3 6.5a2.5 2.5 0 0 1-5 0"/><path d="M10 10a2 2 0 0 1 4 0"/>',
  pin: '<path d="M12 21s6-5.6 6-11a6 6 0 0 0-12 0c0 5.4 6 11 6 11z"/><circle cx="12" cy="10" r="2"/>',
  split: '<path d="M12 3v18"/><path d="M8 7l4-4 4 4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.2v.1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

let toastHost;
export function toast(message, kind = 'info', ms = 5000) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h(`div.toast.${kind}`, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Native <dialog>. Resolves with the value of the clicked button, or null when dismissed. */
export function ask({ title, body, buttons }) {
  return new Promise((resolve) => {
    const dlg = h('dialog.dlg',
      h('h2', title),
      body ? h('div.dlg-body', body) : null,
      h('div.dlg-actions', buttons.map((b) => h(`button.${b.kind || 'secondary'}`, { autofocus: b.kind === 'primary', onclick: () => { dlg.close(); resolve(b.value); } }, b.label))));
    dlg.addEventListener('cancel', () => resolve(null));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function busy(message) {
  const label = h('p.busy-msg', message);
  const bar = h('div.bar', h('div.bar-fill'));
  const dlg = h('dialog.dlg.busy', h('div.spinner', { 'aria-hidden': 'true' }), label, bar);
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
  return {
    update(msg, ratio) {
      if (msg) label.textContent = msg;
      if (ratio != null) { bar.classList.add('on'); bar.firstChild.style.width = `${Math.round(ratio * 100)}%`; }
    },
    close() { dlg.close(); dlg.remove(); },
  };
}
