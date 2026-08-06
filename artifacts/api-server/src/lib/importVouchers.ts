/**
 * Receipt & payment vouchers imported from the old ERP.
 *
 * Each voucher commits through the SAME settlement primitives the manual
 * allocation routes use (POST /accounts/receipts and /accounts/payments with
 * allocations): per-bill caps validated on locked rows, sale_payments legs
 * linked via clearing_receipt_id, payment_bill_allocations rows, and any
 * excess parked in the party's CADV-/VADV- advance ledger provisioned by
 * ensureAdvanceLedger — so imported vouchers reach every book (cash book,
 * bank book, day book, ledgers, trial balance, dashboard) through the
 * existing derivation with no new plumbing, and their advances are
 * consumable by later sales/purchases exactly like manually created ones.
 *
 * Provenance: every voucher is stamped source = 'allocation' — the same
 * provenance the manual settlement path writes. That keeps the vouchers
 * EDIT-locked (allocation vouchers are never editable) while remaining
 * deletable through the allocation-unwind recipe, which is exactly what the
 * batch rollback below performs. Provenance is never NULL.
 *
 * Voucher numbers supplied in the file are kept VERBATIM (validation enforces
 * uniqueness; the sequence allocator is not touched for them). Rows without a
 * number draw one from the normal voucher_sequences allocator — never from
 * COUNT(*).
 *
 * Allocation, mirroring the settlement engine:
 *   - an explicit against-invoice reference allocates ONLY to that invoice
 *     (error when missing or already settled); any excess → advance.
 *   - no reference → FIFO oldest-first across the party's open invoices at
 *     the batch's target location (Head Office target = unrestricted, the
 *     same rule the manual path applies to callers); excess → advance.
 */
import { pool, type PgPoolClient as PoolClient } from "@workspace/db";
import { nextVoucherNumber } from "./voucherNumber";
import {
  computePaymentPosition, loadPaymentPosition, outstandingExpr, r2,
} from "./salePaymentPosition";
import { ensureCustomerLedger, ensureVendorLedger } from "./partyCreate";
import {
  ensureAdvanceLedger, takeAdvanceLock, voucherAdvanceConsumed, advanceAvailable,
  parsePartyLedgerCode,
} from "./advanceLedgers";
import { purchaseSettlementIndex } from "./vendorBillSettlement";
import { type ProdLocation } from "./productionCosting";
import { locationOwnedLedgerMap } from "./moneyScope";

type Q = { query: Function };

const EPS = 0.005;

// ── Shared ledger lookups ────────────────────────────────────────────────────

async function ledgerIdByCode(q: Q, code: string): Promise<number | null> {
  const { rows: [r] } = await (q as any).query(`SELECT id FROM account_ledgers WHERE code = $1`, [code]);
  return r ? Number(r.id) : null;
}

/** The till money is collected into / paid out of at a location.
 *  HO uses STD-CASH; branches use their provisioned cash ledger
 *  (id column first — mirror locations share one till — then code). */
export async function locationCashLedgerId(q: Q, loc: ProdLocation): Promise<number | null> {
  if (loc.type === "headoffice") return ledgerIdByCode(q, "STD-CASH");
  const table = loc.type === "warehouse" ? "warehouses" : "outlets";
  const { rows: [locRow] } = await (q as any).query(
    `SELECT cash_ledger_id FROM ${table} WHERE id = $1`, [loc.id],
  );
  if (locRow?.cash_ledger_id != null) {
    const { rows: [l] } = await (q as any).query(
      `SELECT id FROM account_ledgers WHERE id = $1`, [Number(locRow.cash_ledger_id)],
    );
    if (l) return Number(l.id);
  }
  const code = loc.type === "warehouse" ? `WH-CASH-${loc.id}` : `OUTLET-CASH-${loc.id}`;
  return ledgerIdByCode(q, code);
}

/** Is this ledger anywhere under the STD-CASH head? Decides sale_payments.method. */
async function isCashFamilyLedger(q: Q, ledgerId: number): Promise<boolean> {
  const { rows } = await (q as any).query(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id, code FROM account_ledgers WHERE id = $1
       UNION ALL
       SELECT l.id, l.parent_id, l.code FROM account_ledgers l JOIN anc ON l.id = anc.parent_id
     )
     SELECT 1 FROM anc WHERE code = 'STD-CASH' LIMIT 1`,
    [ledgerId],
  );
  return rows.length > 0;
}

// ── Received-in / paid-from account resolution ───────────────────────────────
// The valid money accounts for a batch's target location: the location's OWN
// cash till (never another location's — the same scoping the manual voucher
// legs enforce) plus the company's bank accounts under STD-BANK.

export interface AccountOption { id: number; name: string; kind: "cash" | "bank" }

export async function importAccountOptions(q: Q, loc: ProdLocation): Promise<AccountOption[]> {
  const out: AccountOption[] = [];
  const cashId = await locationCashLedgerId(q, loc);
  if (cashId != null) {
    const { rows: [c] } = await (q as any).query(`SELECT name FROM account_ledgers WHERE id = $1`, [cashId]);
    out.push({ id: cashId, name: c?.name ?? "Cash", kind: "cash" });
  }
  const { rows: banks } = await (q as any).query(
    `WITH RECURSIVE sub AS (
       SELECT id, parent_id, name, is_active FROM account_ledgers WHERE code = 'STD-BANK'
       UNION ALL
       SELECT l.id, l.parent_id, l.name, l.is_active FROM account_ledgers l JOIN sub ON l.parent_id = sub.id
     )
     SELECT s.id, s.name FROM sub s
      WHERE COALESCE(s.is_active, true)
        AND NOT EXISTS (SELECT 1 FROM account_ledgers ch WHERE ch.parent_id = s.id)
      ORDER BY s.id`,
  );
  // Branch-assigned Cash & Bank ledgers live under STD-BANK too, but they are
  // another location's till: a voucher through one MUST be stamped with that
  // owner (the rule every manual money-voucher route enforces), so a batch
  // targeting a different location may never pick them. Only the batch
  // location's own accounts and the company's unassigned banks are offered.
  const owned = await locationOwnedLedgerMap();
  for (const b of banks) {
    const owners = owned.get(Number(b.id)) ?? [];
    const usable = owners.length === 0
      || owners.some((o) => o.locationType === loc.type && Number(o.locationId) === Number((loc as any).id ?? 0));
    if (usable && !out.some((o) => o.id === Number(b.id))) {
      out.push({ id: Number(b.id), name: String(b.name), kind: "bank" });
    }
  }
  return out;
}

/**
 * Commit-time guard: the money account a voucher posts through must agree
 * with the document's location stamp. Validation already filters the options
 * (importAccountOptions above), but masters can change between validate and
 * commit — and the stamp decides which location's books own the money, so a
 * mismatch must never reach the table.
 */
async function assertAccountMatchesLocation(accountLedgerId: number, loc: ProdLocation): Promise<void> {
  const owned = await locationOwnedLedgerMap();
  const owners = owned.get(Number(accountLedgerId)) ?? [];
  if (owners.length === 0) return; // company (HO) account — usable by any batch location
  const match = owners.some((o) => o.locationType === loc.type && Number(o.locationId) === Number((loc as any).id ?? 0));
  if (!match) {
    throw new Error(
      `The chosen money account belongs to ${owners[0].name} — record the voucher under that location, or pick the batch location's own account and re-validate.`,
    );
  }
}

/** Map a row's account cell onto one of the location's valid money accounts. */
export function resolveAccountValue(
  value: string,
  options: AccountOption[],
): { ok: true; account: AccountOption } | { ok: false; error: string } {
  const norm = value.trim().toLowerCase();
  const cash = options.find((o) => o.kind === "cash");
  const banks = options.filter((o) => o.kind === "bank");
  if (!norm || norm === "cash") {
    if (!cash) return { ok: false, error: "This location has no cash ledger provisioned — name a bank account instead." };
    return { ok: true, account: cash };
  }
  if (norm === "bank") {
    if (banks.length === 1) return { ok: true, account: banks[0] };
    if (banks.length === 0) return { ok: false, error: "No bank account exists in the chart of accounts — write Cash, or create the bank ledger first." };
    return { ok: false, error: `More than one bank account exists — name it exactly: ${banks.map((b) => b.name).join(", ")}.` };
  }
  if (norm === "upi") {
    // Old-software exports say just "UPI" — resolve to the bank-family ledger
    // that carries UPI in its name, exactly one of which may exist.
    const upis = banks.filter((b) => b.name.toLowerCase().includes("upi"));
    if (upis.length === 1) return { ok: true, account: upis[0] };
    if (upis.length === 0) return { ok: false, error: "No UPI account exists in the chart of accounts — create a bank-type ledger with UPI in its name (e.g. \"UPI Collections\"), or name a bank account instead." };
    return { ok: false, error: `More than one UPI account exists — name it exactly: ${upis.map((b) => b.name).join(", ")}.` };
  }
  const hit = options.find((o) => o.name.trim().toLowerCase() === norm);
  if (hit) return { ok: true, account: hit };
  return {
    ok: false,
    error: `Unknown account "${value.trim()}". Valid for this location: ${options.map((o) => o.name).concat(["Cash", "Bank"]).join(", ")}.`,
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Voucher location stamp: HO vouchers carry location_id 0 (the voucher-table
 *  convention — sales/stock use 1, vouchers use 0). */
function voucherStamp(loc: ProdLocation): { type: string; id: number } {
  return { type: loc.type, id: loc.type === "headoffice" ? 0 : loc.id };
}

async function assertVoucherNumberFree(
  client: PoolClient, table: "receipts" | "payments", voucherNumber: string,
): Promise<void> {
  // The sales bill series (SB2B/SB2C) is reserved for the sale flows: every
  // accounting predicate that separates sale-trail receipts from manual ones
  // matches on that number shape, so a manual/imported voucher wearing it
  // would silently vanish from the books the day a sale draws the same
  // number. Invoice numbers run per location now, which makes that collision
  // reachable — refuse the number instead of importing a time bomb.
  if (/^SB2[BC]\//i.test(voucherNumber.trim())) {
    throw new Error(
      `Voucher number ${voucherNumber} uses the sales bill series (SB2B/SB2C), which is reserved for sales invoices — leave the voucher number blank to draw the next receipt/payment number.`
    );
  }
  const { rows } = await client.query(
    `SELECT 1 FROM ${table} WHERE LOWER(voucher_number) = LOWER($1) LIMIT 1`,
    [voucherNumber],
  );
  if (rows.length > 0) throw new Error(`Voucher number ${voucherNumber} already exists.`);
}

export interface VoucherAllocation { id: number; invoiceNumber: string | null; amount: number }

export interface ImportedVoucherResult {
  id: number;
  voucherNumber: string;
  allocations: VoucherAllocation[];
  advanceAmount: number;
  advanceLedgerId: number | null;
}

// ── Receipts ─────────────────────────────────────────────────────────────────

export interface ImportReceiptVoucherInput {
  /** Old-ERP voucher number — stored in legacy_voucher_number (searchable);
   *  the voucher itself ALWAYS draws the next ERP number from the allocator. */
  legacyVoucherNumber: string | null;
  date: string; // YYYY-MM-DD (business date)
  customerId: number;
  customerName: string;
  amount: number;
  /** The received-in cash/bank ledger (already resolved by validation). */
  accountLedgerId: number;
  /** Explicit against-invoice target; null → FIFO oldest-first. */
  explicitSaleId: number | null;
  narration: string | null;
  reference: string | null;
  loc: ProdLocation;
  user: string;
}

/**
 * When `ext` is supplied the voucher writes through THAT client inside a
 * SAVEPOINT (caller owns BEGIN/COMMIT — demo import / all-or-nothing commit).
 * Without `ext` it keeps its historical own-connection behaviour.
 */
export async function importReceiptVoucher(doc: ImportReceiptVoucherInput, ext?: PoolClient): Promise<ImportedVoucherResult> {
  const custLedgerId = await ensureCustomerLedger(doc.customerId, doc.customerName, ext ?? pool);
  if (custLedgerId == null) throw new Error(`Customer ledger could not be provisioned for ${doc.customerName}.`);

  const client = ext ?? await pool.connect();
  try {
    await client.query(ext ? "SAVEPOINT import_doc" : "BEGIN");

    // Migration-wizard rule: the ERP allocates its own voucher number; the
    // file's number is kept as the searchable legacy reference only.
    const voucherNumber = await nextVoucherNumber(client, "receipt", doc.date);

    // ── Allocation on locked rows, same checks as the manual settlement path ──
    const details: { sale: any; amount: number; position: any }[] = [];
    let remaining = r2(doc.amount);

    const checkSale = (sale: any) => {
      const label = sale.invoice_number ?? `#${sale.id}`;
      if (Number(sale.customer_id) !== doc.customerId) throw new Error(`Invoice ${label} belongs to a different customer.`);
      if (sale.cancelled_at) throw new Error(`Invoice ${label} has been cancelled — nothing can be settled against it.`);
      if (sale.branch_transfer_id) throw new Error(`Invoice ${label} is a branch transfer document and is settled by the transfer flow.`);
      const sLocType = sale.location_type ?? "outlet";
      const sLocId = Number(sale.location_id ?? sale.outlet_id);
      if (doc.loc.type !== "headoffice" && (sLocType !== doc.loc.type || sLocId !== doc.loc.id)) {
        throw new Error(`Invoice ${label} was raised at another location — its collections are recorded there.`);
      }
    };

    const lockSale = async (saleId: number) => {
      const { rows: [sale] } = await client.query(
        `SELECT id, invoice_number, customer_id, outlet_id, location_type, location_id,
                cancelled_at, branch_transfer_id,
                total_amount::numeric AS total_amount, amount_paid::numeric AS amount_paid
           FROM sales WHERE id = $1 FOR UPDATE`,
        [saleId],
      );
      return sale ?? null;
    };

    if (doc.explicitSaleId != null) {
      const sale = await lockSale(doc.explicitSaleId);
      if (!sale) throw new Error(`Invoice not found (sale #${doc.explicitSaleId}).`);
      checkSale(sale);
      const position = await loadPaymentPosition(client, sale.id);
      if (!position || position.outstanding <= 0.004) {
        throw new Error(`Invoice ${sale.invoice_number ?? `#${sale.id}`} is already fully settled — remove the reference or reduce the amount.`);
      }
      const take = r2(Math.min(remaining, position.outstanding));
      details.push({ sale, amount: take, position });
      remaining = r2(remaining - take);
    } else {
      // FIFO oldest-first over the party's open invoices (scoped to the batch's
      // target location unless that target is Head Office). Snapshot first,
      // then lock the needed subset in ascending id order (the codebase's
      // stable lock order) and clamp against the LIVE outstanding.
      const params: unknown[] = [doc.customerId];
      let scopeSql = "";
      if (doc.loc.type !== "headoffice") {
        params.push(doc.loc.type, doc.loc.id);
        scopeSql = ` AND COALESCE(s.location_type, 'outlet') = $2 AND COALESCE(s.location_id, s.outlet_id) = $3`;
      }
      const { rows: cands } = await client.query(
        `SELECT s.id, ${outstandingExpr("s")} AS outstanding
           FROM sales s
          WHERE s.customer_id = $1 AND s.cancelled_at IS NULL AND s.branch_transfer_id IS NULL
            AND ${outstandingExpr("s")} > 0.004${scopeSql}
          ORDER BY s.sale_date ASC, s.id ASC`,
        params,
      );
      // Choose the FIFO subset the snapshot says we need, then lock it.
      const chosen: number[] = [];
      let cover = remaining;
      for (const c of cands) {
        if (cover <= 0.004) break;
        chosen.push(Number(c.id));
        cover = r2(cover - Number(c.outstanding));
      }
      const locked = new Map<number, { sale: any; position: any }>();
      for (const id of [...chosen].sort((a, b) => a - b)) {
        const sale = await lockSale(id);
        if (!sale) continue;
        checkSale(sale);
        const position = await loadPaymentPosition(client, id);
        if (position) locked.set(id, { sale, position });
      }
      for (const id of chosen) { // allocate in FIFO (oldest-first) order
        if (remaining <= 0.004) break;
        const d = locked.get(id);
        if (!d || d.position.outstanding <= 0.004) continue;
        const take = r2(Math.min(remaining, d.position.outstanding));
        details.push({ sale: d.sale, amount: take, position: d.position });
        remaining = r2(remaining - take);
      }
    }

    // ── Excess → the customer's advance ledger (provisioned on first use) ────
    const advance = remaining > 0.004 ? remaining : 0;
    let advanceLedgerId: number | null = null;
    if (advance > 0) {
      advanceLedgerId = await ensureAdvanceLedger(client, "customer", doc.customerId, doc.customerName);
    }

    const method = (await isCashFamilyLedger(client, doc.accountLedgerId)) ? "cash" : "bank";
    await assertAccountMatchesLocation(doc.accountLedgerId, doc.loc);
    const stamp = voucherStamp(doc.loc);
    const { rows: [r] } = await client.query(
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id,
                             reference_number, created_by, source, advance_amount, advance_ledger_id, legacy_voucher_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'allocation', $11, $12, $13) RETURNING id, voucher_number`,
      [voucherNumber, doc.date, custLedgerId, doc.accountLedgerId, r2(doc.amount),
       doc.narration, stamp.type, stamp.id, doc.reference, doc.user,
       advance, advanceLedgerId, doc.legacyVoucherNumber || null],
    );

    for (const d of details) {
      // reconciliation_status stays NULL: the money landed in the chosen
      // ledger directly — nothing for the electronic reconciliation queue.
      await client.query(
        `INSERT INTO sale_payments (sale_id, payment_date, method, amount, reference_number, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9)`,
        [d.sale.id, doc.date, method, d.amount, doc.reference,
         `Receipt voucher ${voucherNumber}`, r.id, d.sale.outlet_id, doc.user],
      );
      const newPaid = r2(Number(d.sale.amount_paid) + d.amount);
      const newPos = computePaymentPosition({
        totalAmount: Number(d.sale.total_amount), amountReceived: newPaid,
        creditAdjustments: d.position.creditAdjustments, cancelledAt: null,
      });
      await client.query(
        `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
        [newPaid, newPos.status, d.sale.id],
      );
    }

    await client.query(ext ? "RELEASE SAVEPOINT import_doc" : "COMMIT");
    return {
      id: Number(r.id), voucherNumber: String(r.voucher_number),
      allocations: details.map((d) => ({ id: d.sale.id, invoiceNumber: d.sale.invoice_number ?? null, amount: d.amount })),
      advanceAmount: advance, advanceLedgerId,
    };
  } catch (e) {
    await client.query(ext ? "ROLLBACK TO SAVEPOINT import_doc" : "ROLLBACK").catch(() => {});
    throw e;
  } finally {
    if (!ext) (client as PoolClient).release();
  }
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface ImportPaymentVoucherInput {
  /** Old-ERP voucher number — stored in legacy_voucher_number (searchable);
   *  the voucher itself ALWAYS draws the next ERP number from the allocator. */
  legacyVoucherNumber: string | null;
  date: string;
  vendorId: number;
  vendorName: string;
  amount: number;
  /** The paid-from cash/bank ledger (already resolved by validation). */
  accountLedgerId: number;
  /** Explicit against-bill target; null → FIFO oldest-first. */
  explicitPurchaseId: number | null;
  narration: string | null;
  reference: string | null;
  loc: ProdLocation;
  user: string;
}

/** Same `ext` contract as importReceiptVoucher. */
export async function importPaymentVoucher(doc: ImportPaymentVoucherInput, ext?: PoolClient): Promise<ImportedVoucherResult> {
  const vendLedgerId = await ensureVendorLedger(doc.vendorId, doc.vendorName, ext ?? pool);
  if (vendLedgerId == null) throw new Error(`Vendor ledger could not be provisioned for ${doc.vendorName}.`);

  // Dues the way every report computes them (shared settlement index):
  // explicit allocations, advance applications and the FIFO pool all reduce a
  // bill's balance. The hard cap inside the transaction holds under concurrency.
  // Threaded through ext so a demo run sees its own imported bills/settlements.
  const idx = await purchaseSettlementIndex([doc.vendorId], ext);

  const client = ext ?? await pool.connect();
  try {
    await client.query(ext ? "SAVEPOINT import_doc" : "BEGIN");

    // Migration-wizard rule: the ERP allocates its own voucher number; the
    // file's number is kept as the searchable legacy reference only.
    const voucherNumber = await nextVoucherNumber(client, "payment", doc.date);

    const checkBill = (bill: any) => {
      const label = bill.invoice_number ?? `#${bill.id}`;
      if (Number(bill.vendor_id) !== doc.vendorId) throw new Error(`Bill ${label} belongs to a different vendor.`);
      if (bill.branch_transfer_id) throw new Error(`Bill ${label} is a branch transfer document and is settled by the transfer flow.`);
      const bLocType = bill.location_type ?? "headoffice";
      const bLocId = Number(bill.location_id ?? 0);
      if (doc.loc.type !== "headoffice" && (bLocType !== doc.loc.type || bLocId !== doc.loc.id)) {
        throw new Error(`Bill ${label} belongs to another location.`);
      }
    };

    const lockBill = async (purchaseId: number) => {
      const { rows: [bill] } = await client.query(
        `SELECT id, invoice_number, vendor_id, branch_transfer_id, location_type, location_id,
                total_amount::numeric AS total_amount
           FROM purchases WHERE id = $1 FOR UPDATE`,
        [purchaseId],
      );
      return bill ?? null;
    };

    /** Hard cap on the locked row: explicit money against the bill can never
     *  exceed its total. */
    const headroom = async (bill: any): Promise<number> => {
      const { rows: [ex] } = await client.query(
        `SELECT COALESCE((SELECT SUM(amount)::numeric FROM payment_bill_allocations WHERE purchase_id = $1), 0)
              + COALESCE((SELECT SUM(amount)::numeric FROM purchase_advance_applications WHERE purchase_id = $1), 0) AS allocated`,
        [bill.id],
      );
      return r2(Number(bill.total_amount) - Number(ex?.allocated ?? 0));
    };

    const details: { bill: any; amount: number }[] = [];
    let remaining = r2(doc.amount);

    if (doc.explicitPurchaseId != null) {
      const bill = await lockBill(doc.explicitPurchaseId);
      if (!bill) throw new Error(`Purchase bill not found (#${doc.explicitPurchaseId}).`);
      checkBill(bill);
      const due = idx.get(bill.id)?.due ?? 0;
      const room = await headroom(bill);
      const cap = Math.min(due, room);
      if (cap <= 0.004) {
        throw new Error(`Bill ${bill.invoice_number ?? `#${bill.id}`} is already fully settled — remove the reference or reduce the amount.`);
      }
      const take = r2(Math.min(remaining, cap));
      details.push({ bill, amount: take });
      remaining = r2(remaining - take);
    } else {
      // FIFO oldest-first over the vendor's open bills (index dues), scoped to
      // the batch's target location unless it is Head Office.
      const { rows: bills } = await client.query(
        `SELECT id FROM purchases
          WHERE vendor_id = $1 AND branch_transfer_id IS NULL
          ORDER BY purchase_date ASC, id ASC`,
        [doc.vendorId],
      );
      const open: { id: number; due: number }[] = [];
      for (const b of bills) {
        const due = idx.get(Number(b.id))?.due ?? 0;
        if (due > 0.004) open.push({ id: Number(b.id), due });
      }
      const chosen: { id: number; due: number }[] = [];
      let cover = remaining;
      for (const b of open) {
        if (cover <= 0.004) break;
        chosen.push(b);
        cover = r2(cover - b.due);
      }
      const locked = new Map<number, any>();
      for (const b of [...chosen].sort((a, c) => a.id - c.id)) {
        const bill = await lockBill(b.id);
        if (!bill) continue;
        try {
          checkBill(bill);
        } catch {
          continue; // scoped out (e.g. another location's bill) — skip in FIFO
        }
        locked.set(b.id, bill);
      }
      for (const b of chosen) {
        if (remaining <= 0.004) break;
        const bill = locked.get(b.id);
        if (!bill) continue;
        const room = await headroom(bill);
        const cap = Math.min(b.due, room);
        if (cap <= 0.004) continue;
        const take = r2(Math.min(remaining, cap));
        details.push({ bill, amount: take });
        remaining = r2(remaining - take);
      }
    }

    const advance = remaining > 0.004 ? remaining : 0;
    let advanceLedgerId: number | null = null;
    if (advance > 0) {
      advanceLedgerId = await ensureAdvanceLedger(client, "vendor", doc.vendorId, doc.vendorName);
    }

    await assertAccountMatchesLocation(doc.accountLedgerId, doc.loc);
    const stamp = voucherStamp(doc.loc);
    const { rows: [r] } = await client.query(
      `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id,
                             reference_number, created_by, source, advance_amount, advance_ledger_id, legacy_voucher_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'allocation', $11, $12, $13) RETURNING id, voucher_number`,
      [voucherNumber, doc.date, doc.accountLedgerId, vendLedgerId, r2(doc.amount),
       doc.narration, stamp.type, stamp.id, doc.reference, doc.user,
       advance, advanceLedgerId, doc.legacyVoucherNumber || null],
    );
    for (const d of details) {
      await client.query(
        `INSERT INTO payment_bill_allocations (payment_id, purchase_id, amount) VALUES ($1, $2, $3)`,
        [r.id, d.bill.id, d.amount],
      );
    }

    await client.query(ext ? "RELEASE SAVEPOINT import_doc" : "COMMIT");
    return {
      id: Number(r.id), voucherNumber: String(r.voucher_number),
      allocations: details.map((d) => ({ id: d.bill.id, invoiceNumber: d.bill.invoice_number ?? null, amount: d.amount })),
      advanceAmount: advance, advanceLedgerId,
    };
  } catch (e) {
    await client.query(ext ? "ROLLBACK TO SAVEPOINT import_doc" : "ROLLBACK").catch(() => {});
    throw e;
  } finally {
    if (!ext) (client as PoolClient).release();
  }
}

// ── Rollback ─────────────────────────────────────────────────────────────────
// Both run inside the CALLER's transaction (the batch rollback is
// all-or-nothing) and answer a blocking reason string, or null when the
// voucher was removed. The unwind mirrors the manual DELETE of an allocation
// voucher: advance-consumption guard first (a slice adjusted against a later
// invoice/bill must never be pulled out from under it), then the settlement
// legs, then the voucher row.

export async function rollbackImportedReceiptVoucher(
  client: PoolClient, receiptId: number,
): Promise<string | null> {
  const { rows: [row] } = await client.query(
    `SELECT * FROM receipts WHERE id = $1 FOR UPDATE`, [receiptId],
  );
  if (!row) return null; // already gone — nothing to unwind
  const advAmt = Number(row.advance_amount ?? 0);
  if (advAmt > 0.004) {
    const party = parsePartyLedgerCode(
      (await client.query(`SELECT code FROM account_ledgers WHERE id = $1`, [row.received_from_ledger_id])).rows[0]?.code,
    );
    if (party) {
      await takeAdvanceLock(client, party.kind, party.partyId);
      const consumed = await voucherAdvanceConsumed(client, "receipt", receiptId);
      if (consumed > 0.004) {
        return `₹${r2(consumed).toFixed(2)} of this voucher's advance has been adjusted against invoices. Cancel those invoices first.`;
      }
      const pos = await advanceAvailable(party.kind, party.partyId);
      if (pos.available + EPS < advAmt) {
        return `₹${r2(advAmt - pos.available).toFixed(2)} of this voucher's advance has already been adjusted against invoices. Remove those adjustments first.`;
      }
    }
  }
  const { rows: legs } = await client.query(
    `SELECT sp.id, sp.sale_id, sp.amount FROM sale_payments sp
      WHERE sp.clearing_receipt_id = $1 ORDER BY sp.sale_id ASC`, [receiptId],
  );
  for (const leg of legs) {
    const { rows: [sale] } = await client.query(
      `SELECT id, total_amount::numeric AS total_amount, amount_paid::numeric AS amount_paid
         FROM sales WHERE id = $1 FOR UPDATE`, [leg.sale_id],
    );
    if (!sale) continue;
    await client.query(`DELETE FROM sale_payments WHERE id = $1`, [leg.id]);
    const newPaid = r2(Math.max(0, Number(sale.amount_paid) - Number(leg.amount)));
    const pos = await loadPaymentPosition(client, leg.sale_id);
    const newPos = computePaymentPosition({
      totalAmount: Number(sale.total_amount), amountReceived: newPaid,
      creditAdjustments: pos?.creditAdjustments ?? 0, cancelledAt: null,
    });
    await client.query(
      `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
      [newPaid, newPos.status, leg.sale_id],
    );
  }
  await client.query(`DELETE FROM receipts WHERE id = $1`, [receiptId]);
  return null;
}

export async function rollbackImportedPaymentVoucher(
  client: PoolClient, paymentId: number,
): Promise<string | null> {
  const { rows: [row] } = await client.query(
    `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId],
  );
  if (!row) return null;
  const advAmt = Number(row.advance_amount ?? 0);
  if (advAmt > 0.004) {
    const party = parsePartyLedgerCode(
      (await client.query(`SELECT code FROM account_ledgers WHERE id = $1`, [row.paid_to_ledger_id])).rows[0]?.code,
    );
    if (party) {
      await takeAdvanceLock(client, party.kind, party.partyId);
      const consumed = await voucherAdvanceConsumed(client, "payment", paymentId);
      if (consumed > 0.004) {
        return `₹${r2(consumed).toFixed(2)} of this voucher's advance has been adjusted against purchase bills. Delete those bills first.`;
      }
      const pos = await advanceAvailable(party.kind, party.partyId);
      if (pos.available + EPS < advAmt) {
        return `₹${r2(advAmt - pos.available).toFixed(2)} of this voucher's advance has already been adjusted against bills. Remove those adjustments first.`;
      }
    }
  }
  await client.query(`DELETE FROM payment_bill_allocations WHERE payment_id = $1`, [paymentId]);
  await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
  return null;
}
