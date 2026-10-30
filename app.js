/* ═══════════════════════════════════════════════════════════
   MediTrack BD — app.js
   Inventory + orders + prescriptions + settings (password gated)
   Data source: medex.com.bd
   ═══════════════════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ── cross-context shims: works inside the extension AND as a plain website ── */
const hasChrome =
  typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

const S = hasChrome
  ? chrome.storage.local
  : {
      async get(keys) {
        if (keys == null)
          keys = Object.keys(localStorage)
            .filter((k) => k.startsWith('mt_'))
            .map((k) => k.slice(3));
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) {
          const v = localStorage.getItem('mt_' + k);
          if (v != null) {
            try { out[k] = JSON.parse(v); } catch { out[k] = v; }
          }
        }
        return out;
      },
      async set(obj) {
        for (const k in obj) localStorage.setItem('mt_' + k, JSON.stringify(obj[k]));
      },
      async clear() {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('mt_'))
          .forEach((k) => localStorage.removeItem(k));
      },
    };

const SS = hasChrome
  ? chrome.storage.session
  : {
      async get(key) {
        const v = sessionStorage.getItem(key);
        return v == null ? {} : { [key]: JSON.parse(v) };
      },
      async set(obj) {
        for (const k in obj) sessionStorage.setItem(k, JSON.stringify(obj[k]));
      },
      async remove(...keys) {
        keys.flat().forEach((k) => sessionStorage.removeItem(k));
      },
    };

/** Notification that works in the extension (service worker) AND on a website. */
async function sendNotify(title, message) {
  if (hasChrome) {
    chrome.runtime.sendMessage({ type: 'notify', title, message });
    return;
  }
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'granted') {
      new Notification(title, { body: message, icon: 'icons/icon128.png' });
    }
  } catch (e) { /* blocked — ignore */ }
}

const DEFAULT_SETTINGS = {
  defaultDiscount: 0,
  defaultThreshold: 10,
  expiryAlertDays: 30,
  notifyLowStock: true,
  notifyExpiry: true,
  notifyPriceChanges: true,
};

/* ── fixed admin password: only its SHA-256 hash lives here (no plaintext) ── */
const PW_HASH = 'f233ad630e8111482b12c04671502bc48ba69829ba616ad88754c8de4b3e4633';

/* ── GitHub-backed storage: public read, owner-only write ── */
const SERVER = {
  owner: 's18211190154-ux',
  repo: 'medicine-inventory-tracker',
  file: 'data.json',
};
const ghUrl = () =>
  `https://api.github.com/repos/${SERVER.owner}/${SERVER.repo}/contents/${SERVER.file}`;

let lastSha = null; // latest data.json sha for conflict-free commits

let settings = { ...DEFAULT_SETTINGS };
let inventory = [];
let orders = [];
let prescriptions = [];
let cart = []; // {key,name,qty,unitPrice,discount,packInfo}
let buildItems = []; // prescription builder rows

/* ── utils ── */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text == null ? '' : String(text);
  return d.innerHTML;
}

function fmt(n) {
  const v = Number(n) || 0;
  return '৳ ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

function itemThreshold(item) {
  return item.lowStockThreshold ?? settings.defaultThreshold ?? 10;
}

function itemStatus(item) {
  if (item.qty <= 0) return 'out';
  if (item.qty <= itemThreshold(item)) return 'low';
  return 'ok';
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function saveAll() {
  await S.set({ inventory, orders, prescriptions, settings });
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('err', isErr);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ═════════ medex.com.bd scraper ═════════ */

/* Direct fetch works inside the extension (host permission).
   On a website (GitHub Pages) CORS blocks it → fall back to public CORS proxies. */
const CORS_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function fetchPage(url) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (res.ok) return await res.text();
  } catch (e) { /* CORS / network — try proxies */ }
  for (const mkProxy of CORS_PROXIES) {
    try {
      const res = await fetch(mkProxy(url));
      if (res.ok) return await res.text();
    } catch (e) { /* next proxy */ }
  }
  throw new Error('unreachable');
}

function parseSearchResults(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...doc.querySelectorAll('.search-result-row')].filter(
    (r) => !r.classList.contains('ad')
  );
  return rows
    .map((row) => {
      const a = row.querySelector('.search-result-title a[href*="/brands/"]');
      if (!a) return null;
      const form = row.querySelector('img.dosage-icon')?.title || '';
      const generic = row.querySelector('p i')?.textContent?.trim() || '';
      const pText = row.querySelector('p')?.textContent || '';
      const company = pText.split('is manufactured by')[1]?.trim().replace(/\.$/, '') || '';
      return {
        name: a.textContent.trim().replace(/\s*\([^)]*\)\s*$/, ''),
        form,
        generic,
        company,
        url: a.href,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function parseProductPage(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // brand name from h1 text nodes only (h1 also contains type subtitle)
  const h1 = doc.querySelector('h1.brand');
  const name = h1 && [...h1.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join('')
    .trim();

  const generic = doc.querySelector('.brand-header a[href*="/generics/"]')?.textContent.trim() || '';
  const strength = [...doc.querySelectorAll('.brand-header div')].find(
    (d) => d.getAttribute('title') === 'Strength'
  )?.textContent.trim() || '';
  const company = doc.querySelector('.brand-header a[href*="/companies/"]')?.textContent.trim() || '';
  const dosForm = doc.querySelector('.brand-header img.dosage-icon')?.title || '';
  const pkgText = doc.querySelector('.package-container')?.textContent || '';

  const up = /Unit\s*Price:\s*(?:৳|Tk)\s*([\d.,]+)/i.exec(pkgText);
  const pk = /\((\d+)\s*[x×]\s*(\d+):\s*(?:৳|Tk)\s*([\d.,]+)/i.exec(pkgText);
  const st = /Strip\s*Price:\s*(?:৳|Tk)\s*([\d.,]+)/i.exec(pkgText);

  return {
    name,
    strength,
    form: dosForm,
    generic,
    company,
    unitPrice: up ? parseFloat(up[1].replace(/,/g, '')) : null,
    packSize: pk ? parseInt(pk[1], 10) * parseInt(pk[2], 10) : null,
    packInfo: pk ? `${pk[1]} x ${pk[2]}` : null,
    stripPrice: st ? parseFloat(st[1].replace(/,/g, '')) : null,
  };
}

async function medexSearch(query, type = 'search') {
  const url =
    'https://medex.com.bd/search?search=' +
    encodeURIComponent(query) +
    '&type=' + encodeURIComponent(type);
  const html = await fetchPage(url);
  return parseSearchResults(html);
}

async function medexProduct(url) {
  const html = await fetchPage(url);
  return parseProductPage(html);
}

/* ═════════ boot ═════════ */

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  await loadState();
  wireNav();
  wireButtons();
  await refreshGate();
  renderAll();

  if (!hasChrome) {
    // website mode: no service worker → run the periodic jobs in this tab
    localCheckAlerts();
    setInterval(localCheckAlerts, 6 * 60 * 60 * 1000);      // alerts every 6 h
    setInterval(syncPricesNow, 12 * 60 * 60 * 1000);       // price sync every 12 h
  }
}

/* ═════════ GitHub server storage ═════════
   All data lives in data.json in this public repo:
   • reading = public (no token needed) — everyone can see it
   • writing = only with the owner's GitHub token (settings) */

async function getGhToken() {
  const { gh_token } = await S.get('gh_token');
  return gh_token || '';
}

async function ghReadFile() {
  const token = await getGhToken();
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(ghUrl() + '?t=' + Date.now(), { headers });
  if (!res.ok) throw new Error('GitHub read failed (HTTP ' + res.status + ')');
  const j = await res.json();
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))
  );
  return { data: JSON.parse(json), sha: j.sha };
}

async function ghWriteFile(payload) {
  const token = await getGhToken();
  if (!token) {
    throw new Error('No GitHub token set → read-only mode. Open Settings and paste your token.');
  }
  // always fetch the current sha to avoid clobbering writes
  const cur = await ghReadFile();
  const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const res = await fetch(ghUrl(), {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'MediTrack data update — ' + new Date().toLocaleString('en-GB'),
      content: btoa(bin),
      sha: cur.sha,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('GitHub write failed (HTTP ' + res.status + ') ' + t.slice(0, 140));
  }
  const j = await res.json();
  lastSha = j.content?.sha || lastSha;
}

async function loadState() {
  const local = await S.get([
    'settings', 'inventory', 'orders', 'prescriptions',
  ]);
  let serverData = null;
  try {
    const srv = await ghReadFile();
    if (srv.data) {
      serverData = srv.data;
      lastSha = srv.sha;
    }
  } catch (e) {
    console.warn('Server load failed:', e);
  }

  if (serverData) {
    // server is the source of truth; keep a local mirror for offline starts
    settings = { ...DEFAULT_SETTINGS, ...(serverData.settings || {}) };
    inventory = Array.isArray(serverData.inventory) ? serverData.inventory : [];
    orders = Array.isArray(serverData.orders) ? serverData.orders : [];
    prescriptions = Array.isArray(serverData.prescriptions) ? serverData.prescriptions : [];

    // one-time migration: server is empty but this device has old data
    const localHasData = (local.inventory?.length || local.orders?.length || 0) > 0;
    if (localHasData && !inventory.length && !orders.length) {
      inventory = local.inventory || [];
      orders = local.orders || [];
      saveAll();
      setTimeout(() => toast('Moved your device data to GitHub ✔'), 600);
    }
  } else {
    // offline / first load before migration → use whatever is on this device
    settings = { ...DEFAULT_SETTINGS, ...(local.settings || {}) };
    inventory = Array.isArray(local.inventory) ? local.inventory : [];
    orders = Array.isArray(local.orders) ? local.orders : [];
    prescriptions = Array.isArray(local.prescriptions) ? local.prescriptions : [];
  }
}

function payload() {
  return {
    app: 'MediTrack BD',
    dataVersion: 1,
    updatedAt: new Date().toISOString(),
    inventory,
    orders,
    prescriptions,
    settings,
  };
}

let saveChain = Promise.resolve(); // serialize writes, never fire two PUTs at once

/** Persists the full state: local mirror + commit to GitHub (public file). */
function saveAll() {
  S.set(payload()); // local cache (offline fallback)
  saveChain = saveChain
    .then(() => ghWriteFile(payload()))
    .catch((err) => toast('⚠ ' + (err.message || 'Save to GitHub failed'), true));
  return saveChain;
}

/* ═════════ nav ═════════ */

function wireNav() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  $('#db-open-inventory').addEventListener('click', () => showView('inventory'));
  $('#db-goto-buy').addEventListener('click', () => showView('buy'));
  $('#px-goto-settings').addEventListener('click', () => showView('settings'));
  $('#inv-add-btn').addEventListener('click', openMedexAdd);
  $('#inv-empty-add').addEventListener('click', openMedexAdd);
}

function showView(name) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  renderAll();
}

/* ═════════ settings gate (password protects Settings ONLY) ═════════ */

let settingsUnlocked = false;

/**
 * The admin password is FIXED — its SHA-256 hash is in the app code.
 * No setup, no changing: enter the password to manage Settings for this session.
 */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(pw) {
  return (await sha256(String(pw))) === PW_HASH;
}

/** Decides whether the gate must show. */
async function refreshGate() {
  const { unlocked } = await SS.get('unlocked');
  settingsUnlocked = unlocked === true;
  const showGate = !settingsUnlocked;

  $('#settings-gate').hidden = !showGate;
  $('#settings-content').hidden = showGate;
  if (showGate) {
    $('#gate-err').textContent = '';
    setTimeout(() => $('#gate-pw').focus(), 50);
  } else {
    fillSettingsForm();
  }
}

async function gateSubmit() {
  const errEl = $('#gate-err');
  errEl.textContent = '';
  if (await verifyPassword($('#gate-pw').value)) {
    await SS.set({ unlocked: true });
    $('#gate-pw').value = '';
    await refreshGate();
    toast('Settings unlocked ✔');
  } else {
    errEl.textContent = 'Incorrect password.';
    $('#gate-pw').value = '';
    $('#gate-pw').focus();
  }
}

$('#gate-unlock').addEventListener('click', gateSubmit);
$('#gate-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') gateSubmit(); });

$('#pg-lock').addEventListener('click', async () => {
  await SS.remove('unlocked');
  await refreshGate();
  toast('Settings locked 🔒 — Dashboard, Inventory, Buy, Orders and Prescriptions remain usable.');
});

/* ═════════ generic button wiring ═════════ */

function wireButtons() {
  // inventory controls
  $('#inv-search').addEventListener('input', renderInventory);
  $('#inv-sort').addEventListener('change', renderInventory);

  // buy
  $('#buy-med').addEventListener('change', updateBuyPreview);
  $('#buy-qty').addEventListener('input', updateBuyPreview);
  $('#buy-discount').addEventListener('input', updateBuyPreview);
  $('#buy-add').addEventListener('click', () => addBuyLine($('#buy-qty').value));
  $('#cart-place').addEventListener('click', placeOrder);
  $('#cart-auto').addEventListener('click', autoGenerateOrder);
  $('#db-auto-order').addEventListener('click', autoGenerateOrder);
  $('#cart-copy').addEventListener('click', copyOrder);
  $('#cart-clear').addEventListener('click', () => {
    cart = [];
    renderBuy();
    toast('Order draft cleared.');
  });

  // settings
  $('#pf-save').addEventListener('click', savePreferences);  $('#pf-test-notify').addEventListener('click', () =>
    sendNotify('MediTrack — test notification', 'Browser notifications are working ✔')
  );
  $('#pf-sync-prices').addEventListener('click', async () => {
    const btn = $('#pf-sync-prices');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing…';
    const res = await syncPricesNow();
    btn.disabled = false;
    btn.textContent = '🔄 Sync MedEx prices now';
    renderAll();
    toast(
      res && res.checked
        ? `Synced ${res.checked} product page(s) — ${res.updated} price change(s) found.`
        : 'Nothing to sync (no inventory yet).'
    );
  });
  $('#gh-save-token').addEventListener('click', async () => {
    const tok = $('#gh-token').value.trim();
    if (!tok) return toast('Paste your GitHub token first.', true);
    await S.set({ gh_token: tok });
    $('#gh-token').value = '';
    $('#gh-status').textContent = 'Token saved on this device.';
    saveChain = saveChain.then(() => ghWriteFile(payload()))
      .then(() => {
        $('#gh-status').textContent = 'Token saved ✔ write access to GitHub working.';
        toast('Write access connected ✔');
      })
      .catch((err) => {
        $('#gh-status').textContent = '❌ ' + (err.message || 'token failed');
      });
  });

  $('#gh-test').addEventListener('click', async () => {
    const tok = $('#gh-token').value.trim();
    if (tok) await S.set({ gh_token: tok });
    $('#gh-status').textContent = '⏳ Testing…';
    try {
      await ghWriteFile(payload());
      $('#gh-status').textContent = '✔ Token works — data.json is being written to GitHub.';
    } catch (err) {
      $('#gh-status').textContent = '❌ ' + (err.message || 'failed');
    }
  });
  $('#mx-go').addEventListener('click', runMedexSearch);
  $('#mx-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runMedexSearch(); });
  $('#px-add-item').addEventListener('click', () => addBuilderItem());
  $('#px-save').addEventListener('click', savePrescription);
  $('#dt-export').addEventListener('click', exportData);
  $('#dt-import').addEventListener('change', importData);
  $('#dt-reset').addEventListener('click', factoryReset);

  // modal
  $('#modal-cancel').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal-save').addEventListener('click', saveModal);
}

/* ═════════ render dispatcher ═════════ */

function renderAll() {
  renderDashboard();
  renderInventory();
  renderBuy();
  renderPrescriptionsView();
  renderOrders();
  updateCartPill();
}

function updateCartPill() {
  const pill = $('#cart-pill');
  const n = cart.reduce((s, l) => s + l.qty, 0);
  pill.hidden = n === 0;
  pill.textContent = n;
}

/* ═════════ dashboard ═════════ */

function renderDashboard() {
  const total = inventory.length;
  const lowList = inventory.filter((i) => itemStatus(i) !== 'ok');
  const expList = inventory.filter((i) => {
    if (!i.expiry) return false;
    const d = daysUntil(i.expiry);
    return d <= (settings.expiryAlertDays ?? 30);
  });
  const value = inventory.reduce((s, i) => s + (i.qty || 0) * (i.unitPrice || 0), 0);

  $('#st-total').textContent = total;
  $('#st-low').textContent = lowList.length;
  $('#st-expiring').textContent = expList.length;
  $('#st-value').textContent = fmt(value);

  renderMini('#db-low', lowList, (i) => {
    const badge = itemStatus(i) === 'out' ? 'OUT OF STOCK' : `${i.qty} left`;
    return `<div class="mini-item"><span>${esc(i.name)}</span><span class="num">${badge}</span></div>`;
  });
  renderMini('#db-expiry', expList, (i) => {
    const d = daysUntil(i.expiry);
    const label = d < 0 ? `expired ${-d}d ago` : `${d}d left`;
    return `<div class="mini-item"><span>${esc(i.name)}</span><span class="num">${esc(i.expiry)} · ${label}</span></div>`;
  });

  const cartCount = cart.length;
  renderMini('#db-cart-preview', cart, (l) => {
    return `<div class="mini-item"><span>${esc(l.name)}</span><span class="num">${l.qty} pcs · ${fmt(lineTotal(l))}</span></div>`;
  }, cartCount === 0 ? 'Order draft is empty. Build an order in the Buy tab.' : null);
}

function renderMini(sel, items, tpl, emptyMsg) {
  const el = $(sel);
  if (!items.length) {
    el.innerHTML = `<div class="mini-empty">${esc(emptyMsg || 'Nothing to show ✔')}</div>`;
    return;
  }
  el.innerHTML = items.map(tpl).join('');
}

/* ═════════ inventory ═════════ */

function formIcon(form) {
  const f = (form || '').toLowerCase();
  if (f.includes('syrup')) return '🧴';
  if (f.includes('injection') || f.includes('infusion')) return '💉';
  if (f.includes('drop')) return '💧';
  if (f.includes('suppository')) return '🟣';
  if (f.includes('cream') || f.includes('ointment') || f.includes('gel')) return '🧴';
  return '💊';
}

function renderInventory() {
  const q = $('#inv-search').value.trim().toLowerCase();
  const sort = $('#inv-sort').value;
  let list = inventory.filter(
    (i) =>
      !q ||
      i.name?.toLowerCase().includes(q) ||
      i.generic?.toLowerCase().includes(q) ||
      i.company?.toLowerCase().includes(q)
  );
  if (sort === 'name') list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (sort === 'qty-asc') list.sort((a, b) => a.qty - b.qty);
  if (sort === 'expiry') {
    list.sort((a, b) => (a.expiry || '9999') < (b.expiry || '9999') ? -1 : 1);
  }
  if (sort === 'value') {
    list.sort((a, b) => a.qty * (a.unitPrice || 0) - b.qty * (b.unitPrice || 0)).reverse();
  }

  $('#inv-empty').hidden = inventory.length !== 0;
  $('#inv-list').innerHTML = list.map(tplInventory).join('');

  // row actions (event delegation)
  $$('#inv-list .icon-btn[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const item = inventory.find((i) => i.id === b.dataset.id);
      if (!item) return;
      if (b.dataset.act === 'dec') adjustQty(item, -1);
      if (b.dataset.act === 'inc') adjustQty(item, +1);
      if (b.dataset.act === 'edit') openEdit(item);
      if (b.dataset.act === 'del') removeItem(item);
    });
  });
}

function tplInventory(i) {
  const status = itemStatus(i);
  const badge =
    status === 'out'
      ? '<span class="badge out">Out of stock</span>'
      : status === 'low'
        ? '<span class="badge low">Low stock</span>'
        : '';
  let expiryBadge = '';
  if (i.expiry) {
    const d = daysUntil(i.expiry);
    if (d < 0) expiryBadge = `<span class="badge out">Expired</span>`;
    else if (d <= 30) expiryBadge = `<span class="badge expiring">Expiring ${d}d</span>`;
  }
  const packInfo = i.packSize ? ` (${i.packSize} pcs/pack)` : '';
  return `
  <div class="inv-card">
    <div class="inv-icon">${formIcon(i.form)}</div>
    <div>
      <div class="inv-title"><a href="${esc(i.url || '#')}" target="_blank" rel="noreferrer">${esc(i.name)}</a></div>
      <div class="inv-meta">${esc([i.strength, i.form].filter(Boolean).join(' · '))} · ${esc(i.generic || '—')} · ${esc(i.company || '—')}</div>
      <div class="badges">${badge}${expiryBadge}<span class="badge ${status === 'ok' ? 'ok' : ''}" style="${status === 'ok' ? '' : 'background:#f1f5f5;color:#64748b'}">${esc(i.expiry || 'no expiry set')}</span></div>
    </div>
    <div class="inv-stock">
      <button class="icon-btn" data-act="dec" data-id="${esc(i.id)}">−</button>
      <span class="stock-num">${i.qty}</span>
      <button class="icon-btn" data-act="inc" data-id="${esc(i.id)}">+</button>
    </div>
    <div class="inv-right">
      <div class="inv-price"><b>${fmt(i.unitPrice)}</b> /pc${esc(packInfo)}<br />th. ${i.lowStockThreshold ?? settings.defaultThreshold}</div>
      <button class="icon-btn" title="Edit" data-act="edit" data-id="${esc(i.id)}">✏️</button>
      <button class="icon-btn danger" title="Delete" data-act="del" data-id="${esc(i.id)}">🗑</button>
    </div>
  </div>`;
}

function adjustQty(item, delta) {
  item.qty = Math.max(0, (item.qty || 0) + delta);
  saveAll();
  renderAll();
  if (itemStatus(item) !== 'ok' && delta < 0) {
    sendNotify(
      'MediTrack — stock update',
      item.qty === 0
        ? `${item.name} is now OUT OF STOCK.`
        : `${item.name}: ${item.qty} pcs left (threshold ${itemThreshold(item)}).`
    );
  }
}

/* ═════════ local runtime (website mode: no service worker available) ═════════ */

/** Same logic as the background worker's checkAlerts(), running in-page. */
async function localCheckAlerts() {
  const { lastAlertDay } = await S.get('lastAlertDay');
  const today = new Date().toISOString().slice(0, 10);
  const lowItems = [];
  const expiryItems = [];
  for (const item of inventory) {
    const status = itemStatus(item);
    if (status === 'out') lowItems.push(`${item.name} — OUT OF STOCK`);
    else if (status === 'low') lowItems.push(`${item.name} — ${item.qty} pcs left`);
    if (item.expiry) {
      const d = daysUntil(item.expiry);
      if (d < 0) expiryItems.push(`${item.name} — EXPIRED ${-d} day(s) ago`);
      else if (d <= (settings.expiryAlertDays ?? 30))
        expiryItems.push(`${item.name} — expires in ${d} day(s)`);
    }
  }
  const lines = [];
  if (settings.notifyLowStock !== false && lowItems.length)
    lines.push(`⚠️ Low stock (${lowItems.length}):`, ...lowItems.slice(0, 6));
  if (settings.notifyExpiry !== false && expiryItems.length)
    lines.push(`⏰ Expiry alert (${expiryItems.length}):`, ...expiryItems.slice(0, 4));
  if (!lines.length) return;
  if (lastAlertDay === today) return; // one combined alert per day
  await S.set({ lastAlertDay: today });
  sendNotify('MediTrack — Inventory Alerts', lines.join('\n'));
}

/** Manual/auto price sync using the same parsers as the background worker. */
async function syncPricesNow() {
  let checked = 0;
  const changes = [];
  for (const item of inventory) {
    if (!item.url) continue;
    try {
      const prod = await medexProduct(item.url);
      checked++;
      if (
        prod.unitPrice != null &&
        item.unitPrice != null &&
        prod.unitPrice !== item.unitPrice
      ) {
        changes.push(`${item.name}: ${fmt(item.unitPrice)} → ${fmt(prod.unitPrice)} per pc`);
      }
      if (prod.unitPrice != null) item.unitPrice = prod.unitPrice;
      if (prod.packSize != null) item.packSize = prod.packSize;
      if (prod.stripPrice != null) item.stripPrice = prod.stripPrice;
    } catch (e) { /* skip unreachable product */ }
  }
  if (checked) {
    await S.set({ lastPriceSync: new Date().toISOString() });
    await saveAll();
    renderAll();
  }
  if (changes.length && settings.notifyPriceChanges !== false) {
    sendNotify(
      'MediTrack — MedEx prices updated',
      `${changes.length} change(s):\n` + changes.slice(0, 5).join('\n')
    );
  }
  return { updated: changes.length, checked };
}

function removeItem(item) {
  if (!confirm(`Remove "${item.name}" from inventory?`)) return;
  inventory = inventory.filter((i) => i.id !== item.id);
  cart = cart.filter((l) => l.key !== item.id);
  saveAll();
  renderAll();
  toast('Removed from inventory.');
}

/* ═════════ modal add / edit ═════════ */

function fillModal(item) {
  $('#modal-title').textContent = item.ownItem ? 'Edit medicine' : 'Add medicine to inventory';
  $('#modal-medex').innerHTML = item.ownItem
    ? ''
    : `<b>${esc(item.name)}</b><br />${esc([item.strength, item.form].filter(Boolean).join(' · '))} · ${esc(item.generic)}<br />${esc(item.company)} ${item.unitPrice != null ? '· Unit price ' + fmt(item.unitPrice) : ''}${item.packSize ? ' · Pack ' + item.packSize + ' pcs' : ''}${item.stripPrice != null ? ' · Strip ' + fmt(item.stripPrice) : ''}`;
  $('#f-name').value = item.name || '';
  $('#f-strength').value = [item.strength, item.form].filter(Boolean).join(' · ');
  $('#f-generic').value = item.generic || '';
  $('#f-company').value = item.company || '';
  $('#f-qty').value = item.editing !== undefined ? item.editing.qty : 0;
  $('#f-threshold').value = item.editing !== undefined && item.editing.lowStockThreshold !== undefined
    ? item.editing.lowStockThreshold
    : settings.defaultThreshold ?? 10;
  $('#f-price').value = item.unitPrice ?? item.editing?.unitPrice ?? '';
  $('#f-packsize').value = item.packSize ?? item.editing?.packSize ?? '';
  $('#f-strip').value = item.stripPrice ?? item.editing?.stripPrice ?? '';
  $('#f-expiry').value = item.editing?.expiry || '';
  $('#modal-hint').textContent =
    !item.ownItem && item.unitPrice == null
      ? 'No price was found on the MedEx page — you can enter it manually here.'
      : '';
}

function saveModal() {
  const name = $('#f-name').value.trim();
  if (!name) return;
  const editing = modalCtx.editing;
  const rec = {
    id: editing ? editing.id : uid(),
    name,
    strength: $('#f-strength').value.trim(),
    generic: $('#f-generic').value.trim(),
    company: $('#f-company').value.trim(),
    qty: Math.max(0, parseInt($('#f-qty').value, 10) || 0),
    lowStockThreshold: parseInt($('#f-threshold').value, 10),
    unitPrice: parseFloat($('#f-price').value) || null,
    packSize: parseInt($('#f-packsize').value, 10) || null,
    stripPrice: parseFloat($('#f-strip').value) || null,
    expiry: $('#f-expiry').value || null,
    url: editing?.url || modalCtx.url || null,
    form: editing?.form || modalCtx.form || '',
    createdAt: editing?.createdAt || new Date().toISOString(),
  };
  inventory = inventory.filter((i) => i.id !== rec.id);
  // keep cart lines in sync with new price/name
  cart.forEach((l) => {
    if (l.key === rec.id) {
      l.name = rec.name;
      l.unitPrice = rec.unitPrice ?? l.unitPrice;
      l.packInfo = rec.packSize ? rec.packSize + ' pcs/pack' : l.packInfo;
    }
  });
  inventory.push(rec);
  inventory.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  saveAll();
  $('#modal').hidden = true;
  renderAll();
  toast(editing ? 'Medicine updated.' : 'Added to inventory ✔');
}

let modalCtx = null;
function openEdit(item) {
  modalCtx = { editing: item, url: item.url, form: item.form };
  fillModal({ ...item, editing: item, ownItem: true });
  $('#modal').hidden = false;
}

function saveToInventoryFromMedex(res) {
  modalCtx = { editing: null, url: res.url, form: res.form };
  fillModal({ ...res, ownItem: false });
  $('#modal').hidden = false;
}

function openMedexAdd() {
  showView('settings');
  $('#mx-q').focus();
}

/* ═════════ settings: add from medex ═════════ */

async function runMedexSearch() {
  const q = $('#mx-q').value.trim();
  if (!q) return;
  const box = $('#mx-results');
  box.innerHTML = '<div class="mx-loader">⏳ Searching medex.com.bd…</div>';
  try {
    const results = await medexSearch(q, $('#mx-type').value);
    if (!results.length) {
      box.innerHTML =
        '<div class="mx-loader">No results. Try a shorter name, or switch the filter to "Brand only".</div>';
      return;
    }
    box.innerHTML = '';
    results.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'mx-row';
      row.innerHTML = `
        <div>
          <div class="mx-name">${esc(r.name)} ${esc(r.form ? '· ' + r.form : '')}</div>
          <div class="mx-meta">${esc(r.generic)} · ${esc(r.company)}</div>
        </div>
        <button class="btn tiny primary">+ Add</button>`;
      row.querySelector('button').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = '⏳ Fetching…';
        try {
          const prod = await medexProduct(r.url);
          saveToInventoryFromMedex({ ...r, ...prod, url: r.url });
        } catch {
          userInfoToast('Could not fetch product page (or it has no price). Adding without price…', r);
        }
        btn.disabled = false;
        btn.textContent = '+ Add';
      });
      box.appendChild(row);
    });
  } catch (e) {
    box.innerHTML = `<div class="mx-loader">❌ Could not reach medex.com.bd (${esc(e.message)}). Check your connection.</div>`;
  }
}

function userInfoToast(msg, prefill) {
  modalCtx = { editing: null, url: prefill.url, form: prefill.form };
  fillModal({ ...prefill, ownItem: false });
  $('#modal-medex').innerHTML =
    `<b>${esc(prefill.name)}</b><br />Price could not be fetched — enter it manually after checking the product page.`;
  $('#modal').hidden = false;
}

/* ═════════ buy ═════════ */

function lineTotal(l) {
  const sub = (l.qty || 0) * (l.unitPrice || 0);
  const disc = sub * ((l.discount || 0) / 100);
  return sub - disc;
}

function fillBuySelects() {
  const sel = $('#buy-med');
  const current = sel.value;
  sel.innerHTML =
    inventory.length === 0
      ? '<option value="">— no inventory —</option>'
      : '<option value="">— select medicine —</option>' +
        inventory.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
  if (current && inventory.some((i) => i.id === current)) sel.value = current;
}

function updateBuyPreview() {
  const item = inventory.find((i) => i.id === $('#buy-med').value);
  const qty = parseInt($('#buy-qty').value, 10) || 0;
  const disc = parseFloat($('#buy-discount').value) || 0;
  if (!item || !qty) {
    $('#buy-preview').innerHTML = '';
    $('#buy-pack').value = item && item.packSize ? item.packSize + ' pcs/pack' : '';
    return;
  }
  $('#buy-discount').value = isNaN(parseFloat($('#buy-discount').value))
    ? settings.defaultDiscount ?? 0
    : $('#buy-discount').value;
  $('#buy-pack').value = [item.packSize ? item.packSize + ' pcs/pack' : '', item.unitPrice != null ? fmt(item.unitPrice) + '/pc' : '']
    .filter(Boolean)
    .join(' · ');
  const sub = qty * (item.unitPrice || 0);
  const total = lineTotal({ qty, unitPrice: item.unitPrice, discount: disc });
  const overStock = item.qty != null && qty > item.qty;
  $('#buy-preview').innerHTML = `
    ${esc(item.name)} — ${qty} pcs ${esc(item.unitPrice != null ? '× ' + fmt(item.unitPrice) : '(price not set)')}
    ${disc ? ` − ${disc}% = ` : ' = '}<span class="total">${fmt(total)}</span><br />
    ${item.qty != null ? `In stock: <b>${item.qty}</b> pcs${item.unitPrice != null ? ` · subtotal ${fmt(sub)}` : ''}${overStock ? ` — <span style="color:var(--red)">⚠ exceeds current stock</span>` : ''}` : ''}`;
}

function addBuyLine() {
  const item = inventory.find((i) => i.id === $('#buy-med').value);
  const qty = parseInt($('#buy-qty').value, 10) || 0;
  const disc = parseFloat($('#buy-discount').value) || 0;
  if (!item) return toast('Select a medicine first.', true);
  if (qty <= 0) return toast('Quantity must be at least 1.', true);
  const existing = cart.find((l) => l.key === item.id && l.discount === disc);
  if (existing) existing.qty += qty;
  else
    cart.push({
      key: item.id,
      name: item.name,
      qty,
      unitPrice: item.unitPrice,
      discount: disc,
      packInfo: item.packSize ? `${item.packSize} pcs/pack` : '',
    });
  $('#buy-qty').value = 1;
  renderBuy();
  toast('Added to order draft.');
}

function renderBuy() {
  fillBuySelects();
  updateBuyPreview();
  updateCartPill();
  const box = $('#cart-list');
  box.innerHTML = cart.length
    ? cart
        .map(
          (l, idx) => `
      <div class="cart-line">
        <div><div class="c-name">${esc(l.name)}</div><div class="c-sub">${esc(l.packInfo)}${l.discount ? ` · −${l.discount}%` : ''}${l.reason ? ` · ⚡ ${esc(l.reason)}` : ''}</div></div>
        <div>${l.qty} pcs × ${l.unitPrice != null ? fmt(l.unitPrice) : '—'}</div>
        <div><b>${fmt(lineTotal(l))}</b></div>
        <button class="icon-btn danger" data-idx="${idx}" title="Remove">✕</button>
      </div>`
        )
        .join('')
    : '<div class="mini-empty">Order draft is empty. Add medicines from the left panel.</div>';

  $$('#cart-list .icon-btn').forEach((b) =>
    b.addEventListener('click', () => {
      cart.splice(parseInt(b.dataset.idx, 10), 1);
      renderBuy();
    })
  );

  const sub = cart.reduce((s, l) => s + l.qty * (l.unitPrice || 0), 0);
  const total = cart.reduce((s, l) => s + lineTotal(l), 0);
  $('#cart-totals').innerHTML = cart.length
    ? `
    <div class="cart-totals-row"><span>Subtotal</span><span>${fmt(sub)}</span></div>
    <div class="cart-totals-row"><span>Discount savings</span><span>− ${fmt(sub - total)}</span></div>
    <div class="cart-totals-row grand"><span>Total to pay</span><span>${fmt(total)}</span></div>`
    : '';
}

function orderText(order) {
  const lines = order.lines
    .map(
      (l, i) =>
        `${i + 1}. ${l.name} — ${l.qty} pcs ${l.unitPrice != null ? `@ ${fmt(l.unitPrice)}` : '(price TBD)'}` +
        (l.discount ? ` (-${l.discount}%)` : '') +
        ` = ${fmt(lineTotal(l))}`
    )
    .join('\n');
  return (
    `MediTrack order — ${order.date}\n` +
    `${lines}\n` +
    `Subtotal: ${fmt(order.subtotal)}\n` +
    `Discount savings: − ${fmt(order.subtotal - order.total)}\n` +
    `TOTAL: ${fmt(order.total)}`
  );
}

function placeOrder() {
  if (!cart.length) return toast('Order draft is empty.', true);
  const sub = cart.reduce((s, l) => s + l.qty * (l.unitPrice || 0), 0);
  const order = {
    id: uid(),
    date: new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    lines: cart.map((l) => ({ ...l })),
    subtotal: sub,
    total: cart.reduce((s, l) => s + lineTotal(l), 0),
    status: 'placed',
  };
  // deduct stock
  order.lines.forEach((l) => {
    const item = inventory.find((i) => i.id === l.key);
    if (item) item.qty = Math.max(0, item.qty - l.qty);
  });
  orders.unshift(order);
  cart = [];
  saveAll();
  renderAll();
  toast(`Order saved ✔ Stock deducted. Order total ${fmt(order.total)}.`);
}

function copyOrder() {
  let text = '';
  if (cart.length) {
    text = orderText({
      date: new Date().toLocaleDateString('en-GB', { dateStyle: 'medium' }),
      lines: cart,
      subtotal: cart.reduce((s, l) => s + l.qty * (l.unitPrice || 0), 0),
      total: cart.reduce((s, l) => s + lineTotal(l), 0),
    });
  } else if (orders.length) {
    text = orderText(orders[0]);
  }
  if (!text) return toast('Nothing to copy.', true);
  navigator.clipboard.writeText(text).then(() => toast('Order text copied 📋'));
}

/* ═════════ prescriptions ═════════ */

function rxNeeded(row) {
  return Math.ceil((row.dose || 0) * (row.intakes || 0) * (row.days || 0));
}

function rxItemStock(invId) {
  const item = inventory.find((i) => i.id === invId);
  return item ? item : null;
}

function renderPrescriptionsView() {
  const box = $('#px-list');
  if (!prescriptions.length) {
    box.innerHTML =
      '<div class="card"><div class="empty"><div class="empty-icon">📋</div><p>No prescriptions saved.</p><button class="btn primary" onclick="document.querySelector(\'#px-goto-settings\').click()">+ Add one in Settings</button></div></div>';
    return;
  }
  box.innerHTML = prescriptions
    .map((p) => {
      const rows = p.items
        .map((row) => {
          const item = rxItemStock(row.invId);
          const needed = rxNeeded(row);
          if (!item)
            return `<div class="px-row-mini"><span class="big">${esc(row.label || 'Medicine (removed from inventory)')}</span><span>—</span></div>`;
          const perDay = row.dose * row.intakes || 0.0001;
          const daysCovered = Math.floor(item.qty / perDay);
          const shortfall = Math.max(0, needed - item.qty);
          return `
        <div class="px-row-mini">
          <span class="big">${esc(item.name)} <span class="c-sub">${row.dose} × ${row.intakes}/day · ${row.days} days</span></span>
          <span class="calc">${needed} pcs needed · stock ${item.qty} · covers ${daysCovered}d${shortfall ? ` · buy ${shortfall}` : ' ✔'}</span>
          ${shortfall ? `<button class="btn tiny subtle" data-px="${esc(p.id)}" data-inv="${esc(row.invId)}" data-need="${shortfall}">+ Add ${shortfall} to order</button>` : ''}
        </div>`;
        })
        .join('');
      return `<div class="px-card"><h3>📋 ${esc(p.title)}</h3>${rows}</div>`;
    })
    .join('');

  $$('#px-list [data-px]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = prescriptions.find((x) => x.id === b.dataset.px);
      const item = inventory.find((i) => i.id === b.dataset.inv);
      if (!p || !item) return;
      addShortfallToCart(item, p, parseInt(b.dataset.need, 10));
    })
  );
}

function addShortfallToCart(item, p, qty) {
  cart.push({
    key: item.id,
    name: item.name,
    qty,
    unitPrice: item.unitPrice,
    discount: p.discount ?? settings.defaultDiscount ?? 0,
    packInfo: item.packSize ? `${item.packSize} pcs/pack` : '',
  });
  saveAll();
  renderAll();
  showView('buy');
  toast(`${qty} pcs of ${item.name} added to order (prescription shortfall)`);
}

/* ═════════ orders ═════════ */

function renderOrders() {
  $('#orders-empty').hidden = orders.length !== 0;
  $('#orders-list').innerHTML = orders
    .map(
      (o) => `
    <div class="order-card">
      <div class="order-head">
        <div><div class="order-date">🧾 ${esc(o.date)}</div>
        <div class="order-opens">${o.lines.length} item(s) · total <b>${fmt(o.total)}</b></div></div>
        <div class="row-gap" style="margin:0">
          <button class="btn tiny subtle toggle-o" data-id="${esc(o.id)}">View</button>
          <button class="btn tiny subtle copy-o" data-id="${esc(o.id)}">📋 Copy</button>
          <button class="btn tiny danger del-o" data-id="${esc(o.id)}">Delete</button>
        </div>
      </div>
      <div class="order-lines"><pre style="white-space:pre-wrap;font-size:12.5px;margin:0;font-family:inherit">${esc(orderText(o))}</pre></div>
    </div>`
    )
    .join('');

  $$('.toggle-o').forEach((b) =>
    b.addEventListener('click', () => b.closest('.order-card').classList.toggle('open'))
  );
  $$('.copy-o').forEach((b) =>
    b.addEventListener('click', () => {
      const o = orders.find((x) => x.id === b.dataset.id);
      navigator.clipboard.writeText(orderText(o)).then(() => toast('Order text copied 📋'));
    })
  );
  $$('.del-o').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Delete this order record? (Stock is not restored.)')) return;
      orders = orders.filter((x) => x.id !== b.dataset.id);
      saveAll();
      renderAll();
    })
  );
}

/* ═════════ settings ═════════ */

function fillSettingsForm() {
  $('#pf-discount').value = settings.defaultDiscount;
  $('#pf-threshold').value = settings.defaultThreshold;
  $('#pf-expirydays').value = settings.expiryAlertDays;
  $('#pf-notify-low').checked = !!settings.notifyLowStock;
  $('#pf-notify-expiry').checked = !!settings.notifyExpiry;
  $('#pf-notify-price').checked = !!settings.notifyPriceChanges;
  renderBuilder();
  renderPxManage();
}

function savePreferences() {
  settings.defaultDiscount = Math.min(100, Math.max(0, parseFloat($('#pf-discount').value) || 0));
  settings.defaultThreshold = Math.max(0, parseInt($('#pf-threshold').value, 10) || 0);
  settings.expiryAlertDays = Math.max(1, parseInt($('#pf-expirydays').value, 10) || 30);
  settings.notifyLowStock = $('#pf-notify-low').checked;
  settings.notifyExpiry = $('#pf-notify-expiry').checked;
  settings.notifyPriceChanges = $('#pf-notify-price').checked;
  saveAll();
  renderAll();
  toast('Preferences saved ✔');
}

/* ═════════ auto order generation ═════════ */

/**
 * Builds the whole order draft automatically:
 *  1. prescription shortfalls (course pieces you don't have), then
 *  2. restock-to-threshold for low / out-of-stock items.
 * Combined per medicine (no duplicate lines), default discount applied.
 */
function autoGenerateOrder() {
  if (!inventory.length) return toast('Inventory is empty — add medicines first.', true);
  const wanted = new Map(); // itemId -> {qty, reason}

  for (const p of prescriptions) {
    for (const row of p.items) {
      const item = inventory.find((i) => i.id === row.invId);
      if (!item) continue;
      const shortfall = Math.max(0, rxNeeded(row) - item.qty);
      if (shortfall <= 0) continue;
      const entry = wanted.get(item.id) || { qty: 0, reason: '' };
      entry.qty = Math.max(entry.qty, shortfall);
      entry.reason = entry.reason || `prescription "${p.title}"`;
      wanted.set(item.id, entry);
    }
  }

  for (const item of inventory) {
    if (itemStatus(item) === 'ok') continue;
    const need = Math.max(0, itemThreshold(item) - item.qty);
    if (need <= 0) continue;
    const entry = wanted.get(item.id) || { qty: 0, reason: '' };
    if (entry.qty) entry.reason += ' + restock';
    else {
      entry.qty = need;
      entry.reason = entry.reason || 'restock to threshold';
    }
    wanted.set(item.id, entry);
  }

  if (!wanted.size) {
    return toast('Nothing to auto-order — stock and prescriptions are already covered ✔');
  }

  wanted.forEach((entry, key) => {
    const item = inventory.find((i) => i.id === key);
    cart.push({
      key,
      name: item.name,
      qty: entry.qty,
      unitPrice: item.unitPrice,
      discount: settings.defaultDiscount ?? 0,
      packInfo: item.packSize ? `${item.packSize} pcs/pack` : '',
      reason: entry.reason,
    });
  });

  saveAll();
  renderAll();
  showView('buy');
  toast(`⚡ Auto-order generated: ${wanted.size} line(s) — review and place.`);
}

/* ═════════ fixed password — no change-password option by design ═════════ */

/* ── prescription builder (inside settings) ── */

function fillBuySelectsForBuilder() {
  // re-usable: select options shared with buy tab
  return inventory
    .map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`)
    .join('');
}

function addBuilderItem(pref) {
  buildItems.push({
    invId: pref?.invId || '',
    label: pref?.label || '',
    dose: pref?.dose || 1,
    intakes: pref?.intakes || 1,
    days: pref?.days || 1,
  });
  renderBuilder();
}

function renderBuilder() {
  const box = $('#px-items-build');
  box.innerHTML = buildItems
    .map(
      (row, idx) => `
    <div class="px-item-grid" data-idx="${idx}">
      <div>
        <label>Medicine</label>
        <select class="input select bi-med" style="width:100%">
          <option value="">— select —</option>${fillBuySelectsForBuilder()}
        </select>
      </div>
      <div><label>Dose / intake</label><input type="number" min="1" class="input bi-dose" value="${row.dose}" /></div>
      <div><label>Intakes / day</label><input type="number" min="1" class="input bi-int" value="${row.intakes}" /></div>
      <div><label>Duration (days)</label><input type="number" min="1" class="input bi-days" value="${row.days}" /></div>
      <div><label>&nbsp;</label><button class="icon-btn danger bi-del" title="Remove row">✕</button></div>
    </div>`
    )
    .join('');

  $$('#px-items-build .px-item-grid').forEach((divEl) => {
    const idx = parseInt(divEl.dataset.idx, 10);
    divEl.querySelector('.bi-med').value = buildItems[idx].invId;
    divEl.querySelector('.bi-med').addEventListener('change', (e) => (buildItems[idx].invId = e.target.value));
    divEl.querySelector('.bi-dose').addEventListener('input', (e) => (buildItems[idx].dose = parseInt(e.target.value, 10) || 0));
    divEl.querySelector('.bi-int').addEventListener('input', (e) => (buildItems[idx].intakes = parseInt(e.target.value, 10) || 0));
    divEl.querySelector('.bi-days').addEventListener('input', (e) => (buildItems[idx].days = parseInt(e.target.value, 10) || 0));
    divEl.querySelector('.bi-del').addEventListener('click', () => {
      buildItems.splice(idx, 1);
      renderBuilder();
    });
  });
  renderBuilderPreview();
}

function renderBuilderPreview() {
  const lines = buildItems
    .filter((r) => r.invId)
    .map((r) => {
      const item = inventory.find((i) => i.id === r.invId);
      if (!item) return '';
      const needed = rxNeeded(r);
      const shortfall = Math.max(0, needed - item.qty);
      return `${esc(item.name)}: ${needed} pcs needed · stock ${item.qty} — you need to buy <b>${shortfall}</b> more`;
    })
    .filter(Boolean)
    .join('<br />');
  $('#px-build-preview').innerHTML = lines;
}

function savePrescription() {
  const title = $('#px-title').value.trim() || 'Prescription ' + new Date().toLocaleDateString('en-GB');
  const rows = buildItems.filter((r) => r.invId && r.dose > 0 && r.intakes > 0 && r.days > 0);
  if (!rows.length) return toast('Add at least one medicine row (with dose & duration).', true);
  prescriptions.unshift({
    id: uid(),
    title,
    items: rows.map((r) => ({ ...r })),
    discount: settings.defaultDiscount ?? 0,
    createdAt: new Date().toISOString(),
  });
  buildItems = [];
  $('#px-title').value = '';
  saveAll();
  renderBuilder();
  renderPxManage();
  renderAll();
  toast('Prescription saved ✔');
}

function renderPxManage() {
  const box = $('#px-manage');
  if (!prescriptions.length) {
    box.innerHTML = '<div class="mini-empty">No prescriptions saved yet.</div>';
    return;
  }
  box.innerHTML = prescriptions
    .map(
      (p) => `
    <div class="mini-item">
      <span><b>${esc(p.title)}</b><br /><span class="c-sub">${p.items.length} medicine(s)</span></span>
      <span class="row-gap" style="margin:0">
        <button class="btn tiny subtle px-edit" data-id="${esc(p.id)}">Edit</button>
        <button class="btn tiny danger px-del" data-id="${esc(p.id)}">✕</button>
      </span>
    </div>`
    )
    .join('');

  $$('.px-del').forEach((b) =>
    b.addEventListener('click', () => {
      prescriptions = prescriptions.filter((p) => p.id !== b.dataset.id);
      saveAll();
      renderPxManage();
      renderAll();
      toast('Prescription deleted.');
    })
  );
  $$('.px-edit').forEach((b) =>
    b.addEventListener('click', () => {
      const p = prescriptions.find((x) => x.id === b.dataset.id);
      if (!p) return;
      $('#px-title').value = p.title;
      buildItems = p.items.map((r) => ({ ...r }));
      prescriptions = prescriptions.filter((x) => x.id !== p.id);
      saveAll();
      renderBuilder();
      renderPxManage();
      renderAll();
      toast('Loaded into builder — press Save prescription to store changes.');
    })
  );
}

/* ═════════ data export / import / reset ═════════ */

function exportData() {
  const blob = new Blob(
    [JSON.stringify({ medicineTrackerExport: 1, exportedAt: new Date().toISOString(), inventory, orders, prescriptions, settings }, null, 2)],
    { type: 'application/json' }
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meditrack-data-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported ✔');
}

async function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.inventory)) throw new Error('not a MediTrack export');
    inventory = data.inventory;
    orders = Array.isArray(data.orders) ? data.orders : [];
    prescriptions = Array.isArray(data.prescriptions) ? data.prescriptions : [];
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    await saveAll();
    fillSettingsForm();
    renderAll();
    toast('Data imported ✔');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
}

async function factoryReset() {
  if (!confirm('Factory reset deletes ALL data (server data.json too): inventory, orders, prescriptions, settings. Continue?')) return;
  if (!confirm('Are you sure? This cannot be undone.')) return;
  inventory = [];
  orders = [];
  prescriptions = [];
  settings = { ...DEFAULT_SETTINGS };
  await saveAll();
  await SS.remove('unlocked');
  window.location.reload();
}
