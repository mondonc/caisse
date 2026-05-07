// db.js — IndexedDB abstraction layer
// Version must be bumped if schema changes

const DB_NAME    = 'caisse_db';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Key-value settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Product catalog
      if (!db.objectStoreNames.contains('catalog')) {
        const s = db.createObjectStore('catalog', { keyPath: 'id', autoIncrement: true });
        s.createIndex('sort_order', 'sort_order');
        s.createIndex('active', 'active');
      }

      // Transactions — id is "timestamp_deviceId", never auto-generated
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id' });
        s.createIndex('synced',    'synced');    // 0 | 1
        s.createIndex('timestamp', 'timestamp');
        s.createIndex('type',      'type');
      }
    };

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = ()  => reject(req.error);
  });
}

// ─── Generic helpers ──────────────────────────────────────────

export async function dbGet(store, key) {
  const db = await openDB();
  return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function dbPut(store, value) {
  const db = await openDB();
  return idbReq(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

export async function dbDelete(store, key) {
  const db = await openDB();
  return idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function dbGetAll(store) {
  const db = await openDB();
  return idbReq(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function dbGetAllByIndex(store, indexName, value) {
  const db = await openDB();
  const idx = db.transaction(store, 'readonly').objectStore(store).index(indexName);
  return idbReq(idx.getAll(IDBKeyRange.only(value)));
}

export async function dbClearStore(store) {
  const db = await openDB();
  return idbReq(db.transaction(store, 'readwrite').objectStore(store).clear());
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Settings helpers ─────────────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const row = await dbGet('settings', key);
  return row != null ? row.value : defaultValue;
}

export async function setSetting(key, value) {
  return dbPut('settings', { key, value });
}

// ─── Device ID (generated once, persisted) ────────────────────

export async function getDeviceId() {
  let id = await getSetting('device_id');
  if (!id) {
    const rand = () => Math.random().toString(36).slice(2, 7);
    id = `dev_${rand()}${rand()}`;
    await setSetting('device_id', id);
  }
  return id;
}
