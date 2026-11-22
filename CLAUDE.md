# retail-inventory-billing

Free, open-source stock management, dynamic pricing and POS billing for local
provision (grocery) stores and medical shops. Mobile-first PWA that also works on desktop,
served from a PC / Raspberry Pi over the LAN.

## Locked stack
Next.js (App Router, TS) · Tailwind CSS · SQLite via `better-sqlite3` + Drizzle ORM ·
`html5-qrcode` · Vitest. MIT/Apache-2.0/ISC dependencies only; no paid APIs, no cloud services.
Do not add dependencies without a clear justification.

## Commands
| Command | Purpose |
|---|---|
| `npm run dev` | Dev server on `0.0.0.0:3000` (reachable from phone on same Wi-Fi) |
| `npm run dev:https` / `start:https` | Same, with self-signed HTTPS (needed for phone camera scanning over LAN) |
| `npm run build` / `npm start` | Production build / serve on `0.0.0.0` |
| `npm run db:push` (= `db:migrate`) | Apply the committed SQL migrations (`drizzle/*.sql`) to `data/app.db`: creates a new DB or upgrades an existing one, non-interactive |
| `npm run db:generate` | After editing `src/db/schema.ts`: generate a new migration file (commit it) |
| `npm run db:seed` | Load sample grocery + pharmacy data (`-- --reset` wipes first) |
| `npm test` | Vitest (in-memory SQLite) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

DB file: `data/app.db` (gitignored; override with `DATABASE_PATH`). Backup = copy the file.

## Hard rules
1. **Money is integer paise.** Never use floats for currency. Format only at the UI edge (`src/lib/money.ts`).
2. **Quantity is integer milli-units** (1.5 kg = 1500, 3 strips = 3000). Convert with `src/lib/qty.ts`.
   Products with `allow_decimal_qty = false` must have quantity divisible by 1000.
3. **Prices are GST-inclusive.** Tax is back-calculated per line (`src/lib/gst.ts`); line total never drifts.
4. **Every stock change** goes through `src/services/*`, runs inside one `db.transaction`, updates
   `batches.quantity_available` AND appends a `stock_movements` row. Never mutate stock elsewhere.
   Invariant: `batch.quantity_available == SUM(stock_movements.quantity_delta)` for that batch.
5. **FEFO**: sell earliest-expiry batch first (`src/lib/fefo.ts`). Expired batches (`expiry_date < today`)
   must never be sold — re-validate inside the billing transaction, not just in the UI.
6. Invoice items snapshot name, price, GST rate and purchase price; later edits to products must not change old invoices.

## PIN login (optional)
Off by default; set in Settings (4-12 digits, scrypt-hashed in the `settings` table, no extra deps).
- **Every page, server action and route handler must call `await requireAuth()` first** (`src/lib/session.ts`).
  Layouts alone are not enough: they don't re-render on client navigation and actions can be invoked directly.
- `isAuthed()` must read `cookies()` *before* any early return, otherwise a build made with no PIN prerenders pages as static HTML.
- 5 wrong PINs lock logins for 60 s (global, in-memory). Changing/removing the PIN rotates the session secret (signs everyone out).
- Disabled in demo mode. Never log or return `pinHash` / `sessionSecret`.

## Database changes (migrations)
- **Never run `drizzle-kit push` against a real database.** It treats `default 0` as "no default" and demands an interactive data-loss confirmation (it failed on a populated DB).
  Schema changes = edit `schema.ts`, `npm run db:generate`, review and commit the SQL, then `npm run db:push` (which runs `src/db/migrate.ts`).
- `runMigrations` also upgrades databases created by the old `push` flow: it records migration 0000 as already applied, then applies the rest. Keep migrations **additive** (new tables/columns with defaults).
  `tests/migrate.test.ts` covers fresh, legacy-with-data and re-run cases; extend it when adding a migration that touches existing rows.

## Customer credit (udhaar)
- Tables `customers`, `payments`; `invoices.customer_id` + `credit_amount`. **A balance is computed, never stored**: Σ `credit_amount` of PAID invoices − Σ payments (`balanceOf` in `src/services/customers.ts`), so voids/returns correct it automatically.
- Credit needs an existing active customer (`CUSTOMER_REQUIRED`); `cash + upi + card + credit` must equal the grand total. Payments can't exceed the balance and are cash/upi/card only.
- Reports: `payments.credit` (sales on credit) and `duesCollected` (money received) are reported separately so the cash drawer reconciles. CSV types `dues` and `ledger`.
- WhatsApp reminders are plain `wa.me` links built locally (`src/lib/phone.ts`): no API, nothing sent by the server.

## Security & dependencies
- `npm run audit:prod` (= `npm audit --omit=dev --audit-level=high`) must stay clean; plain `npm audit` is currently 0 too. Re-check after any dependency change.
- `package.json` `overrides` are deliberate, don't remove them without re-running the audit: `next -> postcss` (`$postcss`, replaces next's pinned 8.4.31) and
  `@esbuild-kit/core-utils -> esbuild ^0.25.12` (drizzle-kit's bundled old esbuild). Versions in use: drizzle-orm 0.45.x, zod 4.x, vitest 5.x, Next 15.5.x. Next 16 is a deliberate, separate future migration.
- Every zod boundary has caps (names/SKU/barcode lengths, prices <= ₹1 crore, quantities <= 1M units, <= 200 cart lines). New inputs need caps too.
- All responses carry security headers (`SECURITY_HEADERS` in `next.config.ts`; no strict script CSP on purpose).
- `tests/security.test.ts` fails if a page, route handler or server action lacks `requireAuth()`, if `"use server"` appears outside `actions.ts`, or if a client component imports the DB layer.

## Barcode capture & online lookup
Add-product form (`ProductForm`): scan (camera), type, or USB scanner + Enter; then `lookupBarcode` (`src/services/productLookup.ts`).
- Looks at the shop's own products first (active **and archived**), then Open Food Facts / Beauty Facts / Products Facts. Results only **prefill**; nothing is saved automatically.
- Only the barcode digits are sent (`normalizeBarcode` rejects anything else, hosts are a fixed list: no SSRF); generic User-Agent, never add personal details.
- Needs outbound HTTPS on the Pi; failure degrades to manual entry. `PRODUCT_LOOKUP_BASE` overrides the sources (tests, mirrors).
- Client components must not import `@/db/schema`; shared enums live in `src/lib/constants.ts`.
- Medicines are mostly absent from free databases, so manual entry is normal there; the barcode is remembered locally after the first save.

## Editing products, batches and stock counts
- `updateProduct` / `updateBatch` / `adjustStock` in `src/services/inventory.ts`. Price/GST edits affect future sales only (invoice items snapshot).
- Unit may change freely among pcs/strip/bottle; other unit changes only while the product has no history. "Sold loose" can't be turned off while fractional stock exists.
- Quantity is never edited directly: `adjustStock` needs a reason and writes a signed `adjustment` movement in the same transaction (invariant: qty == Σ movements).
- `ProductForm` is dual-mode (create/edit); `lookupBarcode({ excludeProductId })` stops a product flagging its own barcode as a duplicate.

## Expired stock, archive and delete
- Write-off (`writeOffBatch`, `writeOffExpired`) goes through `writeOffInTx`: batch update + `expired_wastage` movement in one transaction.
- Written-off (qty 0) batches are hidden by default (`getProductBatches`); the ledger is never deleted.
- `archiveProduct` is refused while sellable stock remains (leftover *expired* stock is written off first). Archived = `is_active=false`;
  it must disappear from POS/search/lists and be unsellable and un-stockable. `deleteProduct` only for products with **no** batches, movements or invoice items.
- Irreversible UI actions use `ConfirmSubmit`; every new action calls `requireAuth()` first.

## Reports & CSV export
`src/services/reports.ts` (`getSalesReport`, `buildCsv`), UI at `/reports`, downloads at `/reports/export` (calls `requireAuth()`).
- Paid invoices only (void excluded); ranges are **local calendar days, inclusive**, so the server timezone matters.
- CGST/SGST are computed per slab and summed (`getSalesReport`), so GST rows always reconcile with totals.
- CSV via `src/lib/csv.ts`: money cells use `num(paiseToDecimal(x))` (integer math, never floats); text cells get the
  formula-injection guard, so never pass amounts as plain strings.

## Demo deployment
`netlify.toml` sets `NETLIFY_DEMO=1`: `getDb()` then auto-migrates and seeds a `/tmp` DB (`src/db/bootstrap.ts`).
It is ephemeral and for demos only — never real data. Normal runs (env unset) are unaffected.

## Conventions
- Strict TypeScript, no `any`. Validate all inputs at boundaries with `zod`.
- Pure business logic lives in `src/lib` (no DB/IO) and is unit-tested; DB logic in `src/services`.
- DB access is server-only (`src/db/client.ts`); client components never import it.
- Dates: store ISO `YYYY-MM-DD` for expiry/mfg, ISO timestamps for `created_at`. "Today" is injectable for tests.
- Tailwind only for styling; touch targets ≥ 44px; desktop shortcuts: F2 search, Enter add, F9 pay, Ctrl+P print.
- Tests live in `tests/`; integration tests use `better-sqlite3(':memory:')` with the real schema.

## Git
Develop on branch `ccr-ecf44a9e-yxvj6m`. Commit per vertical slice. Do not open a PR unless asked.
