# 💊 MediTrack BD — Medicine Inventory & Order Tracker

A medicine inventory app with product data sourced live from **[medex.com.bd](https://medex.com.bd)**, browser notifications for low-stock and expiry, a purchase-order builder with discount calculation, and a prescription calculator. Works **two ways**:

1. **🌐 Live website** — [https://s18211190154-ux.github.io/medicine-inventory-tracker/](https://s18211190154-ux.github.io/medicine-inventory-tracker/) — open and use, nothing to install. (MedEx data routes through a public CORS proxy because browsers block direct cross-site fetches.)
2. **🧩 Chrome extension** — recommended experience: fetches MedEx directly (faster, no proxy), runs its own background auto-refresh even when the site isn't open.

> ⚠️ **Disclaimer:** This is a personal inventory helper, not a pharmacy or medical service. It does not sell medicine or process payments — it only builds an order list for you to send/take to a pharmacy. Always follow your doctor's prescription.

---

## ✨ Features

| | Feature |
|---|---|
| 📦 | **Inventory** — track how many pieces (pcs) of each medicine remain, with +/- counters, per-item low-stock thresholds and expiry dates |
| 🔍 | **Source from medex.com.bd** — in Settings, search MedEx (by brand or generic name), select a product, and the extension fetches its **unit price, strip price and pack size** from the product page and adds it to your inventory |
| 🌍 | **Public, server-persisted data** — ALL data (inventory, prices, orders, prescriptions, settings) lives in [`data.json`](data.json) in this very repo. Anyone can **view** it on the site. Only the owner can **modify** it, via a GitHub fine-grained token (Contents: Read & write) entered once in Settings |
| 🔧 | Fixed admin password protects Settings (no password changing by design) |
| 🔄 | **Auto price sync** — a background job re-fetches every product page daily, updates prices/pack sizes automatically and notifies you when a price changes (manual "Sync now" button also in Settings) |
| ⚡ | **Auto-order generation** — one click fills the whole order draft for you: prescription shortfalls first, then restock-to-threshold for low/out-of-stock items. Review, place. |
| 🔔 | **Browser notifications** — daily check + on-demand: low-stock, out-of-stock, expiring-soon and price-change alerts |
| 🛒 | **Buy / Order builder** — click how many pieces you need, auto price × qty calculation, global + per-line **discount %**, order draft, totals, copyable order text; placing an order deducts stock |
| 📋 | **Prescription calculator** — add prescriptions (medicine, dose per intake, intakes/day, duration) and MediTrack computes how many pcs the full course needs, how many days your current stock covers, and the shortfall you need to buy — push the shortfall straight into the Buy tab |
| 🔐 | **Password-protected settings** — the whole app unlocks with your password; password hash (SHA-256) is stored locally, never in plaintext |
| 💾 | **Order history** — every placed order is saved, expandable and copyable |
| ↕️ | **Import / export** — full JSON backup & restore; everything stays local in `chrome.storage` |

## 🚀 Install the extension (Load unpacked)

1. Download this repo (or `git clone`).
2. Open Chrome → `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Click the 💊 extension icon — the full app opens directly in a new tab (no popups, no friction). It also opens automatically on first install.

## 🔑 Password & access model

- The admin password is **fixed** (decided by the owner, no change-password option). It protects **Settings only** — Dashboard, Inventory, Buy, Orders and the Prescriptions overview are always open.
- In the code it exists **only as a SHA-256 hash** — the plaintext password is never committed to the repo.
- **Where data lives:** everything added or edited is committed to `data.json` in this repo. Public = anyone can read it (shared visibility). Writing goes through the GitHub Contents API and requires the owner's token — so visitors are read-only by nature.
- **Your token:** create a fine-grained token (github.com → Settings → Developer settings → Personal access tokens → Fine-grained), scoped to **this repo only**, permission **Contents: Read and write**, then paste it in Settings → *Admin/write access*. The token is stored device-local only, never committed.

## 🧭 Using it

- **Dashboard** — at-a-glance stats: medicines tracked, low stock, expiring, estimated stock value, plus "needs attention" lists.
- **Inventory** — add medicines from Settings → *Add medicine from medex.com.bd* (e.g. search "napa", pick "Napa 500 mg (Tablet)"). Adjust stock with **−/+**. Set expiry dates to get expiry alerts.
- **Buy** — choose a medicine, enter quantity (pcs), discount % (defaults from Settings), see the live price preview, add to the order draft, then **Place order** (deducts stock + saves to history) or **Copy order text** to share with a pharmacy.
- **Prescriptions** — Managed in **Settings → Prescriptions**; the Prescriptions tab shows the live calculation (needed vs stock vs shortfall) and can add shortfalls to the order.
- **Settings** (password-protected) — preferences (default discount %, low-stock threshold, expiry window, notification toggles), MedEx product search & add, prescriptions, GitHub write-access token, backup/restore, factory reset.

## 🗂 Project structure

```
├── manifest.json      # MV3 manifest (toolbar icon opens the app directly)
├── background.js      # service worker: daily alert check, auto MedEx price sync, notifications
├── data.json          # ⬅ the live database: public read, owner-only writes via GitHub API
├── app.{html,css,js}  # the full app (SPA in a new tab / on GitHub Pages)
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
