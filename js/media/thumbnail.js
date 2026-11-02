// A small still from a video for the job card. Uses the browser's own decoder; resolves null on failure.
export function captureThumbnail(url, { width = 384, height = 216, at = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    let done = false;
    const finish = (blob) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    v.onloadedmetadata = () => {
      // a quarter of the way in: past the waiting screen of most recordings
      const t = at ?? (Number.isFinite(v.duration) ? v.duration * 0.25 : 0);
      v.currentTime = Math.max(0, t);
    };
    v.onseeked = () => {
      try {
        if (!v.videoWidth) { finish(null); return; }
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const g = c.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, width, height);
        const s = Math.min(width / v.videoWidth, height / v.videoHeight);
        const w = v.videoWidth * s;
        const hh = v.videoHeight * s;
        g.drawImage(v, (width - w) / 2, (height - hh) / 2, w, hh);
        c.toBlob((b) => finish(b), 'image/jpeg', 0.8);
      } catch { finish(null); }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}
