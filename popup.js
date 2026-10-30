const S = chrome.storage.local;
const $ = (id) => document.getElementById(id);

function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

async function render() {
  const { inventory, settings } = await S.get(['inventory', 'settings']);
  const inv = Array.isArray(inventory) ? inventory : [];
  const cfg = settings || {};
  const defThreshold = cfg.defaultThreshold ?? 10;
  const expiryWindow = cfg.expiryAlertDays ?? 30;

  let low = 0, expiring = 0;
  for (const it of inv) {
    if (it.qty <= (it.lowStockThreshold ?? defThreshold)) low++;
    if (it.expiry && daysUntil(it.expiry) <= expiryWindow) expiring++;
  }
  $('p-total').textContent = inv.length;
  $('p-low').textContent = low;
  $('p-expiring').textContent = expiring;
  if (low || expiring) {
    $('p-flash').textContent = `${low ? low + ' low stock' : ''}` +
      (low && expiring ? ' · ' : '') + `${expiring ? expiring + ' expiring soon' : ''}`;
  } else {
    $('p-flash').textContent = 'All good ✔';
  }
}

$('p-open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  window.close();
});

$('p-check').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'checkAlerts' });
  $('p-check').textContent = res && res.notified
    ? 'Alerts checked — notification sent ✔'
    : 'Alerts checked ✔';
  render();
});

render();
