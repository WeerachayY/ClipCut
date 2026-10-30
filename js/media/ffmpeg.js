// Wrapper around ffmpeg.wasm (single-thread core, vendored in /vendor so it works offline).
// - Loads lazily on first use (about 32 MB, cached by the service worker afterwards).
// - Input videos are mounted with WORKERFS: ffmpeg reads them straight from disk in small
//   pieces instead of copying whole recordings into memory.
// - One command at a time; cancel() kills the worker and the next call reloads it.
import { FFmpeg } from '../../vendor/ffmpeg/index.js';

const CORE_URL = new URL('../../vendor/core/ffmpeg-core.js', import.meta.url).href;
const WASM_URL = new URL('../../vendor/core/ffmpeg-core.wasm', import.meta.url).href;

/** "time=00:12:34.56" in ffmpeg's stats line -> seconds */
export function parseStatsTime(line) {
  const m = line.match(/time=\s*(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return m[1] ? -v : v;
}

class FFmpegService {
  constructor() {
    this.ff = null;
    this.loading = null;
    this.mounted = [];         // mount points currently in use
    this.mountKey = null;
    this.queue = Promise.resolve();
    this.logListeners = new Set();
  }

  get isLoaded() { return !!this.ff; }

  async load(onStatus) {
    if (this.ff) return this.ff;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      onStatus?.('กำลังโหลดตัวประมวลผลวิดีโอ (ครั้งแรกราว 32 MB)…');
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => this.logListeners.forEach((fn) => fn(message)));
      await ff.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
      this.ff = ff;
      this.mounted = [];
      this.mountKey = null;
      onStatus?.('พร้อมใช้งาน');
      return ff;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  /** Serialise all calls: ffmpeg.wasm runs one command at a time. */
  #enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Mount input files read-only. Each file gets its own folder so equal names never clash.
   * @param {File[]} files
   * @returns {Promise<string[]>} paths inside ffmpeg's filesystem, same order as files
   */
  mountInputs(files) {
    return this.#enqueue(async () => {
      const ff = await this.load();
      const key = files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|');
      if (key !== this.mountKey) {
        for (const mp of this.mounted) { try { await ff.unmount(mp); await ff.deleteDir(mp); } catch { /* already gone */ } }
        this.mounted = [];
        try { await ff.createDir('/in'); } catch { /* exists */ }
        for (let i = 0; i < files.length; i++) {
          const mp = `/in/${i}`;
          try { await ff.createDir(mp); } catch { /* exists */ }
          await ff.mount('WORKERFS', { files: [files[i]] }, mp);
          this.mounted.push(mp);
        }
        this.mountKey = key;
      }
      return files.map((f, i) => `/in/${i}/${f.name}`);
    });
  }

  /**
   * Run one ffmpeg command.
   * @param {string[]} args
   * @param {{onLine?:(line:string)=>void, onTime?:(sec:number)=>void}} hooks
   * @returns {Promise<{code:number, log:string[]}>}
   */
  run(args, { onLine, onTime } = {}) {
    return this.#enqueue(async () => {
      const ff = await this.load();
      const log = [];
      const listener = (line) => {
        log.push(line);
        if (log.length > 4000) log.splice(0, 1000);
        onLine?.(line);
        if (onTime) { const t = parseStatsTime(line); if (t != null && t >= 0) onTime(t); }
      };
      this.logListeners.add(listener);
      try {
        const code = await ff.exec(args);
        return { code, log };
      } finally {
        this.logListeners.delete(listener);
      }
    });
  }

  /** Run ffprobe (output usually goes to a file with "-o /path"). */
  probe(args) {
    return this.#enqueue(async () => (await this.load()).ffprobe(args));
  }

  writeText(path, text) { return this.#enqueue(async () => (await this.load()).writeFile(path, new TextEncoder().encode(text))); }
  readFile(path) { return this.#enqueue(async () => (await this.load()).readFile(path)); }
  deleteFile(path) { return this.#enqueue(async () => { try { await (await this.load()).deleteFile(path); } catch { /* not there */ } }); }

  /** Stop whatever is running. The next call starts a fresh worker. */
  cancel() {
    if (this.ff) { try { this.ff.terminate(); } catch { /* ignore */ } }
    this.ff = null;
    this.loading = null;
    this.mounted = [];
    this.mountKey = null;
    this.queue = Promise.resolve();
  }
}

export const ffmpeg = new FFmpegService();
