// The job list, kept in this browser (IndexedDB). Videos are never copied here: a job stores names, sizes,
// every decision, a small thumbnail and (Edge/Chrome) the folder or file handles to reopen the originals.
const DB_NAME = 'clipcut';
const STORE = 'jobs';

let opening = null;
function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => {
        r.result.onversionchange = () => { r.result.close(); opening = null; };
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('ปิดแท็บ ClipCut อื่นแล้วลองใหม่'));
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('บันทึกไม่สำเร็จ'));
  }));
}

export const listJobs = () => run('readonly', (s) => s.getAll());
export const getJob = (id) => run('readonly', (s) => s.get(id));
export const putJob = (job) => run('readwrite', (s) => s.put(job));
export const deleteJob = (id) => run('readwrite', (s) => s.delete(id));

/** Ask the browser not to clear the job list when disk space runs low. Silent; fine if refused. */
export function keepStorage() {
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not supported */ }
}
