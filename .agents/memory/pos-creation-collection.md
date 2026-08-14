---
name: POS creation-time collection
description: How New Sale collects money at billing through the one receipt engine — derived modes, partial/overpay rules, idempotency, Direct Income charges, price history.
---

# POS creation-time collection (New Sale pays at billing)

**Design:** `POST /sales` accepts raw-body (zod-stripped, read from `req.body` directly) `receivedInLedgerId`, `amountReceived`, `allowOverpayment`, `referenceNumber`, `clientRequestId`. Money posts through the SAME engine as the collect flow: `lib/saleCollection.ts` exports `resolveReceiveIntoAccount()` (validates the ledger belongs to the SALE location's Cash & Bank assignment set and derives cash/bank/upi from the ledger tree) and `postSaleCollectionReceipt()` (clearing receipt + receipt-backed `sale_payments` row, `source` NULL). `routes/payments.ts` is refactored onto both — there is ONE payment engine; never add a second posting path.

**Why:** payment methods must follow location config (the collect flow's source of truth), and a parallel creation-time engine would fork settlement/books behavior.

**Rules:**
- Stored `payment_mode` is DERIVED from the account, never trusted from the client. `credit` + `receivedInLedgerId` is contradictory → 400.
- Partial (`amountReceived` < total) requires a registered customer → sale stored as mode `credit`, `partially_paid`; walk-in partial = 400 `PARTIAL_REQUIRES_CUSTOMER`. Remainder settles via the existing collect path.
- Overpay = 400 `EXCEEDS_OUTSTANDING` (payload carries `excess`, `overpaymentAllowed`) unless customer + `allowOverpayment: true`; excess lands as the NETTED customer advance (credit balance on CUST-, no separate ledger). Walk-ins refused even with consent.
- Create replay on `clientRequestId` returns the original invoice (200) and never doubles `sale_payments`.
- Books invariant: `amount_paid = Σ sale_payments`; receipt voucher_number = invoice number, stamped to the selling location.

**Sale Other Charges rule change (Aug 2026):** NEW/edited sales accept only postable income ledgers strictly under `SYS-DIRINC` (`validateSaleOtherCharges`); stored legacy expense charges are grandfathered PER SALE via `opts.grandfatheredLedgerIds` (an edit may keep them but never introduce a new expense ledger). Boot seed created "Packing & Delivery Recovery" under SYS-DIRINC. The legacy importer stays on the old validator deliberately. Purchase charges stay expense-only.

**Price history:** `GET /sales/price-history?customerId&itemId&limit` (cap 10, default 5) — POS view right + LBAC scope, jsonb LATERAL over `line_items`, excludes cancelled + branch-transfer sales. Registered BEFORE `/sales/summary` (route-order trap). UI popover is informational only.

**How to apply / test gotchas:**
- Payments dupe guard: same sale + method + amount within 10s → 409 regardless of clientRequestId; test fixtures must split unequal amounts (40/60, not 50/50).
- Advance is NETTED: an open credit sale hides the overpay excess from `/accounts/party-advance` — unwind other outstanding first when asserting advance growth.
- Suites: `pos-create-collection.test.mjs`, `pos-other-charges.test.mjs`, `pos-partial-overpay-idempotency.test.mjs`; charges/create suites self-provision a level-1 probe user (bcryptjs insert) when TEST_USERNAME is unset.
- Accepted quirk: editing an overpaid settled-mode sale clamps `amount_paid` to total.
