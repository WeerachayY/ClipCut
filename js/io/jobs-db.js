// The job list, kept in this browser (IndexedDB). The recordings are never copied here: a job stores names,
// sizes, every decision, a small thumbnail and (Edge/Chrome) the folder or file handles to reopen the originals.
// Media added on top (music, pictures, short overlay videos) is kept in 'assets', so a job reopens complete.
const DB_NAME = 'clipcut';
const STORE = 'jobs';
const ASSETS = 'assets';

let opening = null;
function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(ASSETS)) d.createObjectStore(ASSETS, { keyPath: 'id' });
      };
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

function run(mode, fn, store = STORE) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
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

// ---------- media added to compositions ----------
export const putAsset = (a) => run('readwrite', (s) => s.put(a), ASSETS);
export const getAsset = (id) => run('readonly', (s) => s.get(id), ASSETS);
export const deleteAsset = (id) => run('readwrite', (s) => s.delete(id), ASSETS);
export const assetIds = () => run('readonly', (s) => s.getAllKeys(), ASSETS);

/** Remove media no job uses any more (after a job is removed). */
export async function pruneAssets() {
  const used = new Set((await listJobs()).flatMap((j) => (j.project?.compose?.clips || []).map((c) => c.asset).filter(Boolean)));
  for (const id of await assetIds()) if (!used.has(id)) await deleteAsset(id);
}
