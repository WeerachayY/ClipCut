// Video track: a row of stills, like the main track in CapCut. Frames come from the browser's decoder
// (media/frames.js); while one decodes, the nearest frame already decoded stands in.
export default {
  id: 'filmstrip',
  label: 'ภาพ',
  order: 10,
  height: 60,
  enabledByDefault: true,
  draw(view) {
    const { g, width, height, frames, colors } = view;
    g.fillStyle = colors.lane;
    g.fillRect(0, 0, width, height);
    if (!frames) return;
    const w = Math.max(24, Math.round(height * frames.aspect()));
    const slot = w / view.pxPerSec; // seconds per still; the grid is anchored at 0 so stills stay put while scrolling
    const first = Math.max(0, Math.floor(view.t0 / slot));
    const last = Math.ceil(view.t1 / slot);
    const wanted = [];
    for (let k = first; k <= last; k++) {
      const start = k * slot;
      if (start >= view.duration) break;
      const t = Math.min(view.duration - 0.05, start + slot / 2);
      const x = Math.round(view.x(start));
      const bmp = frames.get(t);
      const shown = bmp || frames.nearest(t, slot * 3);
      if (shown) g.drawImage(shown, x, 0, w, height);
      else { g.fillStyle = colors.laneAlt; g.fillRect(x, 0, w - 1, height); }
      if (!bmp) wanted.push({ t, tol: slot / 2 });
      g.fillStyle = colors.gap;
      g.fillRect(x + w - 1, 0, 1, height);
    }
    // the middle of the screen first: that is where the user is looking
    const mid = (view.t0 + view.t1) / 2;
    wanted.sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid));
    frames.want(wanted);
  },
};
