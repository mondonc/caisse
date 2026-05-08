// sw.js — Service Worker
// Cache-first for app shell. Network-only for API (with graceful fail).
// Background Sync for pending transactions.

const CACHE_NAME = 'caisse-v3';

const PRECACHE = [
  './',
  './index.html',
  './app.css',
  './js/db.js',
  './js/sync.js',
  './js/app.js',
  './manifest.json',
];

// ─── Install: pre-cache app shell ─────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: clean old caches ───────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch: cache-first for shell, network-only for API ───────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls: network-only, never cache
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status:  503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Google Fonts and external: network-first, cache fallback
  if (url.hostname !== self.location.hostname) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell: cache-first, update in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      });
      return cached || networkFetch;
    })
  );
});

// ─── Background Sync ──────────────────────────────────────────

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-transactions') {
    event.waitUntil(doSyncFromSW());
  }
});

async function doSyncFromSW() {
  const db = await openIDB();
  const pending = await getUnsyncedTx(db);
  if (pending.length === 0) return;

  let anyFailed = false;

  for (const tx of pending) {
    let acked = false;
    try {
      const res = await fetch('./api/transactions.php', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(tx),
      });
      acked = res.ok;
    } catch {
      // Réseau indisponible pour cette tx
    }

    if (acked) {
      tx.synced = 1;
      await saveTx(db, tx);
    } else {
      anyFailed = true;
      // synced reste 0 → sera retenté au prochain sync event
    }
  }

  // Notifier les onglets ouverts seulement si tout est passé
  if (!anyFailed) {
    const clients = await self.clients.matchAll();
    clients.forEach(c => c.postMessage({ type: 'SYNC_DONE' }));
  }

  // Si des transactions ont échoué : rejeter → la Background Sync API
  // replanifiera automatiquement un nouveau 'sync' event plus tard.
  if (anyFailed) {
    throw new Error('Some transactions pending — will retry');
  }
}

// ─── Minimal IndexedDB helpers for SW ─────────────────────────

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('caisse_db', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    // If DB doesn't exist yet, the main app hasn't run — nothing to sync
    req.onblocked = () => reject(new Error('DB blocked'));
  });
}

function getUnsyncedTx(db) {
  return new Promise((resolve, reject) => {
    const store = db.transaction('transactions', 'readonly').objectStore('transactions');
    const idx   = store.index('synced');
    const req   = idx.getAll(IDBKeyRange.only(0));
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function saveTx(db, tx) {
  return new Promise((resolve, reject) => {
    const store = db.transaction('transactions', 'readwrite').objectStore('transactions');
    const req   = store.put(tx);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
