// Autosave in IndexedDB, plus small preferences in localStorage. Every call is safe to fail
// (private windows, blocked storage): the app just works without saving.
const DB = 'pixfold', STORE = 'kv';

export interface SavedLayer { name: string; visible: boolean; locked: boolean; opacity: number; blend: string; buffer: ArrayBuffer }
/**
 * `project` (v3) is a compressed .pfold file, so big drawings stay small in storage.
 * Older shapes still load: `layers` (0.2 raw buffers) and `buffer` alone (0.1, one layer).
 */
export interface Saved {
  v?: number; w: number; h: number; project?: Blob; layers?: SavedLayer[]; active?: number; buffer?: ArrayBuffer;
  palette: string[]; fg: string; bg: string; name: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveDoc(s: Saved): Promise<boolean> {
  try {
    const db = await open();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(s, 'current');
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = tx.onabort = () => { db.close(); res(false); };
    });
  } catch { return false; }
}

export async function loadDoc(): Promise<Saved | null> {
  try {
    const db = await open();
    return await new Promise((res) => {
      const r = db.transaction(STORE).objectStore(STORE).get('current');
      r.onsuccess = () => { db.close(); res((r.result as Saved) ?? null); };
      r.onerror = () => { db.close(); res(null); };
    });
  } catch { return null; }
}

export const pref = {
  get(k: string): string | null { try { return localStorage.getItem('pixfold.' + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem('pixfold.' + k, v); } catch { /* ignore */ } },
};
