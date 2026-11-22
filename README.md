# retail-inventory-billing

Free, open-source (MIT) stock management, dynamic pricing and POS billing for provision stores and medical shops.
Mobile-first PWA + desktop, single portable SQLite file, no cloud services.

## Quick start
```bash
npm install
npm run db:push      # create/upgrade data/app.db (applies the SQL migrations; safe on existing data)
npm run db:seed      # sample grocery + pharmacy data (-- --reset to wipe first)
npm run dev          # http://<your-pc-ip>:3000 — open from your phone on the same Wi-Fi
```
**Phone camera scanning needs HTTPS** (browser rule). Use `npm run dev:https` (self-signed cert; accept the warning once).
USB barcode scanners work on any screen with no setup.

Production: `npm run build && npm start` (or `start:https`). Backup = copy `data/app.db`.

## Deploy a demo on Netlify (try it on your phone)
Netlify has no persistent disk, so this is a **demo only**: SQLite lives in `/tmp`, is created and filled with sample
data on first request, and resets when the function recycles. Never enter real shop data there.
1. Netlify → *Add new site* → *Import from GitHub* → select this repo (and branch).
2. Deploy — all settings come from `netlify.toml` (`NETLIFY_DEMO=1`, `DATABASE_PATH=/tmp/app.db`).
3. Open the `https://….netlify.app` URL on your phone. HTTPS means the camera scanner works. Use *Add to Home Screen* to install the PWA.

For real use, self-host on a PC / Raspberry Pi (see Quick start).

## Features
- Products with batches, MFG/expiry, MRP/selling/purchase price, GST slabs (0/5/12/18), loose (decimal) quantities
- Edit products and batches (fix names, GST, barcodes, prices); correct a stock count with a reason, recorded in the stock history
- Low-stock and near-expiry (30/60 day) alerts; write off expired stock (one batch or all at once, with cost lost), archive/restore products, delete mistakes
- Add product: scan the barcode (camera or USB scanner), look it up online (Open Food Facts, free, no key), pick a match to prefill, finish by hand. Items already in your inventory are detected
- POS: instant search, camera + USB scan, **FEFO** batch allocation, expired batches blocked, live GST, item discounts,
  optional per-batch near-expiry auto-markdown, cash/UPI/card/split
- Printable invoices: 58mm, 80mm thermal and A4 (`Ctrl+P`)
- Customer credit (udhaar): sell on credit or part-pay, record payments, see who owes what, WhatsApp reminder links, dues CSV
- Reports (`/reports`): sales, discounts, GST by slab (CGST/SGST), payments, daily sales, top products; CSV export for your accountant
- Dashboard: today's sales, profit estimate, low stock, expiring soon
- Admin control of sales: void a bill (stock goes back, dues reversed, record kept), amend items/quantities (creates a linked corrected bill `INV-…-A1`), edit customer/payment/notes, void a wrong dues payment. All recorded in the activity log
- Accounts: username + PIN for admins and staff, every bill records who made it, activity log, per-user sales report; staff can bill and receive stock, admins control everything else (30-day sessions, per-user lockout)
- Shortcuts (desktop): `F2` search · `Enter` add · `F9` pay · `Ctrl+P` print

## Barcode lookup (online)
Add-product looks the barcode up on Open Food Facts, Open Beauty Facts and Open Products Facts (free, open, no account).
Only the barcode number is sent. The device needs internet access; without it you simply type the details.
Coverage is good for packaged groceries, poor for medicines. Your own database remembers every barcode you save.

## Security
Username + PIN accounts with admin/staff roles, security headers on every response, capped inputs, and `npm run audit:prod` (currently 0 findings).
Keep the app on your LAN/Tailscale; it is not meant to be exposed to the public internet.

## Develop
`npm test` · `npm run typecheck` · `npm run lint`. See `CLAUDE.md` for conventions
(money = integer paise, quantity = integer milli-units, all stock changes via `src/services` in a transaction).
