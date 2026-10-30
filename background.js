/**
 * MediTrack BD — background service worker.
 * Runs the daily low-stock / expiry check and shows browser notifications.
 */

chrome.runtime.onInstalled.addListener(async () => {
  await seedDefaults();
  chrome.alarms.create('daily-check', { periodInMinutes: 720 });
  checkAlerts();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('daily-check', { periodInMinutes: 720 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'daily-check') checkAlerts();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'checkAlerts') {
    checkAlerts().then((res) => sendResponse(res));
    return true; // async
  }
  if (msg && msg.type === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: msg.title || 'MediTrack',
      message: msg.message || '',
      priority: 2,
    });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

let dayId = 'medi-check';

async function seedDefaults() {
  const data = await chrome.storage.local.get(['settings']);
  if (!data.settings) {
    await chrome.storage.local.set({
      settings: {
        defaultDiscount: 0,
        defaultThreshold: 10,
        expiryAlertDays: 30,
        notifyLowStock: true,
        notifyExpiry: true,
      },
    });
  }
}

function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

/** Reads the inventory and fires one combined notification for low stock + expiry. */
async function checkAlerts() {
  const { settings, inventory } = await chrome.storage.local.get([
    'settings',
    'inventory',
  ]);
  const inv = Array.isArray(inventory) ? inventory : [];
  const cfg = settings || {};
  const lowItems = [];
  const expiryItems = [];

  for (const item of inv) {
    const threshold = item.lowStockThreshold ?? cfg.defaultThreshold ?? 10;
    if (item.qty <= 0) lowItems.push(`${item.name} — OUT OF STOCK`);
    else if (item.qty <= threshold) {
      lowItems.push(`${item.name} — ${item.qty} pcs left (threshold ${threshold})`);
    }
    if (item.expiry) {
      const days = daysUntil(item.expiry);
      if (days < 0) expiryItems.push(`${item.name} — EXPIRED ${-days} day(s) ago`);
      else if (days <= (cfg.expiryAlertDays ?? 30)) {
        expiryItems.push(`${item.name} — expires in ${days} day(s)`);
      }
    }
  }

  if ((!cfg.notifyLowStock || !lowItems.length) && (!cfg.notifyExpiry || !expiryItems.length)) {
    return { low: lowItems, expiry: expiryItems, notified: false };
  }

  const lines = [];
  if (cfg.notifyLowStock !== false && lowItems.length) {
    lines.push(`⚠️ Low stock (${lowItems.length}):`, ...lowItems.slice(0, 6));
    if (lowItems.length > 6) lines.push(`… and ${lowItems.length - 6} more`);
  }
  if (cfg.notifyExpiry !== false && expiryItems.length) {
    lines.push(`⏰ Expiry alert (${expiryItems.length}):`, ...expiryItems.slice(0, 4));
    if (expiryItems.length > 4) lines.push(`… and ${expiryItems.length - 4} more`);
  }

  dayId = `medi-${new Date().toISOString().slice(0, 10)}`;
  chrome.notifications.create(dayId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'MediTrack — Inventory Alerts',
    message: lines.join('\n'),
    priority: 2,
  });
  return { low: lowItems, expiry: expiryItems, notified: true };
}
