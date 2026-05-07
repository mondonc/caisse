// sync.js — Background sync manager
//
// Principe bête et méchant :
//   Toute transaction locale avec synced=0 est retentée indéfiniment
//   jusqu'à ce que le serveur réponde HTTP 2xx.
//   L'UI n'est jamais bloquée : toutes les opérations réseau sont
//   en tâche de fond.
//
// Déclencheurs de retry :
//   1. Immédiatement au démarrage (si en ligne)
//   2. Dès que le réseau revient (événement 'online')
//   3. Toutes les RETRY_INTERVAL_MS secondes (si en ligne)
//   4. Via la Background Sync API du Service Worker (persiste même
//      si l'onglet est fermé/en arrière-plan)
//   5. Explicitement par requestSync() après chaque nouvelle vente

import { dbGetAllByIndex, dbPut } from './db.js';

const API              = './api';
const RETRY_INTERVAL_MS = 30_000;

let _syncRunning = false;
let _statusCbs   = [];

// ─── Notifications de statut vers l'UI ───────────────────────

export function onSyncStatus(cb) { _statusCbs.push(cb); }
function emit(status) { _statusCbs.forEach(cb => cb(status)); }

// ─── API Catalogue ────────────────────────────────────────────

export async function pushCatalog(payload) {
  const res = await fetch(`${API}/catalog.php`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`catalog push HTTP ${res.status}`);
  return res.json();
}

export async function pullCatalog() {
  const res = await fetch(`${API}/catalog.php`);
  if (!res.ok) throw new Error(`catalog pull HTTP ${res.status}`);
  return res.json();
}

// ─── Boucle de sync des transactions ─────────────────────────
//
// Pour chaque transaction synced=0 :
//   - Envoi POST au serveur (idempotent côté serveur, dédupliqué par id)
//   - Si HTTP 2xx → synced=1 dans IndexedDB → c'est fini pour cette tx
//   - Sinon (réseau coupé, erreur serveur) → synced reste 0 → retenté au prochain tour
//
// La fonction est réentrante-safe via _syncRunning.

export async function syncPendingTransactions() {
  if (_syncRunning) return;  // déjà en cours, on laisse tourner
  _syncRunning = true;
  emit('syncing');

  try {
    const pending = await dbGetAllByIndex('transactions', 'synced', 0);

    if (pending.length === 0) {
      emit(navigator.onLine ? 'online' : 'offline');
      return;
    }

    let nOk   = 0;
    let nFail = 0;

    for (const tx of pending) {
      let acked = false;
      try {
        const res = await fetch(`${API}/transactions.php`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(tx),
        });
        acked = res.ok;
      } catch {
        // Réseau indisponible pour cette tx — on passe à la suivante
      }

      if (acked) {
        // Acquittement confirmé → marquer définitivement
        tx.synced = 1;
        await dbPut('transactions', tx);
        nOk++;
      } else {
        nFail++;
        // synced reste 0, sera retenté au prochain déclencheur
      }
    }

    emit(nFail === 0 ? 'synced' : 'pending');

  } finally {
    _syncRunning = false;
  }
}

// ─── Déclencher une sync en arrière-plan (non-bloquant) ───────

export function requestSync() {
  // Priorité : Background Sync API (fonctionne même onglet inactif/fermé)
  if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
    navigator.serviceWorker.ready
      .then(reg => reg.sync.register('sync-transactions'))
      .catch(_fallbackSync);
    return;
  }
  _fallbackSync();
}

function _fallbackSync() {
  if (navigator.onLine) {
    syncPendingTransactions().catch(() => {});
  }
  // Si hors ligne : l'écouteur 'online' déclenchera la sync au retour du réseau
}

// ─── Initialisation ───────────────────────────────────────────

export function initSync() {
  // Déclencheur 1 : retour en ligne
  window.addEventListener('online', () => {
    emit('online');
    syncPendingTransactions().catch(() => {});
  });

  window.addEventListener('offline', () => emit('offline'));

  // Déclencheur 2 : message du Service Worker après sync background
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'SYNC_DONE') {
        // Le SW a terminé un tour de sync → rafraîchir l'indicateur UI
        emit('synced');
      }
    });
  }

  // Déclencheur 3 : filet de sécurité périodique
  setInterval(() => {
    if (navigator.onLine) syncPendingTransactions().catch(() => {});
  }, RETRY_INTERVAL_MS);

  // Déclencheur 4 : au démarrage
  if (navigator.onLine) syncPendingTransactions().catch(() => {});
}
