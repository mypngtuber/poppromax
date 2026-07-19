/**
 * db.js — IndexedDB persistence layer.
 * Stores: projects (metadata+timeline), assets (binary blobs), kv (settings/cache).
 */
const DB_NAME = 'vtuber_editor';
const DB_VER = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        const s = db.createObjectStore('projects', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('assets')) {
        const s = db.createObjectStore('assets', { keyPath: 'id' });
        s.createIndex('category', 'category');
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  }));
}

export const db = {
  // ---- projects ----
  saveProject: (p) => tx('projects', 'readwrite', s => s.put(p)),
  getProject: (id) => tx('projects', 'readonly', s => s.get(id)).then(r => r ?? null),
  deleteProject: (id) => tx('projects', 'readwrite', s => s.delete(id)),
  listProjects: () => tx('projects', 'readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => y.updatedAt - x.updatedAt)),

  // ---- assets (blobs) ----
  saveAsset: (a) => tx('assets', 'readwrite', s => s.put(a)),
  getAsset: (id) => tx('assets', 'readonly', s => s.get(id)).then(r => r ?? null),
  deleteAsset: (id) => tx('assets', 'readwrite', s => s.delete(id)),
  listAssets: () => tx('assets', 'readonly', s => s.getAll()).then(a => a || []),

  // ---- kv (settings / caches / autosave) ----
  kvSet: (key, val) => openDb().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(val, key);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  })),
  kvGet: (key) => openDb().then(db => new Promise((res, rej) => {
    const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error);
  })),
  kvDel: (key) => openDb().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').delete(key);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  })),
};

/** Asset object URL cache — avoids recreating blob URLs */
const urlCache = new Map();
export async function assetUrl(assetId) {
  if (!assetId) return null;
  if (urlCache.has(assetId)) return urlCache.get(assetId);
  const a = await db.getAsset(assetId);
  if (!a?.blob) return null;
  const url = URL.createObjectURL(a.blob);
  urlCache.set(assetId, url);
  return url;
}
export function invalidateAssetUrl(assetId) {
  const u = urlCache.get(assetId);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(assetId); }
}
