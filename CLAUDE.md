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
| `npm run db:push` | Create/sync the SQLite schema from `src/db/schema.ts` |
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
