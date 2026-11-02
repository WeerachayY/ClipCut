// Audio track: the loudness envelope from the 'waveform' media layer, mirrored around the middle like CapCut.
export default {
  id: 'waveform',
  label: 'เสียง',
  order: 20,
  height: 40,
  enabledByDefault: true,
  layer: 'waveform',
  draw(view) {
    const { g, width, height, colors, layer } = view;
    g.fillStyle = colors.waveBg;
    g.fillRect(0, 0, width, height);
    const mid = height / 2;
    if (!layer?.peaks) {
      g.fillStyle = colors.muted;
      g.font = `12px ${colors.font}`;
      g.textBaseline = 'middle';
      const msg = view.progress != null ? `กำลังวัดเสียง ${Math.round(view.progress * 100)}%` : 'คลื่นเสียงจะขึ้นหลังวิเคราะห์เสียง';
      g.fillText(msg, 8, mid);
      return;
    }
    const { rate, peaks } = layer;
    const half = mid - 2;
    g.fillStyle = colors.wave;
    const perPx = rate / view.pxPerSec; // envelope values per pixel
    for (let x = 0; x < width; x++) {
      const a = (view.t0 + x / view.pxPerSec) * rate;
      let i0 = Math.floor(a);
      const i1 = Math.max(i0 + 1, Math.floor(a + perPx));
      if (i0 >= peaks.length) break;
      let m = 0;
      for (let i = Math.max(0, i0); i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      if (perPx < 1 && i0 + 1 < peaks.length) { // zoomed past the data: blend neighbours so it is not blocky
        const f = a - i0;
        m = peaks[i0] * (1 - f) + peaks[i0 + 1] * f;
      }
      const hh = Math.max(0.5, (m / 255) * half);
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
  },
};
