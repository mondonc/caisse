// app.js — Main application
// Imports
import {
  openDB, dbGet, dbPut, dbDelete, dbGetAll,
  dbGetAllByIndex, dbClearStore,
  getSetting, setSetting, getDeviceId,
} from './db.js';

import {
  initSync, requestSync, syncPendingTransactions,
  pushCatalog, pullCatalog, onSyncStatus,
} from './sync.js';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

const state = {
  deviceId: null,

  catalog: [],   // active products sorted by sort_order

  cart: [],      // [{id, name, price, color, qty}]

  config: {
    serviceName: 'Caisse',
    paymentMethods: {
      cash:    true,
      voucher: true,
      cb:      true,
      phone:   false,
    },
    cashOpening: 0,   // fond de caisse
  },

  // Fond de caisse
  fondCaisse: {
    cash:        0,
    voucher:     0,
    recorded_at: null,
  },
  fondCaisseHistory: [],  // [{cash, voucher, recorded_at}] — toutes les saisies

  // Payment flow
  pay: {
    active:        false,
    step:          null,    // 'method'|'amount'|'cb_type'|'change'|'confirm'
    method:        null,    // 'cash_voucher'|'cb'
    cbType:        null,    // 'cb'|'phone'
    cashGiven:     0,
    voucherGiven:  0,
    changeAmount:  0,
    changeMethod:  null,    // 'cash'|'voucher'
  },

  // Refund
  refund: {
    method: 'cash',
  },
};

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtNum = (n) => fmt.format(n);
const round2 = (n) => Math.round(n * 100) / 100;

function parseAmount(str) {
  if (str === '' || str == null) return 0;
  return round2(parseFloat(String(str).replace(',', '.')) || 0);
}

/** Auto-select readable text color (black/white) for a given bg */
function contrastColor(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.substr(0,2),16);
  const g = parseInt(hex.substr(2,2),16);
  const b = parseInt(hex.substr(4,2),16);
  // Relative luminance
  const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function $ (sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

async function init() {
  // Initialiser la navigation history (bouton précédent)
  initHistory();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'SYNC_DONE') toast('Synchronisé', 'success');
    });
  }

  // Load device ID & settings
  state.deviceId = await getDeviceId();
  const savedConfig = await getSetting('config');
  if (savedConfig) {
    // Merge profond : préserver les clés imbriquées (paymentMethods) non stockées
    state.config = {
      ...state.config,
      ...savedConfig,
      paymentMethods: { ...state.config.paymentMethods, ...(savedConfig.paymentMethods ?? {}) },
    };
  }

  // Charger le fond de caisse
  const savedFond = await getSetting('fond_caisse');
  if (savedFond) state.fondCaisse = savedFond;

  const savedFondHistory = await getSetting('fond_caisse_history');
  if (Array.isArray(savedFondHistory)) state.fondCaisseHistory = savedFondHistory;

  // Reflect service name in header
  $('#service-name').textContent = state.config.serviceName;

  // Load catalog from local DB
  await reloadCatalog();

  // Init sync + status indicator
  initSync();
  onSyncStatus(updateSyncDot);
  updateSyncDot(navigator.onLine ? 'online' : 'offline');

  // Try pulling catalog from server in background
  tryCatalogSync();

  // Wire up events
  bindEvents();

  // Render initial state
  renderProductGrid();
  renderCartBar();
}

// ═══════════════════════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════════════════════

async function reloadCatalog() {
  const all = await dbGetAll('catalog');
  all.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  state.catalog = all.filter(p => p.active !== false);
}

async function tryCatalogSync() {
  if (!navigator.onLine) return;
  try {
    const remote = await pullCatalog();
    if (!Array.isArray(remote?.products) || remote.products.length === 0) return;

    // Clear + re-insert dans UNE SEULE transaction IndexedDB → atomique.
    // Toute lecture concurrente verra soit l'ancien catalogue complet,
    // soit le nouveau. Jamais un état intermédiaire vide.
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx    = db.transaction('catalog', 'readwrite');
      const store = tx.objectStore('catalog');
      store.clear();
      for (const p of remote.products) store.put(p);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });

    await reloadCatalog();
    renderProductGrid();
  } catch { /* offline ou erreur serveur — données locales utilisées */ }
}

async function saveCatalogToServer() {
  const all = await dbGetAll('catalog');
  try {
    await pushCatalog({ products: all });
    toast('Catalogue synchronisé', 'success');
  } catch (e) {
    console.error("[rapport] Erreur:", e);
    toast('Synchronisation échouée — réessayez', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT GRID
// ═══════════════════════════════════════════════════════════════

function renderProductGrid() {
  const grid = $('#product-grid');
  grid.innerHTML = '';

  if (state.catalog.length === 0) {
    grid.innerHTML = '<div class="no-products">Aucun produit — configurez votre catalogue ⚙</div>';
    return;
  }

  for (const p of state.catalog) {
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.style.backgroundColor = p.color || '#3b82f6';
    const fg = contrastColor(p.color || '#3b82f6');
    btn.style.color = fg;
    btn.dataset.id = p.id;
    btn.innerHTML = `
      <span class="p-name-row">
        <span class="p-name">${escHtml(p.name)}</span><span class="p-count hidden"></span>
      </span>
      <span class="p-price">${fmtNum(p.price)}</span>
    `;
    btn.addEventListener('click', () => addToCart(p));
    grid.appendChild(btn);
  }
}

// ═══════════════════════════════════════════════════════════════
// CART
// ═══════════════════════════════════════════════════════════════

function addToCart(product) {
  const existing = state.cart.find(i => i.id === product.id);
  if (existing) {
    existing.qty += 1;
  } else {
    state.cart.push({ id: product.id, name: product.name, price: product.price, color: product.color, qty: 1 });
  }
  renderCartBar();
  if (!$('#cart-sheet').classList.contains('hidden')) renderCartSheet();
}

function updateQty(productId, delta) {
  const item = state.cart.find(i => i.id === productId);
  if (!item) return;
  item.qty = Math.max(0, item.qty + delta);
  if (item.qty === 0) state.cart = state.cart.filter(i => i.id !== productId);
  renderCartBar();
  renderCartSheet();
}

function cartTotal() {
  return round2(state.cart.reduce((s, i) => s + i.price * i.qty, 0));
}

function cartItemCount() {
  return state.cart.reduce((s, i) => s + i.qty, 0);
}

function clearCart() {
  state.cart = [];
  renderCartBar();
  renderCartSheet();
}

// ─── Compteurs produits sur la grille ────────────────────────

function updateProductCounts() {
  state.catalog.forEach(p => {
    const btn     = $('#product-grid [data-id="' + p.id + '"]');
    if (!btn) return;
    const countEl = btn.querySelector('.p-count');
    if (!countEl) return;
    const item = state.cart.find(i => i.id === p.id);
    if (item) {
      countEl.textContent = `(${item.qty})`;
      countEl.classList.remove('hidden');
    } else {
      countEl.textContent = '';
      countEl.classList.add('hidden');
    }
  });
}

// ─── Cart Bar ─────────────────────────────────────────────────

function renderCartBar() {
  const n = cartItemCount();
  const total = cartTotal();
  $('#cart-count-label').textContent = n === 0 ? 'Panier vide' : `${n} article${n > 1 ? 's' : ''}`;
  $('#cart-total-label').textContent = fmtNum(total);
  const empty = (n === 0);
  $('#btn-pay').disabled      = empty;
  $('#btn-checkout').disabled = empty;
  updateProductCounts();
}

// ─── Cart Sheet ───────────────────────────────────────────────

function renderCartSheet() {
  const list = $('#cart-items');
  list.innerHTML = '';

  if (state.cart.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">Panier vide</div>';
  } else {
    for (const item of state.cart) {
      const el = document.createElement('div');
      el.className = 'cart-item';
      el.role = 'listitem';
      el.innerHTML = `
        <div class="ci-color" style="background:${item.color||'#444'}"></div>
        <div class="ci-name">${escHtml(item.name)}</div>
        <div class="ci-qty">
          <button class="qty-btn" data-action="minus" data-id="${item.id}" aria-label="Retirer un">−</button>
          <span class="qty-val">${item.qty}</span>
          <button class="qty-btn" data-action="plus"  data-id="${item.id}" aria-label="Ajouter un">+</button>
        </div>
        <div class="ci-price">${fmtNum(item.price * item.qty)}</div>
      `;
      list.appendChild(el);
    }
  }

  $('#cart-total-display').textContent = fmtNum(cartTotal());
  $('#btn-pay').disabled = (state.cart.length === 0);

  // Delegate qty button events
  list.querySelectorAll('.qty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id   = parseInt(btn.dataset.id, 10);
      const delta = btn.dataset.action === 'plus' ? 1 : -1;
      updateQty(id, delta);
    });
  });
}

function openCartSheet() {
  $('#cart-sheet').classList.remove('hidden');
  $('#cart-overlay').classList.remove('hidden');
  $('#cart-bar').classList.add('open');
  renderCartSheet();
}

function closeCartSheet() {
  $('#cart-sheet').classList.add('hidden');
  $('#cart-overlay').classList.add('hidden');
  $('#cart-bar').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════════
// PAYMENT FLOW
// ═══════════════════════════════════════════════════════════════

function startPayment() {
  if (state.cart.length === 0) return;
  closeCartSheet();
  const p = state.pay;
  p.active       = true;
  p.step         = 'method';
  p.method       = null;
  p.cbType       = null;
  p.cashGiven    = 0;
  p.voucherGiven = 0;
  p.changeAmount = 0;
  p.changeMethod = null;

  $('#pay-total-display').textContent = fmtNum(cartTotal());
  $('#payment-modal').classList.remove('hidden');
  history.pushState({ view: 'paiement' }, '', '#paiement');
  renderPayStep();
}

function cancelPayment() {
  state.pay.active = false;
  $('#payment-modal').classList.add('hidden');
  _historyBack('#paiement');
}

// ─── Step router ──────────────────────────────────────────────

function renderPayStep() {
  $('#pay-step-title').textContent = stepTitle(state.pay.step);
  $('#pay-body').innerHTML = '';
  $('#pay-footer').innerHTML = '';

  switch (state.pay.step) {
    case 'method':   renderPayMethod();   break;
    case 'amount':   renderPayAmount();   break;
    case 'cb_type':  renderPayCBType();   break;
    case 'change':   renderPayChange();   break;
    case 'confirm':  renderPayConfirm();  break;
  }
}

function stepTitle(step) {
  return { method:'Paiement', amount:'Montants', cb_type:'Mode CB', change:'Rendu de monnaie', confirm:'Confirmation' }[step] || 'Paiement';
}

// ─── Step 1 : Method ──────────────────────────────────────────

function renderPayMethod() {
  const pm = state.config.paymentMethods;
  const body = $('#pay-body');
  body.innerHTML = `<div class="pay-label">Mode de paiement</div><div class="choice-grid" id="method-grid"></div>`;

  const grid = $('#method-grid');

  // Button: Liquide / Bon (always shown — cash & voucher never fully disabled)
  const btnLV = choiceBtnBig('💵', 'Liquide / Bon', 'cash_voucher');
  grid.appendChild(btnLV);

  // Button: CB (if cb OR phone is active)
  if (pm.cb || pm.phone) {
    const btnCB = choiceBtnBig('💳', 'CB', 'cb');
    grid.appendChild(btnCB);
  }

  // Juste "Annuler" — la sélection avance directement
  $('#pay-footer').innerHTML = `
    <div class="btn-row">
      <button class="btn-secondary" id="pay-btn-cancel">Annuler</button>
    </div>`;

  $('#pay-btn-cancel').addEventListener('click', cancelPayment);

  // Sélection = navigation immédiate vers l'étape suivante
  grid.querySelectorAll('.choice-btn-big').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pay.method = btn.dataset.value;
      if (state.pay.method === 'cash_voucher') {
        state.pay.step = 'amount';
      } else {
        const pm = state.config.paymentMethods;
        if (pm.cb && pm.phone) {
          state.pay.step = 'cb_type';
        } else {
          state.pay.cbType = pm.cb ? 'cb' : 'phone';
          state.pay.step = 'confirm';
        }
      }
      renderPayStep();
    });
  });
}

// ─── Step 2a : Amounts (cash + voucher) ───────────────────────

function renderPayAmount() {
  const total = cartTotal();
  const body = $('#pay-body');

  body.innerHTML = `
    <div class="pay-summary" id="pay-summary-box">
      ${summaryRow('À payer', fmtNum(total), true)}
    </div>
    <div>
      <div class="pay-label">Donné par le client</div>
      <div class="amount-field" style="margin-bottom:10px">
        <label>Liquide</label>
        <div class="amount-row">
          <input type="number" id="input-cash" min="0" step="0.01"
                 placeholder="0.00" inputmode="decimal" value="">
          <span class="currency">€</span>
        </div>
      </div>
      <div class="amount-field">
        <label>Bons</label>
        <div class="amount-row">
          <input type="number" id="input-voucher" min="0" step="0.01"
                 placeholder="0.00" inputmode="decimal" value="">
          <span class="currency">€</span>
        </div>
      </div>
    </div>
    <div id="amount-feedback" style="text-align:center;color:var(--text-dim);font-size:0.9rem;min-height:20px"></div>
  `;

  $('#pay-footer').innerHTML = `
    <div class="btn-row">
      <button class="btn-secondary" id="pay-btn-back">← Retour</button>
      <button class="btn-primary" id="pay-btn-next2" disabled>Suivant →</button>
    </div>`;

  $('#pay-btn-back').addEventListener('click', () => { state.pay.step = 'method'; renderPayStep(); });
  $('#pay-btn-next2').addEventListener('click', () => {
    const cashGiven    = parseAmount($('#input-cash').value);
    const voucherGiven = parseAmount($('#input-voucher').value);
    const total        = cartTotal();
    const totalGiven   = round2(cashGiven + voucherGiven);
    const change       = round2(totalGiven - total);

    state.pay.cashGiven    = cashGiven;
    state.pay.voucherGiven = voucherGiven;
    state.pay.changeAmount = change;

    if (change > 0 && cashGiven > 0) {
      // Both cash and voucher change possible → choose
      state.pay.step = 'change';
    } else {
      // No change, or only vouchers given (change in voucher only — skip choice)
      state.pay.changeMethod = cashGiven === 0 ? 'voucher' : 'cash';
      state.pay.step = 'confirm';
    }
    renderPayStep();
  });

  // Live feedback
  const updateFeedback = () => {
    const cash    = parseAmount($('#input-cash').value);
    const voucher = parseAmount($('#input-voucher').value);
    const total   = cartTotal();
    const given   = round2(cash + voucher);
    const fb      = $('#amount-feedback');
    const nextBtn = $('#pay-btn-next2');

    if (given === 0) {
      fb.textContent = '';
      nextBtn.disabled = true;
      return;
    }
    if (given < total) {
      fb.innerHTML = `<span style="color:var(--danger)">Insuffisant — manque ${fmtNum(round2(total - given))}</span>`;
      nextBtn.disabled = true;
    } else {
      const change = round2(given - total);
      fb.innerHTML = change > 0
        ? `Rendu : <strong style="color:var(--accent)">${fmtNum(change)}</strong>`
        : `<span style="color:var(--success)">Montant exact ✓</span>`;
      nextBtn.disabled = false;
    }
  };

  $('#input-cash').addEventListener('input', updateFeedback);
  $('#input-voucher').addEventListener('input', updateFeedback);

  // Enter ferme le clavier mobile sans valider le formulaire
  ['#input-cash', '#input-voucher'].forEach(sel => {
    $(sel)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $(sel).blur(); }
    });
  });

  $('#input-cash').focus();
}

// ─── Step 2b : CB type selection ──────────────────────────────

function renderPayCBType() {
  const body = $('#pay-body');
  body.innerHTML = `
    <div class="pay-label">Mode de paiement sans espèces</div>
    <div class="choice-grid">
      ${choiceBtnBigHTML('🖥️', 'Terminal CB', 'cb')}
      ${choiceBtnBigHTML('📱', 'Téléphone', 'phone')}
    </div>`;

  // Juste "Retour" — la sélection avance directement
  $('#pay-footer').innerHTML = `
    <div class="btn-row">
      <button class="btn-secondary" id="pay-btn-back">← Retour</button>
    </div>`;

  $('#pay-btn-back').addEventListener('click', () => { state.pay.step = 'method'; renderPayStep(); });

  body.querySelectorAll('.choice-btn-big').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pay.cbType = btn.dataset.value;
      state.pay.step = 'confirm';
      renderPayStep();
    });
  });
}

// ─── Step 3 : Change method ───────────────────────────────────

function renderPayChange() {
  const change = state.pay.changeAmount;
  const cashGiven = state.pay.cashGiven;
  const body = $('#pay-body');

  body.innerHTML = `
    <div class="change-display">
      <div class="change-amount">${fmtNum(change)}</div>
      <div class="change-label">à rendre au client</div>
    </div>
    <div>
      <div class="pay-label">Rendre la monnaie en</div>
      <div class="choice-grid">
        ${cashGiven > 0 ? choiceBtnBigHTML('💵', 'Liquide', 'cash') : ''}
        ${choiceBtnBigHTML('🎟️', 'Bons', 'voucher')}
      </div>
    </div>`;

  $('#pay-footer').innerHTML = `
    <div class="btn-row">
      <button class="btn-secondary" id="pay-btn-back">← Retour</button>
      <button class="btn-primary" id="pay-btn-next4" disabled>Confirmer →</button>
    </div>`;

  $('#pay-btn-back').addEventListener('click', () => { state.pay.step = 'amount'; renderPayStep(); });
  $('#pay-btn-next4').addEventListener('click', () => { state.pay.step = 'confirm'; renderPayStep(); });

  body.querySelectorAll('.choice-btn-big').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.choice-btn-big').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.pay.changeMethod = btn.dataset.value;
      $('#pay-btn-next4').disabled = false;
    });
  });
}

// ─── Step 4 : Confirm ─────────────────────────────────────────

function renderPayConfirm() {
  const pay   = state.pay;
  const total = cartTotal();
  const body  = $('#pay-body');

  const rows = [];
  rows.push(summaryRow('Total à payer', fmtNum(total), true));

  if (pay.method === 'cash_voucher') {
    if (pay.cashGiven > 0)    rows.push(summaryRow('Liquide reçu', fmtNum(pay.cashGiven)));
    if (pay.voucherGiven > 0) rows.push(summaryRow('Bons reçus',   fmtNum(pay.voucherGiven)));
    if (pay.changeAmount > 0) {
      const chLabel = pay.changeMethod === 'cash' ? 'Rendu en liquide' : 'Rendu en bons';
      rows.push(summaryRow(chLabel, fmtNum(pay.changeAmount)));
    }
  } else {
    const lbl = pay.cbType === 'phone' ? 'Paiement téléphone' : 'Terminal CB';
    rows.push(summaryRow(lbl, fmtNum(total)));
  }

  body.innerHTML = `
    <div class="pay-summary">${rows.join('')}</div>
    ${pay.changeAmount > 0 ? `
    <div class="change-display">
      <div class="change-amount">${fmtNum(pay.changeAmount)}</div>
      <div class="change-label">à rendre en ${pay.changeMethod === 'cash' ? 'liquide' : 'bons'}</div>
    </div>` : ''}`;

  $('#pay-footer').innerHTML = `
    <div class="pay-warning-box">
      ⚠️ Ne valide pas avant que le paiement soit vraiment terminé
    </div>
    <div class="btn-row">
      <button class="btn-secondary" id="pay-btn-back">← Retour</button>
      <button class="btn-primary" id="pay-btn-ok">✓ Valider</button>
    </div>`;

  $('#pay-btn-back').addEventListener('click', () => {
    // Back depends on where we came from
    if (pay.method === 'cash_voucher') {
      state.pay.step = pay.changeAmount > 0 && pay.cashGiven > 0 ? 'change' : 'amount';
    } else {
      const pm = state.config.paymentMethods;
      state.pay.step = (pm.cb && pm.phone) ? 'cb_type' : 'method';
    }
    renderPayStep();
  });

  $('#pay-btn-ok').addEventListener('click', finalizePayment);
}

// ─── Finalize ─────────────────────────────────────────────────

async function finalizePayment() {
  const pay   = state.pay;
  const total = cartTotal();
  const ts    = Date.now();
  const txId  = `${ts}_${state.deviceId}`;

  const payment = { cash: 0, voucher: 0, cb: 0, phone: 0 };
  if (pay.method === 'cash_voucher') {
    payment.cash    = pay.cashGiven;
    payment.voucher = pay.voucherGiven;
  } else {
    payment[pay.cbType] = total;
  }

  const tx = {
    id:        txId,
    device_id: state.deviceId,
    type:      'sale',
    items:     state.cart.map(i => ({ id: i.id, name: i.name, price: i.price, qty: i.qty })),
    total:     total,
    payment,
    change:    pay.changeAmount > 0
               ? { amount: pay.changeAmount, method: pay.changeMethod }
               : null,
    timestamp: new Date(ts).toISOString(),
    synced:    0,
  };

  // Save locally first (never blocks on network)
  await dbPut('transactions', tx);

  // Request background sync (fire-and-forget)
  requestSync();

  // Reset UI
  cancelPayment();
  clearCart();
  toast('Vente enregistrée ✓', 'success');
}

// ═══════════════════════════════════════════════════════════════
// REFUND
// ═══════════════════════════════════════════════════════════════

function openRefundModal() {
  closeCartSheet();
  state.refund.method = 'cash';
  $('#refund-amount-input').value = '';
  $('#refund-btn-cash').classList.add('selected');
  $('#refund-btn-voucher').classList.remove('selected');
  $('#refund-modal').classList.remove('hidden');
}

async function finalizeRefund() {
  const amount = parseAmount($('#refund-amount-input').value);
  if (!amount || amount <= 0) { toast('Montant invalide', 'error'); return; }

  const method = state.refund.method;
  const ts     = Date.now();

  const payment = { cash: 0, voucher: 0, cb: 0, phone: 0 };
  payment[method] = amount;   // positive value; report.php knows type=refund means outgoing

  const tx = {
    id:        `${ts}_${state.deviceId}`,
    device_id: state.deviceId,
    type:      'refund',
    items:     [],
    total:     -amount,
    payment,
    change:    null,
    timestamp: new Date(ts).toISOString(),
    synced:    0,
  };

  await dbPut('transactions', tx);
  requestSync();
  closeRefundModal();
  toast(`Remboursement de ${fmtNum(amount)} enregistré`, 'info');
}

function closeRefundModal() {
  $('#refund-modal').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION HISTORY (bouton précédent)
// ═══════════════════════════════════════════════════════════════

function initHistory() {
  history.replaceState({ view: 'caisse' }, '', '#caisse');

  // Le popstate ferme directement le DOM — aucun appel à history depuis ici
  window.addEventListener('popstate', () => {
    if (!$('#payment-modal').classList.contains('hidden')) {
      state.pay.active = false;
      $('#payment-modal').classList.add('hidden');
    } else if (!$('#refund-modal').classList.contains('hidden')) {
      $('#refund-modal').classList.add('hidden');
    } else if (!$('#view-config').classList.contains('hidden')) {
      $('#view-config').classList.add('hidden');
    } else if (!$('#view-report').classList.contains('hidden')) {
      $('#view-report').classList.add('hidden');
    }
  });
}

// history.back() uniquement si le hash correspond (évite de sortir de l'app)
function _historyBack(expectedHash) {
  if (location.hash === expectedHash) history.back();
}

// ═══════════════════════════════════════════════════════════════
// CONFIG VIEW
// ═══════════════════════════════════════════════════════════════

function showConfig() {
  renderConfigContent();
  $('#view-config').classList.remove('hidden');
  history.pushState({ view: 'config' }, '', '#config');
}

function hideConfig() {
  $('#view-config').classList.add('hidden');
  _historyBack('#config');
}

let _configRendering = false;

async function renderConfigContent() {
  if (_configRendering) return;
  _configRendering = true;

  const el = $('#config-content');
  if (!el) { _configRendering = false; return; }  // sécurité null

  let all;
  try {
    all = await dbGetAll('catalog');
  } catch (e) {
    _configRendering = false;
    return;
  }
  all.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const pm = state.config.paymentMethods;

  el.innerHTML = `
    <!-- Ajout dans la caisse -->
    <div class="config-section">
      <h3>Ajout dans la caisse</h3>
      <p class="config-hint">Entrées hors ventes : fond de caisse, rattrapage de décalage…</p>
      <div class="fond-fields">
        <div class="config-field">
          <label for="ajout-amount">Montant</label>
          <div class="fond-input-row">
            <input type="number" id="ajout-amount" min="0.01" step="0.01"
                   placeholder="0.00" inputmode="decimal">
            <span class="fond-currency">€</span>
          </div>
        </div>
        <div class="config-field">
          <label>Type</label>
          <div class="decais-type-btns">
            <button class="btn-sm primary ajout-type-btn" data-type="cash">Liquide</button>
            <button class="btn-sm ajout-type-btn" data-type="voucher">Bons</button>
          </div>
        </div>
      </div>
      <div class="config-field" style="margin-bottom:10px">
        <label for="ajout-note">Note</label>
        <input type="text" id="ajout-note"
               placeholder="Ex : fond de caisse, rattrapage de décalage…">
      </div>
      <button class="btn-sm primary" id="cfg-add-ajout">↑ Enregistrer l'ajout</button>
      <div id="ajout-list" class="decaissement-list" style="margin-top:12px"></div>
    </div>

    <!-- Décaissements -->
    <div class="config-section">
      <h3>Décaissements</h3>
      <p class="config-hint">Sorties de caisse hors ventes (rendu de monnaie, dépenses…)</p>
      <div class="fond-fields">
        <div class="config-field">
          <label for="decais-amount">Montant</label>
          <div class="fond-input-row">
            <input type="number" id="decais-amount" min="0.01" step="0.01"
                   placeholder="0.00" inputmode="decimal">
            <span class="fond-currency">€</span>
          </div>
        </div>
        <div class="config-field">
          <label>Type</label>
          <div class="decais-type-btns">
            <button class="btn-sm primary decais-type-btn" data-type="cash">Liquide</button>
            <button class="btn-sm decais-type-btn" data-type="voucher">Bons</button>
          </div>
        </div>
      </div>
      <div class="config-field" style="margin-bottom:10px">
        <label for="decais-note">Note (optionnel)</label>
        <input type="text" id="decais-note" placeholder="Ex : appoint monnaie">
      </div>
      <button class="btn-sm primary" id="cfg-add-decaissement">↓ Enregistrer le décaissement</button>
      <div id="decaissement-list" class="decaissement-list" style="margin-top:12px"></div>
    </div>

    <!-- Service name -->
    <div class="config-section">
      <h3>Général</h3>
      <div class="config-field">
        <label for="cfg-service-name">Nom de l'enseigne</label>
        <input type="text" id="cfg-service-name" value="${escHtml(state.config.serviceName)}" placeholder="Caisse">
      </div>
      <button class="btn-sm primary" id="cfg-save-general">Enregistrer</button>
    </div>

    <!-- Payment methods -->
    <div class="config-section">
      <h3>Modes de paiement</h3>
      <div class="toggle-row">
        <div><div class="toggle-label">Liquide</div><div class="toggle-sublabel">Toujours actif</div></div>
        <label class="toggle"><input type="checkbox" checked disabled><span class="toggle-slider"></span></label>
      </div>
      <div class="toggle-row">
        <div><div class="toggle-label">Bons</div><div class="toggle-sublabel">Toujours actif</div></div>
        <label class="toggle"><input type="checkbox" checked disabled><span class="toggle-slider"></span></label>
      </div>
      <div class="toggle-row">
        <div><div class="toggle-label">Terminal CB</div></div>
        <label class="toggle"><input type="checkbox" id="tog-cb" ${pm.cb?'checked':''}><span class="toggle-slider"></span></label>
      </div>
      <div class="toggle-row">
        <div><div class="toggle-label">Paiement téléphone</div></div>
        <label class="toggle"><input type="checkbox" id="tog-phone" ${pm.phone?'checked':''}><span class="toggle-slider"></span></label>
      </div>
      <div style="margin-top:12px">
        <button class="btn-sm primary" id="cfg-save-pm">Enregistrer</button>
      </div>
    </div>

    <!-- Products -->
    <div class="config-section">
      <h3>Produits</h3>
      <div id="product-list">
        ${all.map(p => productCardHTML(p)).join('')}
      </div>
      <button class="btn-add-product" id="cfg-add-product">+ Ajouter un produit</button>
    </div>
  `;

  // Ajout dans la caisse
  let _ajoutType = 'cash';
  $$('.ajout-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _ajoutType = btn.dataset.type;
      $$('.ajout-type-btn').forEach(b => b.classList.remove('primary'));
      btn.classList.add('primary');
    });
  });

  // Historique des ajouts
  dbGetAllByIndex('transactions', 'type', 'fond').then(ajouts => {
    const list = $('#ajout-list');
    if (!list) return;
    ajouts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (ajouts.length === 0) {
      list.innerHTML = '<p class="config-hint">Aucun ajout enregistré</p>';
    } else {
      list.innerHTML = ajouts.slice(0, 15).map(a => {
        const method = a.payment?.voucher > 0 ? 'Bons' : 'Liquide';
        const amount = a.payment?.voucher > 0 ? a.payment.voucher : (a.payment?.cash || 0);
        const note   = a.note ? ' — ' + escHtml(a.note) : '';
        const date   = new Date(a.timestamp).toLocaleString('fr-FR',
          {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
        return `<div class="decaissement-item">
          <span class="decaissement-amount" style="color:var(--success)">${fmtNum(amount)} ${method}</span>
          <span class="decaissement-date">${date}${note}</span>
        </div>`;
      }).join('');
    }
  });

  $('#cfg-add-ajout')?.addEventListener('click', async () => {
    const amount = parseAmount($('#ajout-amount').value);
    if (!amount || amount <= 0) { toast('Montant invalide', 'error'); return; }
    const note   = $('#ajout-note').value.trim();
    const ts     = Date.now();
    const cash    = _ajoutType === 'cash'    ? amount : 0;
    const voucher = _ajoutType === 'voucher' ? amount : 0;
    const entry   = { cash, voucher, recorded_at: new Date(ts).toISOString(), note };
    state.fondCaisse = entry;
    state.fondCaisseHistory.push(entry);
    await setSetting('fond_caisse',         state.fondCaisse);
    await setSetting('fond_caisse_history', state.fondCaisseHistory);
    await dbPut('transactions', {
      id:        `${ts}_${state.deviceId}`,
      device_id: state.deviceId,
      type:      'fond',
      items:     [],
      total:     amount,
      payment:   { cash, voucher, cb: 0, phone: 0 },
      change:    null,
      note:      note,
      timestamp: new Date(ts).toISOString(),
      synced:    0,
    });
    requestSync();
    $('#ajout-amount').value = '';
    $('#ajout-note').value   = '';
    toast(`Ajout de ${fmtNum(amount)} enregistré`, 'success');
    _configRendering = false;
    renderConfigContent();
  });

  // General save
  $('#cfg-save-general').addEventListener('click', async () => {
    state.config.serviceName = $('#cfg-service-name').value.trim() || 'Caisse';
    $('#service-name').textContent = state.config.serviceName;
    await saveConfig();
    toast('Enregistré', 'success');
  });

  // Payment methods save
  $('#cfg-save-pm').addEventListener('click', async () => {
    state.config.paymentMethods.cb    = $('#tog-cb').checked;
    state.config.paymentMethods.phone = $('#tog-phone').checked;
    await saveConfig();
    toast('Modes de paiement mis à jour', 'success');
  });

  // Add product
  $('#cfg-add-product').addEventListener('click', () => addNewProduct(all));

  // Product cards: save + delete buttons
  bindProductCardEvents();

  // ── Décaissements : liste + formulaire ────────────────────
  dbGetAllByIndex('transactions', 'type', 'decaissement').then(decais => {
    const list = $('#decaissement-list');
    if (!list) return;
    decais.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (decais.length === 0) {
      list.innerHTML = '<p class="config-hint">Aucun décaissement enregistré</p>';
    } else {
      list.innerHTML = decais.slice(0, 15).map(d => {
        const method = d.payment?.voucher > 0 ? 'Bons' : 'Liquide';
        const amount = d.payment?.voucher > 0 ? d.payment.voucher : (d.payment?.cash || 0);
        const note   = d.note ? ' — ' + escHtml(d.note) : '';
        const date   = new Date(d.timestamp).toLocaleString('fr-FR',
          {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
        return `<div class="decaissement-item">
          <span class="decaissement-amount">${fmtNum(amount)} ${method}</span>
          <span class="decaissement-date">${date}${note}</span>
        </div>`;
      }).join('');
    }
  });

  let _decaisType = 'cash';
  $$('.decais-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _decaisType = btn.dataset.type;
      $$('.decais-type-btn').forEach(b => b.classList.remove('primary'));
      btn.classList.add('primary');
    });
  });

  $('#cfg-add-decaissement')?.addEventListener('click', async () => {
    const amount = parseAmount($('#decais-amount').value);
    if (!amount || amount <= 0) { toast('Montant invalide', 'error'); return; }
    const note = $('#decais-note').value.trim();
    await saveDecaissement(amount, _decaisType, note);
    $('#decais-amount').value = '';
    $('#decais-note').value   = '';
    toast(`Décaissement ${fmtNum(amount)} enregistré`, 'success');
    _configRendering = false;
    renderConfigContent();
  });

  _configRendering = false;
}

function productCardHTML(p) {
  return `
  <div class="product-card" data-pid="${p.id}">
    <div class="pc-row-name">
      <input type="text" class="pc-name" value="${escHtml(p.name)}" placeholder="Nom du produit" maxlength="30">
    </div>
    <div class="pc-row-bottom">
      <input type="color" class="pc-color-swatch" value="${p.color||'#3b82f6'}" title="Couleur du bouton">
      <input type="number" class="pc-price-input" value="${p.price}" placeholder="0.00" min="0" step="0.01" inputmode="decimal">
      <div class="pc-actions">
        <button class="btn-sm primary pc-save" data-pid="${p.id}" title="Enregistrer">✓</button>
        <button class="btn-sm danger pc-delete" data-pid="${p.id}" title="Supprimer">✕</button>
      </div>
    </div>
  </div>`;
}

function bindProductCardEvents() {
  $$('.pc-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid  = parseInt(btn.dataset.pid, 10);
      const card = btn.closest('.product-card');
      const name  = card.querySelector('.pc-name').value.trim();
      const price = parseAmount(card.querySelector('.pc-price-input').value);
      const color = card.querySelector('.pc-color-swatch').value;
      if (!name) { toast('Nom requis', 'error'); return; }
      const existing = (await dbGetAll('catalog')).find(p => p.id === pid);
      await dbPut('catalog', { ...existing, name, price, color });
      await reloadCatalog();
      renderProductGrid();
      await saveCatalogToServer();
    });
  });

  $$('.pc-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer ce produit ?')) return;
      await dbDelete('catalog', parseInt(btn.dataset.pid, 10));
      await reloadCatalog();
      renderProductGrid();
      renderConfigContent();
      await saveCatalogToServer();
    });
  });
}

async function addNewProduct(all) {
  const maxOrder = all.reduce((m, p) => Math.max(m, p.sort_order ?? 0), 0);
  const newProduct = {
    name:       'Nouveau produit',
    price:      1.00,
    color:      '#3b82f6',
    active:     true,
    sort_order: maxOrder + 1,
  };
  await dbPut('catalog', newProduct);
  await reloadCatalog();
  renderProductGrid();
  renderConfigContent();
  await saveCatalogToServer();
}

async function saveConfig() {
  await setSetting('config', state.config);
}

// ═══════════════════════════════════════════════════════════════
// REPORT VIEW
// ═══════════════════════════════════════════════════════════════

function showReport() {
  $('#view-report').classList.remove('hidden');
  renderReportContent();
  history.pushState({ view: 'rapport' }, '', '#rapport');
}

function hideReport() {
  $('#view-report').classList.add('hidden');
  _historyBack('#rapport');
}

// ─── Sélecteur date/heure custom (selects) ───────────────────
// Fiable quelque soit la locale du navigateur : format JJ/MM/AAAA, 24h garanti.

const MONTHS_FR = ['Jan','Fév','Mar','Avr','Mai','Jun',
                   'Jul','Aoû','Sep','Oct','Nov','Déc'];

function makeDateTimeSelects(prefix, dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mn]    = timeStr.split(':').map(Number);
  const curYear    = new Date().getFullYear();
  const years      = [curYear - 1, curYear, curYear + 1];

  const opts = (arr, sel) => arr.map(([v, lbl]) =>
    `<option value="${v}"${v === sel ? ' selected' : ''}>${lbl}</option>`
  ).join('');

  const dayOpts   = opts(Array.from({length:31}, (_,i) => [i+1, String(i+1).padStart(2,'0')]), d);
  const monthOpts = opts(MONTHS_FR.map((lbl,i) => [i+1, lbl]), mo);
  const yearOpts  = opts(years.map(y2 => [y2, y2]), y);
  const hourOpts  = opts(Array.from({length:24}, (_,i) => [i, String(i).padStart(2,'0')]), h);
  const minOpts   = opts(Array.from({length:60}, (_,i) => [i, String(i).padStart(2,'0')]), mn);

  return `
    <select id="${prefix}-day"   class="rpt-sel rpt-sel-day">${dayOpts}</select>
    <span   class="rpt-sep">/</span>
    <select id="${prefix}-month" class="rpt-sel rpt-sel-month">${monthOpts}</select>
    <span   class="rpt-sep">/</span>
    <select id="${prefix}-year"  class="rpt-sel rpt-sel-year">${yearOpts}</select>
    <span   class="rpt-sep rpt-sep-time">—</span>
    <select id="${prefix}-hour"  class="rpt-sel rpt-sel-time">${hourOpts}</select>
    <span   class="rpt-sep">h</span>
    <select id="${prefix}-min"   class="rpt-sel rpt-sel-time">${minOpts}</select>`;
}

function getDateTimeISO(prefix, sec = 0) {
  const d  = parseInt($(`#${prefix}-day`).value,   10);
  const mo = parseInt($(`#${prefix}-month`).value, 10);
  const y  = parseInt($(`#${prefix}-year`).value,  10);
  const h  = parseInt($(`#${prefix}-hour`).value,  10);
  const mn = parseInt($(`#${prefix}-min`).value,   10);
  // new Date(year, monthIndex, day, h, m, s) — interprété en heure locale
  return new Date(y, mo - 1, d, h, mn, sec).toISOString();
}

const RPT_FIELDS = ['day','month','year','hour','min'];

async function renderReportContent() {
  const el = $('#report-content');
  el.innerHTML = `
    <div class="report-date-row">
      <div class="rpt-range-group">
        <span class="rpt-range-label">Du</span>
        ${makeDateTimeSelects('rpt-from', today(), '00:00')}
      </div>
      <div class="rpt-range-group">
        <span class="rpt-range-label">Au</span>
        ${makeDateTimeSelects('rpt-to', today(), '23:59')}
      </div>
    </div>
    <div id="rpt-body"><div style="text-align:center;padding:32px;color:var(--text-dim)">Chargement…</div></div>`;

  ['rpt-from', 'rpt-to'].forEach(prefix => {
    RPT_FIELDS.forEach(f => {
      $(`#${prefix}-${f}`)?.addEventListener('change', loadReport);
    });
  });

  await loadReport();
}

async function loadReport() {
  // Vérifier que les selects sont présents (vue rapport peut ne pas être ouverte)
  if (!$('#rpt-from-day')) return;

  const from = getDateTimeISO('rpt-from', 0);   // début de la minute
  const to   = getDateTimeISO('rpt-to',   59);  // fin de la minute

  const body = $('#rpt-body');
  if (!body) return;

  if (!navigator.onLine) {
    body.innerHTML = `<div style="text-align:center;padding:32px;color:var(--danger)">Hors ligne — rapports non disponibles</div>`;
    return;
  }

  try {
    const res  = await fetch(`./api/report.php?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const data = await res.json();
    await renderReportData(body, data, from);
  } catch (e) {
    console.error("[rapport] Erreur:", e);
    body.innerHTML = `<div style="text-align:center;padding:32px;color:var(--danger)">Erreur de chargement</div>`;
  }
}

// Bloc "En caisse" pour une méthode (liquide ou bons)
function drawerGroup(label, fond, net, decais) {
  const total = round2(fond + net - decais);
  return `
    <div class="report-drawer-group">
      <div class="report-drawer-title">${label}</div>
      ${rKV('Début de service',     fmtNum(fond))}
      ${rKV('+ Entrées nettes',     (net    >= 0 ? '+ ' : '− ') + fmtNum(Math.abs(net)))}
      ${decais > 0 ? rKV('− Décaissements', '− ' + fmtNum(decais)) : ''}
      ${rKV('En caisse maintenant', fmtNum(total), true)}
    </div>`;
}

async function renderReportData(container, d, fromISO) {
  const pending = await dbGetAllByIndex('transactions', 'synced', 0);
  const badge = pending.length > 0
    ? `<div style="text-align:center;padding:8px;color:var(--info);font-size:0.82rem">⚠ ${pending.length} transaction(s) non synchronisée(s) — rapport incomplet</div>`
    : '';

  // Produits vendus
  const productsHTML = (d.by_product ?? []).length === 0
    ? rKV('Aucune vente', '—')
    : (d.by_product ?? []).map(p =>
        rKV(`${escHtml(p.name)} × ${p.qty}`, fmtNum(p.revenue))
      ).join('');

  // Détail entrées par méthode
  function methodRow(label, m) {
    const gross  = d.gross_in?.[m]      ?? 0;
    const change = d.change_out?.[m]    ?? 0;
    const refund = d.refund_out?.[m]    ?? 0;
    const net    = d.net_by_method?.[m] ?? 0;
    if (gross === 0 && net === 0) return '';
    let detail = fmtNum(gross);
    if (change > 0) detail += ` − ${fmtNum(change)} rendu`;
    if (refund > 0) detail += ` − ${fmtNum(refund)} remb.`;
    return `
      <div class="report-kv">
        <span>${label}</span>
        <span class="val mono">${fmtNum(net)}</span>
      </div>
      ${(change > 0 || refund > 0) ? `<div class="report-detail">encaissé ${detail}</div>` : ''}`;
  }

  // Solde d'ouverture calculé côté serveur depuis tout l'historique avant $from
  const fond     = d.opening?.cash    ?? 0;
  const fondBons = d.opening?.voucher ?? 0;

  container.innerHTML = badge + `
    <div class="report-card">
      <h3>Chiffre d'affaires</h3>
      ${rKV('Ventes brutes',    fmtNum(d.total_sales), true)}
      ${rKV('Remboursements',   d.total_refunds > 0 ? '− ' + fmtNum(d.total_refunds) : fmtNum(0))}
      ${rKV('Net',              fmtNum(d.net), true)}
      ${rKV('Nb ventes',        d.sales_count)}
      ${d.refund_count > 0 ? rKV('Nb remb.', d.refund_count) : ''}
    </div>

    <div class="report-card">
      <h3>Produits vendus</h3>
      ${productsHTML}
    </div>

    <div class="report-card">
      <h3>Entrées nettes par moyen de paiement</h3>
      ${methodRow('Liquide',   'cash')}
      ${methodRow('Bons',      'voucher')}
      ${methodRow('CB',        'cb')}
      ${methodRow('Téléphone', 'phone')}
    </div>

    <div class="report-card">
      <h3>En caisse (théorique)</h3>

      ${drawerGroup('Liquide',
        fond,
        d.ajouts_in?.cash        ?? 0,
        d.gross_in?.cash         ?? 0,
        d.change_out?.cash       ?? 0,
        d.refund_out?.cash       ?? 0,
        d.decaissement_out?.cash ?? 0
      )}
      ${drawerGroup('Bons',
        fondBons,
        d.ajouts_in?.voucher        ?? 0,
        d.gross_in?.voucher         ?? 0,
        d.change_out?.voucher       ?? 0,
        d.refund_out?.voucher       ?? 0,
        d.decaissement_out?.voucher ?? 0
      )}
    </div>
  `;
}

// ── Trouve le fond de caisse en vigueur au début d'une période ─
// fromISO : chaîne ISO UTC (ex: "2024-05-08T06:00:00.000Z")
// Retourne le fond le plus récent enregistré <= fromISO,
// ou {cash:0, voucher:0, recorded_at:null} si aucun.
function getFondForPeriod(fromISO) {
  const candidates = state.fondCaisseHistory
    .filter(f => f.recorded_at <= fromISO)
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  return candidates[0] ?? { cash: 0, voucher: 0, recorded_at: null };
}

// ── Enregistrer un décaissement ──────────────────────────────
async function saveDecaissement(amount, type, note) {
  const ts      = Date.now();
  const payment = { cash: 0, voucher: 0, cb: 0, phone: 0 };
  payment[type] = amount;
  const tx = {
    id:        `${ts}_${state.deviceId}`,
    device_id: state.deviceId,
    type:      'decaissement',
    items:     [],
    total:     -amount,
    payment,
    change:    null,
    note:      note || '',
    timestamp: new Date(ts).toISOString(),
    synced:    0,
  };
  await dbPut('transactions', tx);
  requestSync();
}


// ═══════════════════════════════════════════════════════════════
// SYNC STATUS INDICATOR
// ═══════════════════════════════════════════════════════════════

function updateSyncDot(status) {
  const dot = $('#sync-dot');
  if (!dot) return;
  dot.className = 'sync-dot';

  if (status === 'online')  { dot.classList.add('online');  dot.title = 'En ligne'; }
  if (status === 'offline') { dot.classList.add('offline'); dot.title = 'Hors ligne'; }
  if (status === 'synced')  { dot.classList.add('online');  dot.title = 'Synchronisé'; }

  // Check pending count for "pending" dot state
  dbGetAllByIndex('transactions', 'synced', 0).then(pending => {
    if (pending.length > 0 && navigator.onLine) {
      dot.classList.remove('online');
      dot.classList.add('syncing');
      dot.title = `${pending.length} transaction(s) en sync…`;
    } else if (pending.length > 0 && !navigator.onLine) {
      dot.classList.remove('online');
      dot.classList.add('pending');
      dot.title = `${pending.length} transaction(s) en attente`;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// FOND DE CAISSE
// ═══════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════════

function bindEvents() {
  // Cart bar toggle
  $('#cart-bar-btn').addEventListener('click', () => {
    const open = $('#cart-sheet').classList.contains('hidden');
    if (open) openCartSheet(); else closeCartSheet();
  });
  $('#cart-overlay').addEventListener('click', closeCartSheet);
  $('#cart-close-btn').addEventListener('click', closeCartSheet);

  // Pay button (inside cart sheet)
  $('#btn-pay').addEventListener('click', startPayment);

  // Bouton Encaisser dans la barre → ouvre le panier (recap avant paiement)
  $('#btn-checkout').addEventListener('click', openCartSheet);

  // Refund button
  $('#btn-refund').addEventListener('click', openRefundModal);

  // Payment modal cancel
  $('#pay-cancel-btn').addEventListener('click', cancelPayment);

  // Refund modal
  $('#refund-close-btn').addEventListener('click', closeRefundModal);
  $('#refund-confirm-btn').addEventListener('click', finalizeRefund);
  $('#refund-btn-cash').addEventListener('click', () => {
    state.refund.method = 'cash';
    $('#refund-btn-cash').classList.add('selected');
    $('#refund-btn-voucher').classList.remove('selected');
  });
  $('#refund-btn-voucher').addEventListener('click', () => {
    state.refund.method = 'voucher';
    $('#refund-btn-voucher').classList.add('selected');
    $('#refund-btn-cash').classList.remove('selected');
  });

  // Config view
  $('#btn-config').addEventListener('click', showConfig);
  $('#config-back-btn').addEventListener('click', hideConfig);
  $('#config-sync-btn').addEventListener('click', async () => {
    toast('Synchronisation…', 'info');
    await saveCatalogToServer();
    await tryCatalogSync();
  });

  // Report view
  $('#btn-report').addEventListener('click', showReport);
  $('#report-back-btn').addEventListener('click', hideReport);
  $('#report-refresh-btn').addEventListener('click', loadReport);

  // Bloquer le pull-to-refresh natif sauf dans les zones scrollables
  document.addEventListener('touchmove', (e) => {
    if (!e.target.closest('.cart-items, .slide-content, .modal, #product-grid')) {
      e.preventDefault();
    }
  }, { passive: false });
}

// ═══════════════════════════════════════════════════════════════
// HTML HELPERS
// ═══════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function choiceBtnBig(emoji, label, value) {
  const btn = document.createElement('button');
  btn.className = 'choice-btn-big';
  btn.dataset.value = value;
  btn.innerHTML = `<span class="emoji">${emoji}</span>${label}`;
  return btn;
}

function choiceBtnBigHTML(emoji, label, value) {
  return `<button class="choice-btn-big" data-value="${value}"><span class="emoji">${emoji}</span>${label}</button>`;
}

function summaryRow(label, value, accent = false) {
  return `<div class="pay-summary-row${accent?' total-row':''}"><span>${label}</span><span class="mono">${value}</span></div>`;
}

function rKV(label, val, accent = false) {
  return `<div class="report-kv${accent?' accent':''}"><span>${label}</span><span class="val">${val}</span></div>`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
