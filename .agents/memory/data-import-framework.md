---
name: Data import framework
description: Durable design constraints for the Import Data module; what any later import type (sales, receipts) must honour.
---

# Data import framework — design constraints

Rules that must hold for every import type, and why:

- **Commit through the manual-creation code path.** Extract a shared create
  function first if one doesn't exist; a duplicated create path silently
  diverges on ledger auto-provisioning, location stamping, and audit stamps.
- **Commit and rollback are mutually exclusive.** Commit creates records
  row-by-row (deliberately not one transaction — each row uses the manual
  path), so it holds the batch's advisory lock for the whole loop; rollback
  try-locks the same key and refuses while a commit runs. Rollback accepts only
  fully `committed` batches — a stuck `committing` batch (dead committer) needs
  eyes, not an automatic delete. Terminal status updates are conditional on the
  state the writer claimed. **Why:** a rollback interleaved with a live commit
  deletes early rows while later ones keep appearing — untracked records and a
  lying batch status.
- **Rollback eligibility from actual state, inside the deleting transaction,
  after deleting the batch's own opening balances** — otherwise the batch's own
  OBs count as "usage" and block every rollback. All-or-nothing with per-record
  reasons; only *created* records are reverted, never rows that updated
  pre-existing data.
- **Duplicates:** in-file duplicate = error; existing-record duplicate =
  warning with a skip-or-update decision that is re-checked at commit time, not
  trusted from validation. Names colliding with system accounts/groups are
  errors, never importable.
- **Client hooks are hand-written, not codegen** (the spec gates writes and
  strips fields); upload is a raw body to the parse endpoint.
- **Opening-balance FY** derives from the company's FY start month setting,
  never the stale financial-year text column.

## Location support & batch identity

- **Masters (customers/vendors/ledgers) REQUIRE a Location column** — blank is
  a row error, name resolved case-insensitively against warehouses/outlets/
  "Head Office" and scope-checked against the uploader. **Why:** an unstamped
  or wrongly-stamped master is invisible to every location view.
- **Txn/voucher files carry an OPTIONAL Location column that is a
  cross-check only** — it must match the batch's picked location by
  normalized NAME (mirror-safe) or the row errors; it never overrides the
  picked location.
- **Batch display id is DERIVED, never stored:** `IMP${id padded to 6}` via
  `batchDisplayId()`; UI keeps a client-side fallback format.
- **`import_batch_id` stamps go ONLY on records a batch CREATED** (8 tables);
  duplicate-update paths stay unstamped and are never rolled back. Rollback
  authority remains `import_rows`; stamps power counts + leftover checks.

## Rollback delete (counts, verification, role gate)

- **Role gate on rollback:** hierarchies.level ≤ 2 (Admin/Management) checked
  server-side ON TOP of the page delete right, fails closed on missing role.
- **Counts snapshot inside the txn BEFORE deletes** (one multi-subselect over
  the stamp columns) feeds the response, audit description AND
  `activity_log.metadata`.
- **Post-rollback verification runs AFTER COMMIT** (books derive via pool, an
  in-txn check can't see uncommitted deletes): leftover stamps = 0, TB
  balanced via `buildDerivedPostings({})`, and **batch-EXACT orphan check** —
  capture the batch's sale invoice numbers inside the txn, then assert no
  receipt with those voucher numbers survived. **Why:** a global orphan-count
  delta lets unrelated concurrent writes mask a real leftover (review
  finding); dev data already holds legacy orphans, so absolute counts fail.
- **Audit write is fire-and-forget** — tests must sleep briefly before
  querying `activity_log`.

## Transaction imports (sales & purchase invoices)

- **Imported SALES draw a fresh SB2B/SB2C number from the shared allocator**
  inside the import txn (series from the customer master's GST); the file's
  number is stored only in `sales.legacy_invoice_number` (searchable old
  reference). The sale receipt, stock-ledger notes and returned result all use
  the NEW number so the books-exclusion invariant and rollback's
  receipt-by-voucher delete stay consistent. Purchases still keep the supplied
  number (per-vendor uniqueness).

- **Commit via extracted doc functions** that replicate POST /sales and POST
  /purchases line-for-line (stock locks ascending, FEFO lots, business-dated
  stock_ledger, settlement, avg cost). **Why:** any shortcut diverges from the
  books; the routes are too entangled to call directly, so the shared pieces
  were exported and reassembled in one lib.
- **Process documents in FILE order, never re-sorted.** Weighted-average cost
  depends on entry order; the preview warns that backdated bills affect avg
  cost in the order they appear.
- **Grouping is ORDER-INDEPENDENT by invoice number alone** (owner REVERSED
  the earlier consecutive-rows rule, Aug 2026 — legacy exports scatter an
  invoice's rows). Key = lowercased invoice number; blank invoice = singleton
  doc; doc order = first appearance (preserves file-order avg cost). Blank
  Date/Customer on repeat rows INHERIT the group's first non-blank value;
  a CONFLICTING non-blank date or party on one invoice errors the offending
  row; other doc-level cells = first non-blank, later differing non-blank =
  warning (narration: silent).
- **Three forgiving-import settings in `company_settings.general_settings`**,
  read `!== false` (default ON): `importAutoWalkInCustomer`,
  `importMrpToDiscount`, `importDetectLineTotal`. MRP gate: toggle OFF turns
  the POS-style conversion into a row ERROR. `importAutoCreateCustomers` /
  `importAutoCreateVendors` were RETIRED with the mapping-first wizard —
  the backend no longer reads them (the Settings UI still shows the dead
  toggles; follow-up filed).
- **Walk-in sales:** blank customer + effective mode ≠ credit + toggle ON →
  `norm.walkIn`, commits with `customer_id NULL` and a B2C number (POS
  convention — there is NO "Walk-in" customer master). Blank + credit is
  always an error; vendors are always required.
- **Mapping-first resolution (replaced auto-create-at-commit, Aug 2026):**
  file names resolve to masters ONLY through saved `import_mappings` rows
  (kind + normalised name → target); an unmapped name holds the row at
  `needs_mapping` until the user maps or creates the master in the mapping
  step. Stale mappings (target deleted) are skipped → back to the mapping
  step. No silent name matching anywhere. The old test suites
  (`import-legacy-friendly`, `import-vouchers`,
  `import-txn-template-semantics`) still test the retired auto-create /
  resolve-step semantics and FAIL against this flow — see
  legacy-report-import.md before treating that as a regression.
- **Line Total column (toggle-gated):** blank price → derived from lt÷qty,
  BUT with a row discount the derived figure must be the GROSS one (sales:
  lt/qty + unitDiscount; purchases: (lt/qty)/(1−pct)) — the pricing engine
  applies the discount again, so deriving net and re-discounting understates
  money (review catch). Price≈lt with qty>1 unpacks to lt/qty ONLY when
  discount = 0 (ambiguous otherwise); mismatches warn and the Price column
  wins. Summary adds distinctParties/distinctItems/walkInInvoices/
  partiesToCreate; rows carry willCreateParty/walkIn.
- **`needs_party` is its own row status** (counted as error for commit
  gating); resolve-parties creates missing customers/vendors through the
  standard creation path (ledgers auto-provision) and then re-runs the whole
  validation over stored rows — no re-upload, and re-validation must rewrite
  batch counters too.
- **Target location is an explicit 400-guarded choice** — defaulting to the
  uploader's branch would stamp an entire migration onto the wrong location.
- **Rollback is all-or-nothing in ONE transaction** (unlike per-record masters
  rollback): settlement ids live on the head row's `raw.created`; purchase
  unwind runs `updateAvgCostOnReversal` BEFORE qty removal and blocks when the
  lot has been consumed; expect avg_cost to legitimately stay non-zero once
  remaining qty hits 0 (standard unwind semantics — inert, next inbound
  recomputes).
- **Template semantics (simplified Aug 2026): sales files are GST-INCLUSIVE
  with a PER-UNIT ₹ discount** — the manual sale entry convention; purchases
  stay GST-exclusive with % line discounts and NO bill discount (a non-zero
  Bill Discount cell errors with a spread-into-lines suggestion). GST/CGST/
  SGST/IGST columns are `hidden: true` ColSpecs: absent from the downloadable
  template but still alias-mapped for old files (cross-check warning only).
  **Why:** users enter business fields only; the ERP computes all tax, and an
  import must never create a document manual entry couldn't.
- **Legacy-batch commit compatibility:** sale line norms distinguish eras by
  key — `unitDiscount` present ⇒ inclusive/per-unit; legacy `discount` ⇒
  exclusive/line-total. The commit path honours whichever the stored norm
  carries so a batch previews and commits with the SAME math forever.
- **MRP handling is POS-style CONVERSION, not rejection:** a file price below
  the Item Master MRP converts at parse time — line price = master MRP, the
  difference folds into the per-unit discount (net unchanged) — with a per-row
  warning; a price ≥ MRP is used as-is. The recorded price never sits below
  the master MRP; `importSaleDoc` keeps `checkMrpFloor` at commit as a safety
  net (converted lines always pass; legacy exclusive-price lines stay
  grandfathered). **Why:** owner spec — imports must behave exactly like the
  POS, and old-ERP files legitimately carry net prices below today's MRP.
- **Preview/commit summary figures must come from the pricing-engine OUTPUTS,
  never re-derived from file values:** sales discount = Σ built line
  `discount` (item + paise-exact bill-discount share); purchase taxable/
  discount = `priceBill`'s `taxableTotal`/`discountTotal`. Hand-recalculated
  aggregates drift from what commit records on fractional qty/rounding
  (review finding). Head rows carry computedTax/Taxable/Qty/Discount in norm;
  `txnBatchSummary()` sums them for parse, batch-GET AND resolve-parties
  responses (resolve replaces the preview — dropping summary there blanks the
  totals strip right after the mandatory resolve step).
- **Resolve-created parties are deliberately NOT stamped with
  import_batch_id** — they are permanent masters that survive txn rollback
  (like manual creation), and stamping them would trip
  `verifyAfterRollback`'s leftover-stamps check. The post-commit report
  counts them via the exact notes marker `Created during import batch #<id>`
  instead of the stamp tables.
- **Error file route** (`GET /imports/batches/:id/error-file`, download
  right): xlsx of only error/needs_party/failed rows = template VISIBLE
  columns + Error Reason + How To Fix, values from `raw.values`; 404 when no
  failed rows. Post-commit UI gating must look at batch error+failed row
  counts, not the commit summary's `failed` (pre-commit error rows commit as
  skipped, not failed).
- **Purchases have a Payment Account column** resolved through the voucher
  imports' `importAccountOptions`/`resolveAccountValue` (blank/cash → till,
  bank → unique STD-BANK leaf, else exact name). Commit RE-RESOLVES the stored
  ledger id against the same option set — a bare "ledger still exists" check
  would settle from a deactivated/moved ledger.
- **Paid Amount blank rules:** Paid → full total; Partial → ERROR (both
  modules); blank status → unpaid, but a supplied Paid Amount is always
  honoured as a part-payment (documented in hints — don't "fix" one without
  the other).
- **The parse response strips `raw`** — assertions about norm fields
  (paidAmount, line shapes) must read `import_rows.raw` from the DB, not the
  HTTP response.
- **Settlement facts that trip test expectations:** purchases round-off to
  whole rupees (`round_off` col); sales status value is `partially_paid` (not
  "partial"); cash/UPI/bank sales settle at creation with NO sale_payments
  row — only credit collections write one; interstate detection reads
  `company_settings.state`, which can be blank (→ intrastate fallback).

## Voucher imports (receipts & payments)

- **The validation-time allocation plan is preview-only.** Commit RECOMPUTES
  allocation inside each voucher's transaction on row-locked documents.
  **Why:** dues can change between parse and commit; trusting the stored plan
  would over- or double-settle.
- **The preview plan runs over a RUNNING outstanding shared across the file**
  (earlier rows decrement what later rows see) so multi-row files preview the
  same way they commit. Explicit against-invoice refs settle ONLY that doc
  (detailed error classes: not found / cancelled / branch-transfer / other
  location / already settled); blank refs go FIFO oldest-first; excess parks
  in CADV/VADV via the standard advance path.
- **Provenance is `source='allocation'`** — edit-locked like allocation
  vouchers, books derive with zero journal changes, never NULL (NULL fails
  closed for edit rights).
- **Account cell mapping:** blank/"cash" → the location's cash till
  (mirror-aware); "bank" → the unique STD-BANK leaf; anything else = exact
  case-insensitive ledger-name match, error otherwise.
- **Rollback refusal reads `advance_consumptions`** (attribution to the
  parking voucher's id) — a consumed advance blocks the WHOLE batch with a
  per-voucher reason; freeing the consumption unblocks it.
- **Dues include GST:** sale outstanding is MRP-inclusive but purchase-bill
  dues = taxable + GST (unitCost is pre-tax) — FIFO expectations in tests must
  use bill TOTALS, not qty×unitCost.

## Migration wizard (multi-file umbrella)

- **A migration OWNS its batches** (`import_batches.migration_id`): every
  per-batch mutating endpoint must 409 on migration-owned batches, and the
  standalone batch list filters `migration_id IS NULL`. **Why:** two drivers
  over one batch desync the migration's combined state.
- **Location is chosen LAST, at approval — by design.** Files carry no
  location; mapping/demo stamp a PROVISIONAL Head Office location, and
  approve re-stamps + re-validates everything at the chosen location inside
  the import transaction. Copy tells users to leave Location columns blank.
- **Demo = ONE never-committed transaction** over the fixed run order
  (opening_stock → purchases → sales → receipts → payments → daybook); the
  comparison report pack is captured from inside that txn and persisted for
  later viewing. Approve replays the same order in ONE real transaction;
  any failure aborts everything (status reverts, nothing partial).
- **Any mapping edit demotes a demo_ready migration back to draft** — a demo
  is only valid for the mappings it ran under.
- **Rollback is whole-migration only** (reverse run order, role level ≤ 2,
  blocked → 409 with nothing deleted, per-batch verification after).
- **Frontend:** ImportData 'Migration' tab (default) hosts MigrationWizard;
  Masters tab keeps standalone master imports; MappingStep/DemoReportView are
  shared components taking either batchId or migrationId.
