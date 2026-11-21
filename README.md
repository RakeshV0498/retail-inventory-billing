# retail-inventory-billing

Free, open-source (MIT) stock management, dynamic pricing and POS billing for provision stores and medical shops.
Mobile-first PWA + desktop, single portable SQLite file, no cloud services.

## Quick start
```bash
npm install
npm run db:push      # create data/app.db
npm run db:seed      # sample grocery + pharmacy data (-- --reset to wipe first)
npm run dev          # http://<your-pc-ip>:3000 — open from your phone on the same Wi-Fi
```
**Phone camera scanning needs HTTPS** (browser rule). Use `npm run dev:https` (self-signed cert; accept the warning once).
USB barcode scanners work on any screen with no setup.

Production: `npm run build && npm start` (or `start:https`). Backup = copy `data/app.db`.

## Features
- Products with batches, MFG/expiry, MRP/selling/purchase price, GST slabs (0/5/12/18), loose (decimal) quantities
- Low-stock and near-expiry (30/60 day) alerts; expired stock write-off
- POS: instant search, camera + USB scan, **FEFO** batch allocation, expired batches blocked, live GST, item discounts,
  optional per-batch near-expiry auto-markdown, cash/UPI/card/split
- Printable invoices: 58mm, 80mm thermal and A4 (`Ctrl+P`)
- Dashboard: today's sales, profit estimate, low stock, expiring soon
- Shortcuts (desktop): `F2` search · `Enter` add · `F9` pay · `Ctrl+P` print

## Develop
`npm test` · `npm run typecheck` · `npm run lint`. See `CLAUDE.md` for conventions
(money = integer paise, quantity = integer milli-units, all stock changes via `src/services` in a transaction).
