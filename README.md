# 💊 MediTrack BD — Medicine Inventory & Order Tracker

A Chrome extension for tracking personal/home medicine inventory with product data sourced live from **[medex.com.bd](https://medex.com.bd)**, browser notifications for low-stock and expiry, a purchase-order builder with discount calculation, and a prescription calculator.

> ⚠️ **Disclaimer:** This is a personal inventory helper, not a pharmacy or medical service. It does not sell medicine or process payments — it only builds an order list for you to send/take to a pharmacy. Always follow your doctor's prescription.

---

## ✨ Features

| | Feature |
|---|---|
| 📦 | **Inventory** — track how many pieces (pcs) of each medicine remain, with +/- counters, per-item low-stock thresholds and expiry dates |
| 🔍 | **Source from medex.com.bd** — in Settings, search MedEx (by brand or generic name), select a product, and the extension fetches its **unit price, strip price and pack size** from the product page and adds it to your inventory |
| 🔔 | **Browser notifications** — daily check + on-demand: low-stock, out-of-stock and expiring-soon alerts |
| 🛒 | **Buy / Order builder** — click how many pieces you need, auto price × qty calculation, global + per-line **discount %**, order draft, totals, copyable order text; placing an order deducts stock |
| 📋 | **Prescription calculator** — add prescriptions (medicine, dose per intake, intakes/day, duration) and MediTrack computes how many pcs the full course needs, how many days your current stock covers, and the shortfall you need to buy — push the shortfall straight into the Buy tab |
| 🔐 | **Password-protected settings** — the whole app unlocks with your password; password hash (SHA-256) is stored locally, never in plaintext |
| 💾 | **Order history** — every placed order is saved, expandable and copyable |
| ↕️ | **Import / export** — full JSON backup & restore; everything stays local in `chrome.storage` |

## 🚀 Install (Load unpacked)

1. Download this repo (or `git clone`).
2. Open Chrome → `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Click the 💊 extension icon → **Open full app**.

## 🔑 Password

There is **no default password** in this repo. On first launch the app asks you to **create your own admin password** (min. 6 characters). It is stored only as a SHA-256 hash in local `chrome.storage` — the plaintext never leaves your device. Change it anytime in **Settings → Security**.

## 🧭 Using it

- **Dashboard** — at-a-glance stats: medicines tracked, low stock, expiring, estimated stock value, plus "needs attention" lists.
- **Inventory** — add medicines from Settings → *Add medicine from medex.com.bd* (e.g. search "napa", pick "Napa 500 mg (Tablet)"). Adjust stock with **−/+**. Set expiry dates to get expiry alerts.
- **Buy** — choose a medicine, enter quantity (pcs), discount % (defaults from Settings), see the live price preview, add to the order draft, then **Place order** (deducts stock + saves to history) or **Copy order text** to share with a pharmacy.
- **Prescriptions** — Managed in **Settings → Prescriptions**; the Prescriptions tab shows the live calculation (needed vs stock vs shortfall) and can add shortfalls to the order.
- **Settings** (password-protected) — preferences (default discount %, low-stock threshold, expiry window, notification toggles), MedEx product search & add, prescriptions, password change, backup/restore, factory reset.

## 🗂 Project structure

```
├── manifest.json      # MV3 manifest
├── background.js      # service worker: alarms, daily alert check, notifications
├── popup.{html,css,js}# toolbar quick view
├── app.{html,css,js}  # the full app (SPA in a new tab)
├── icons/             # generated icons
└── tools/make-icons.ps1
```

## 🔧 How the MedEx integration works

Chrome grants the extension host permission for `https://medex.com.bd/*`, so `app.js` can:

1. Fetch `https://medex.com.bd/search?search=…&type=…` and parse the result rows (`.search-result-row`) into `{name, form, generic, company, url}`.
2. Fetch the chosen product page and parse `h1.brand`, the generic/company/strength blocks and `.package-container` for *Unit Price / Strip Price / (X x Y: pack total)*.

No API key, no backend, no proxy needed.

## 📄 License

MIT
