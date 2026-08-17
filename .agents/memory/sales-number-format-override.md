---
name: Sales number format override & admin renumbering
description: Per-location invoice number formats (short FY, no padding, continuous serial), the once-per-location renumber migration, and the scope lock protocol every number producer must follow.
---

## Format overrides (`sales_number_formats`)
- Keyed on the folded counter scope (e.g. `warehouse:1`). Row present ⇒ that location prints `SB2C/26-27/7490` style: `fy_short` (short FY segment), `pad=0` (no zero padding), `continuous` (ONE serial across financial years — counter row keyed `'ALL'` instead of the FY label).
- Rows are created ONLY by the admin renumber apply. Absence = default format (`SB2C/2026-27/000001`, per-FY counters). `getSalesNumberFormat` defaults on missing row OR missing table.
- **Every producer must go through the format helpers** (`formatSalesInvoiceNumber`, `salesCounterFyLabel`): the sale-creation allocator, the B2C→B2B reclass, and the every-boot counter reconcile (which folds cross-FY max onto the `'ALL'` row for continuous scopes). A producer that hardcodes the shape forks the series.
- Stamped `invoice_fy` = the PRINTED segment (`26-27`), so `split_part(invoice_number,'/',2)` and the identity columns always agree. `shortFyLabel` is idempotent.
- Books-shape predicates match on `SB2B/%`/`SB2C/%` prefixes and receipt↔sale number equality — both survive the format change by construction, but any NEW consumer that regex-parses the FY segment must accept both `\d{4}-\d{2}` and `\d{2}-\d{2}`.

## Scope lock protocol (deadlock + escape prevention)
- `acquireSalesScopeLockShared(q, scope)` in every allocator/reclass, `acquireSalesScopeLockExclusive` in the renumber migration — advisory xact lock on `hashtext('sales_scope:'||scope)`, taken BEFORE any counter or sale-row lock.
- **Why:** counter-row pre-locking alone cannot block a concurrent sale dated in an FY with no counter row yet (it INSERTs a fresh row and escapes the migration in the old format), and apply-takes-counters-first vs reclass-takes-rows-first is a direct deadlock cycle. Shared/shared is free, so normal sales stay concurrent.
- **How to apply:** any future producer that draws or rewrites sales numbers must take the shared side first; any future bulk rewrite takes the exclusive side.

## Renumber migration rules
- Once per location — the format row IS the "already applied" marker (409 on re-run). Preview (read-only mapping) → apply (one txn, expectedTotal recheck). Cancelled bills keep their chronological slot; order = `sale_date, invoice_serial, id` per series; `branch_transfer_id IS NOT NULL` rows excluded.
- Trail renamed in the SAME txn via reclass's `renameTrail` (receipts with unconditional location guard, sale-bound quotations, payment notes). Old number kept in `legacy_invoice_number` (COALESCE — never overwrite an earlier legacy value).
- Fail closed on SB2x-prefixed rows with unstamped identity (`oddShaped`) — "renumber everything" must never silently skip rows.
- Proof standard: financial statements bitwise identical before/after, receipt pairing count unchanged, orphan count not increased, dup check 0 — all in-txn, throwing rolls everything back. `invoice_renumber_log` keeps the permanent old→new record per bill.
- Ragiguda (warehouse:1) migrated Aug 2026: B2C from 7490, B2B from 130, continuous.

## Global short-format rollout (mid-Aug 2026) — short format is now THE standard
- Company decision: ALL GST/customer documents print `PREFIX/YY-YY/N` (short FY, unpadded). Scope = SB2B/SB2C sales + SR/PR returns + CN/DN notes ONLY; REC/PAY/JV/CTR/QTN/EXP stay long padded — do not "clean up" that asymmetry.
- Non-sales GST docs: `SHORT_FORMAT_VOUCHER_TYPES` in voucherNumber.ts flips PRINTING only; sequence rows stay keyed on the LONG fy_label so counters never reset. History converted by boot migration `gst_doc_short_numbers_v1` (migration_log-guarded, one txn, per-table dup check fails closed, old numbers kept in `legacy_return_number`/legacy cols, narrations/notes rewritten).
- Sales history: admin renumber gained `mode:'preserve'` (UI default "Keep bill numbers — change format only") — keeps each stamped `invoice_serial`, no start inputs, may apply with 0 rows. `mode:'restart'` is the old flow; counter rewind (SET) happens ONLY on `isRerun && restart`, all other paths GREATEST. Preserve adds a per-FY counter high-water floor so serials burned under per-FY counters (bill printed then deleted) can never be reissued on the folded `'ALL'` row.
- New locations auto-seed a short-format row at creation (`system:new-location`, ON CONFLICT DO NOTHING, seeded AFTER ledger provisioning so mirror outlets fold to the warehouse scope) — a new branch never starts in the long format.
- Test suites anchor "next expected number" on the COUNTER (`'ALL'` + FY rows, GREATEST with stored max), never on MAX(invoice_number): deleted bills leave the counter ahead by design.
- All three locations' sales history converted in dev via preserve mode; prod rollout = publish (boot migration converts SR/PR/CN/DN automatically) + owner runs preserve-mode renumber per location in Settings.

## Reset-lock & corrected re-runs (Aug 2026)
- `POST /admin/sales-renumber/reset-lock` (level-1 + `confirm:true`) deletes exactly the one marker row under the exclusive scope lock and, IN THE SAME TXN, inserts a `series='RESET'` event row into `invoice_renumber_log` (sale_id 0). That row is BOTH the durable audit and the re-run authorisation.
- Re-run eligibility = the RESET row exists, NOT "some batch exists": a marker deleted by hand in SQL leaves no RESET row, so the half-landed 409 still fails closed. Preview's marker 409 carries `code:"ALREADY_MIGRATED"`; the UI renders it as an inline panel with the clear-lock button.
- Counter semantics differ by run: first run keeps GREATEST (never rewind); a re-run SETs the `'ALL'` counter to max(plan lastSerial, branch-transfer SB2x serials, log-recorded serials whose sale no longer exists). The last floor stops re-issuing numbers of bills renumbered earlier then deleted; a bill both created AND deleted after the prior migration leaves no trace anywhere — accepted, documented residue.
- Window between reset and corrected apply: the allocator falls back to the default long format; the re-run folds those bills in. `invoice_renumber_log` and counters are never touched by reset.
- Legacy preservation across any number of re-runs is the COALESCE: `legacy_invoice_number` always keeps the ORIGINAL pre-migration number, verified by checksum in rehearsal.
