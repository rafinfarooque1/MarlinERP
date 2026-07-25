# Marlin Frozen Fruits ERP

ERP for a frozen-fruit business: production, inventory, purchases, sales/invoicing, HR, double-entry accounts, and Indian GST compliance (returns, reconciliation).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server` — Express 5 API (raw pg queries; build-then-run via esbuild)
- `artifacts/marlin-erp` — React + Vite frontend (HMR, no restart needed)
- `lib/api-client-react` — react-query hooks (generated + hand-written extras like `src/gst.ts`)
- GST: slab rules + `lineTaxHeads()` in `artifacts/api-server/src/lib/gst.ts`; returns endpoints in `routes/gst.ts`; ledger derivation in `routes/journal.ts` (`buildDerivedPostings`)

## Architecture decisions

- Sales invoice PDFs render server-side only (`artifacts/api-server/src/services/invoicePdf.ts`) and are served via HMAC-tokenized public links (`GET /api/public/invoices/:token.pdf`, 30-day expiry) so customers can open them without logging in. Do not reintroduce client-side invoice PDF generation (blob downloads trip antivirus scanners).

## Product

- Company/locations/permissions, materials & BOM production, purchases & vendors, POS-style sales with server-rendered invoice PDFs, HR/payroll, double-entry accounts (ledgers, day book, trial balance)
- GST: slab-locked rates (0/5/12/18/28), head-wise Output/Input CGST-SGST-IGST ledgers, GST Returns page (HSN summary, GSTR-1, GSTR-3B with ITC set-off, ledger-vs-register reconciliation) with CSV exports

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After backend edits: `pnpm run build` in `artifacts/api-server`, then restart its workflow (esbuild bundle is what runs; it ignores type errors)
- After adding files to `lib/api-client-react/src/`: run `pnpm exec tsc` there to emit `.d.ts`, or frontend imports won't resolve types
- curl against the API: login via `POST /api/auth/login`, then `Authorization: Bearer <token>` (cookie auth does not work from curl)
- Server-side authorization is auth-only today; module/hierarchy enforcement is client-side pending Phase 7 (Security Hardening)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
