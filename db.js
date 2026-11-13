// Stockage local (IndexedDB) — tout fonctionne hors ligne.
// Stores : expenses (notes), photos (images des tickets), trips (déplacements), meta (réglages, état de sync)
const DB_NAME = 'notes-de-frais';
const DB_VERSION = 2;
let _db;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('expenses')) {
        const s = db.createObjectStore('expenses', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export const DB = {
  async allExpenses({ includeDeleted = false } = {}) {
    const all = await tx('expenses', 'readonly', s => reqP(s.getAll()));
    return (all || []).filter(e => includeDeleted || !e.deleted);
  },
  getExpense(id) { return tx('expenses', 'readonly', s => reqP(s.get(id))); },
  putExpense(e) { return tx('expenses', 'readwrite', s => reqP(s.put(e))); },
  // includeConfig : inclut les enregistrements de réglages (ex. mois clôturés), utile pour la synchro
  async allTrips({ includeDeleted = false, includeConfig = false } = {}) {
    const all = await tx('trips', 'readonly', s => reqP(s.getAll()));
    return (all || []).filter(t => (includeDeleted || !t.deleted) && (includeConfig || !t.kind));
  },
  getTrip(id) { return tx('trips', 'readonly', s => reqP(s.get(id))); },
  putTrip(t) { return tx('trips', 'readwrite', s => reqP(s.put(t))); },
  putPhoto(id, blob) { return tx('photos', 'readwrite', s => reqP(s.put(blob, id))); },
  getPhoto(id) { return tx('photos', 'readonly', s => reqP(s.get(id))); },
  deletePhoto(id) { return tx('photos', 'readwrite', s => reqP(s.delete(id))); },
  getMeta(key, fallback = null) {
    return tx('meta', 'readonly', s => reqP(s.get(key))).then(v => (v === undefined ? fallback : v));
  },
  setMeta(key, val) { return tx('meta', 'readwrite', s => reqP(s.put(val, key))); },
  async requestPersistence() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
    return false;
  }
};
