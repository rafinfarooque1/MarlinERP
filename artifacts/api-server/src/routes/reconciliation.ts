import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity, logActivityInTransaction } from "../lib/audit";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { isIsoDate } from "../lib/dateInput";
import { LEGACY_BANK_MODES } from "../lib/paymentModes";
import { getLocationFilter } from "../lib/requestLocation";
import { resolveMoneyVoucherLocation } from "../lib/moneyScope";
import { respondIfMonthLocked } from "../lib/periodLock";
import { buildBooks } from "../lib/books";
import {
  buildDerivedPostings,
  computeTrialBalance,
  computeCashBankBook,
  ledgerBookKind,
  bookAccessScope,
} from "./journal";
import { stockValuation } from "../lib/valuation";
import { getPostingLocationFilter } from "../lib/requestLocation";
import { postingMatchesLocation } from "../lib/postingLocation";
import { isLocationInScope } from "../lib/dataScope";
import { isLevelOneAdmin } from "../lib/adminGate";

const router = Router();

// A sale's location is `location_type` + `location_id`. `sale_payments.outlet_id`
// is copied from the legacy `sales.outlet_id`, which is null for warehouse sales
// and stale on others (a warehouse sale can still carry an old outlet id), so
// joining payments through it hides every warehouse receipt from reconciliation
// and mislabels some of the ones it does return. Resolve the location from the
// sale itself. Both joins are LEFT so a payment is never dropped for want of a
// location record.
const SALE_LOCATION_JOINS = `
     LEFT JOIN outlets    o ON s.location_type = 'outlet'    AND o.id = s.location_id
     LEFT JOIN warehouses w ON s.location_type = 'warehouse' AND w.id = s.location_id`;
const SALE_LOCATION_NAME = `COALESCE(o.name, w.name)`;

/**
 * Restrict a payment query to the caller's own location. Head office sees every
 * location; anyone bound to one sees only theirs. Scoping on the sale's location
 * rather than on `sale_payments.outlet_id` is what lets warehouse staff see
 * their own receipts at all.
 */
function applyLocationScope(
  req: any,
  params: any[],
  conds: string[],
  filter: { locationType?: string; locationId?: string; outletId?: string },
): void {
  const emp = req.employee as { branchType?: string; branchId?: number } | undefined;
  if (emp && emp.branchType && emp.branchType !== "headoffice" && emp.branchId != null) {
    params.push(emp.branchType); const t = params.length;
    params.push(emp.branchId);   const i = params.length;
    conds.push(`(s.location_type = $${t} AND s.location_id = $${i})`);
    return;
  }
  // `outletId` is the older param name for the same filter, and always an outlet.
  const type = filter.locationType ?? (filter.outletId ? "outlet" : undefined);
  const id = filter.locationId ?? filter.outletId;
  if (!type || !id) {
    // Global location context (headers) — applies only when the page passed
    // no explicit filter of its own. HO matches on type alone.
    const viewLoc = getLocationFilter(req);
    if (viewLoc) {
      params.push(viewLoc.locationType); const t = params.length;
      if (viewLoc.locationType === "headoffice") {
        conds.push(`s.location_type = $${t}`);
      } else {
        params.push(viewLoc.locationId); const i = params.length;
        conds.push(`(s.location_type = $${t} AND s.location_id = $${i})`);
      }
    }
    return;
  }
  params.push(type); const t = params.length;
  params.push(Number(id)); const i = params.length;
  conds.push(`(s.location_type = $${t} AND s.location_id = $${i})`);
}

function applyBankEntryLocationScope(
  req: any,
  params: any[],
  conds: string[],
  filter: { locationType?: string; locationId?: string },
): void {
  const emp = req.employee as { branchType?: string; branchId?: number } | undefined;
  if (emp && emp.branchType && emp.branchType !== "headoffice" && emp.branchId != null) {
    params.push(emp.branchType); const t = params.length;
    params.push(emp.branchId); const i = params.length;
    conds.push(`(bre.location_type = $${t} AND bre.location_id = $${i})`);
    return;
  }
  const type = filter.locationType;
  const id = filter.locationId;
  if (type && id) {
    params.push(type); const t = params.length;
    params.push(Number(id)); const i = params.length;
    conds.push(`(bre.location_type = $${t} AND bre.location_id = $${i})`);
    return;
  }
  const viewLoc = getLocationFilter(req);
  if (viewLoc) {
    params.push(viewLoc.locationType); const t = params.length;
    if (viewLoc.locationType === "headoffice") {
      conds.push(`bre.location_type = $${t}`);
    } else {
      params.push(viewLoc.locationId); const i = params.length;
      conds.push(`(bre.location_type = $${t} AND bre.location_id = $${i})`);
    }
  }
}

function matchesViewLocation(
  row: { location_type?: string | null; location_id?: number | null },
  location: { locationType: string; locationId: number } | null,
): boolean {
  if (!location) return true;
  if (location.locationType === "headoffice") return row.location_type === "headoffice";
  return row.location_type === location.locationType
    && Number(row.location_id) === Number(location.locationId);
}

// ── GET /accounts/reconciliation/audit ───────────────────────────────────────
// Read-only, source-level accounting checks. This is intentionally separate
// from the presentation reports: it returns the failed equation and the
// underlying anomaly counts instead of plugging or hiding a value.
router.get(
  "/accounts/reconciliation/audit",
  requireModuleView("page:/accounts/reconciliation"),
  async (req, res): Promise<void> => {
    const from = typeof req.query.fromDate === "string" ? req.query.fromDate : undefined;
    const to = typeof req.query.toDate === "string" ? req.query.toDate : undefined;
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
      res.status(400).json({ error: "fromDate/toDate must be valid YYYY-MM-DD dates" });
      return;
    }

    const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    const location = emp?.branchType && emp.branchType !== "headoffice"
      ? { type: emp.branchType as "warehouse" | "outlet", id: Number(emp.branchId ?? 0) }
      : getPostingLocationFilter(req);

    const books = await buildBooks(buildDerivedPostings, {
      fromDate: from,
      toDate: to,
      location,
    });
    const trialBalance = await computeTrialBalance({
      fromDate: from,
      toDate: to,
      locFilter: location,
    });

    const valuationScope = location && location.type !== "company" && location.type !== "headoffice"
      ? { branchType: location.type, branchId: Number(location.id ?? 0) }
      : {};
    const valuation = await stockValuation(pool, valuationScope);

    const [
      { rows: staleTransfers },
      { rows: negativeStock },
      { rows: negativeBatches },
      { rows: batchMismatches },
      { rows: duplicateInvoices },
      { rows: orphanMoneyVouchers },
    ] = await Promise.all([
      // A fully received transfer must not keep an active in-transit hold.
      // Short receipts are deliberately excluded: their active shortfall is
      // the documented exception until the missing stock is found or written
      // off through a business decision.
      pool.query(`
        WITH dispatched AS (
          SELECT st.id,
                 SUM(COALESCE((line->>'quantity')::numeric, 0)) AS qty
            FROM stock_transfers st
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(st.line_items, '[]'::jsonb)) line
           GROUP BY st.id
        ), received AS (
          SELECT st.id,
                 SUM(COALESCE((line->>'quantity')::numeric, 0)) AS qty
            FROM stock_transfers st
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(st.received_line_items, '[]'::jsonb)) line
           GROUP BY st.id
        )
        SELECT sr.id AS reservation_id, sr.doc_id AS transfer_id,
               st.challan_number, st.from_type, st.from_id,
               d.qty AS dispatched_qty, COALESCE(r.qty, 0) AS received_qty,
               sr.ref_id, sr.material_type, sr.quantity::numeric AS reserved_qty
          FROM stock_reservations sr
          JOIN stock_transfers st ON st.id = sr.doc_id AND sr.doc_type = 'stock_transfer'
          JOIN dispatched d ON d.id = st.id
          LEFT JOIN received r ON r.id = st.id
         WHERE sr.status = 'active'
           AND sr.kind = 'in_transit'
           AND st.status = 'completed'
           AND COALESCE(r.qty, 0) >= d.qty - 0.001
         ORDER BY st.id, sr.id
      `),
      pool.query(`SELECT COUNT(*)::int AS count FROM stock_entries WHERE quantity::numeric < -0.001`),
      pool.query(`SELECT COUNT(*)::int AS count FROM stock_batches WHERE quantity::numeric < -0.001`),
      // Batch rows are an additive lot layer, so an absent batch total is not
      // automatically an error. A mismatch is still surfaced for review.
      pool.query(`
        WITH se AS (
          SELECT item_id, material_type, branch_type, branch_id,
                 SUM(quantity::numeric) AS qty
            FROM stock_entries
           GROUP BY item_id, material_type, branch_type, branch_id
        ), sb AS (
          SELECT item_id, material_type, branch_type, branch_id,
                 SUM(quantity::numeric) AS qty
            FROM stock_batches
           GROUP BY item_id, material_type, branch_type, branch_id
        )
        SELECT COALESCE(se.item_id, sb.item_id) AS item_id,
               COALESCE(se.material_type, sb.material_type) AS material_type,
               COALESCE(se.branch_type, sb.branch_type) AS branch_type,
               COALESCE(se.branch_id, sb.branch_id) AS branch_id,
               COALESCE(se.qty, 0)::numeric AS entry_qty,
               COALESCE(sb.qty, 0)::numeric AS batch_qty
          FROM se
          FULL OUTER JOIN sb USING (item_id, material_type, branch_type, branch_id)
         WHERE ABS(COALESCE(se.qty, 0) - COALESCE(sb.qty, 0)) > 0.001
         ORDER BY material_type, item_id, branch_type, branch_id
         LIMIT 200
      `),
      pool.query(`
        SELECT invoice_number, COUNT(*)::int AS count
          FROM sales
         WHERE cancelled_at IS NULL
           AND invoice_number IS NOT NULL
           AND invoice_number <> ''
         GROUP BY invoice_number
        HAVING COUNT(*) > 1
         ORDER BY count DESC, invoice_number
         LIMIT 200
      `),
      pool.query(`
        WITH refs AS (
          SELECT 'payment' AS source, id, voucher_number,
                 paid_from_ledger_id AS from_id, paid_to_ledger_id AS to_id
            FROM payments
          UNION ALL
          SELECT 'receipt', id, voucher_number,
                 received_in_ledger_id, received_from_ledger_id
            FROM receipts
        )
        SELECT r.source, r.id, r.voucher_number,
               r.from_id, r.to_id,
               CASE WHEN lf.id IS NULL THEN 'from' ELSE NULL END AS missing_from,
               CASE WHEN lt.id IS NULL THEN 'to' ELSE NULL END AS missing_to
          FROM refs r
          LEFT JOIN account_ledgers lf ON lf.id = r.from_id
          LEFT JOIN account_ledgers lt ON lt.id = r.to_id
         WHERE lf.id IS NULL OR lt.id IS NULL
         ORDER BY r.source, r.id
         LIMIT 200
      `),
    ]);

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const check = (name: string, passed: boolean, detail: string, extra: Record<string, unknown> = {}) => ({
      name, status: passed ? "pass" : "fail", detail, ...extra,
    });
    const checks = [
      check(
        "P&L / Balance Sheet integrity",
        books.integrity.balanced,
        books.integrity.balanced ? "No books integrity defects." : books.integrity.issues.join(" "),
        { difference: books.integrity.difference, issues: books.integrity.issues },
      ),
      check(
        "Trial Balance",
        trialBalance.balanced === true,
        `Debits ₹${Number(trialBalance.totalDebit).toFixed(2)}; credits ₹${Number(trialBalance.totalCredit).toFixed(2)}; difference ₹${Number(trialBalance.difference).toFixed(2)}.`,
        { difference: trialBalance.difference },
      ),
      check(
        "Balance Sheet",
        Math.abs(Number(books.balanceSheet.liabilities.difference)) <= 0.01,
        `Assets ₹${books.balanceSheet.assets.total.toFixed(2)}; liabilities and equity ₹${books.balanceSheet.liabilities.total.toFixed(2)}; difference ₹${books.balanceSheet.liabilities.difference.toFixed(2)}.`,
        { difference: books.balanceSheet.liabilities.difference },
      ),
      check(
        "P&L closing stock = Balance Sheet inventory",
        Math.abs(books.profitAndLoss.incomes.closingStock - books.balanceSheet.assets.closingStock) <= 0.01,
        `P&L ₹${books.profitAndLoss.incomes.closingStock.toFixed(2)}; Balance Sheet ₹${books.balanceSheet.assets.closingStock.toFixed(2)}.`,
      ),
      check(
        "Inventory valuation = current closing stock",
        Boolean(to && to < new Date().toISOString().slice(0, 10))
          || Math.abs(valuation.grandTotal - books.profitAndLoss.incomes.closingStock) <= 0.01,
        to && to < new Date().toISOString().slice(0, 10)
          ? "Historical closing requires dated stock evidence; current valuation is not substituted for it."
          : `Valuation ₹${valuation.grandTotal.toFixed(2)}; closing stock ₹${books.profitAndLoss.incomes.closingStock.toFixed(2)}.`,
        { historical: Boolean(to && to < new Date().toISOString().slice(0, 10)) },
      ),
      check(
        "Completed transfers have no stale full-receipt reservation",
        staleTransfers.length === 0,
        staleTransfers.length === 0 ? "No stale full-receipt reservations found." : `${staleTransfers.length} reservation(s) remain active after a completed full receipt.`,
        { anomalies: staleTransfers.slice(0, 50) },
      ),
      check(
        "No negative on-hand stock",
        Number(negativeStock[0]?.count ?? 0) === 0,
        `${Number(negativeStock[0]?.count ?? 0)} negative stock_entries row(s).`,
      ),
      check(
        "No negative batch quantities",
        Number(negativeBatches[0]?.count ?? 0) === 0,
        `${Number(negativeBatches[0]?.count ?? 0)} negative stock_batches row(s).`,
      ),
      {
        name: "Batch layer reconciles to stock entries",
        status: batchMismatches.length === 0 ? "pass" : "warning",
        detail: batchMismatches.length === 0
          ? "All batch totals equal stock_entries totals."
          : `${batchMismatches.length} product/location total(s) differ; untracked residual stock is allowed but must be reviewed.`,
        anomalies: batchMismatches,
      },
      check(
        "No duplicate active sales invoice numbers",
        duplicateInvoices.length === 0,
        duplicateInvoices.length === 0 ? "No duplicate active invoice numbers." : `${duplicateInvoices.length} duplicate invoice number group(s).`,
        { anomalies: duplicateInvoices },
      ),
      check(
        "No orphaned money-voucher ledger references",
        orphanMoneyVouchers.length === 0,
        orphanMoneyVouchers.length === 0 ? "Every payment and receipt points to existing ledger rows." : `${orphanMoneyVouchers.length} payment/receipt row(s) reference a missing ledger.`,
        { anomalies: orphanMoneyVouchers },
      ),
    ];

    const failed = checks.filter((c) => c.status === "fail").length;
    const warnings = checks.filter((c) => c.status === "warning").length;
    res.json({
      period: { fromDate: from ?? null, toDate: to ?? null },
      location: location ? { type: location.type, id: location.id } : null,
      equations: {
        netSales: {
          sales: books.profitAndLoss.incomes.grossSales,
          returns: books.profitAndLoss.incomes.salesReturns,
          net: books.profitAndLoss.summary.revenue,
        },
        goodsAvailable: r2(
          books.profitAndLoss.expenses.openingStock
          + books.profitAndLoss.expenses.purchases
          + books.profitAndLoss.expenses.directExpenses.total,
        ),
        cogs: books.profitAndLoss.summary.costOfGoodsSold,
        grossProfit: books.profitAndLoss.summary.grossProfit,
        netProfit: books.profitAndLoss.netProfit,
      },
      valuation: {
        onHandValue: valuation.onHandValue,
        inTransitValue: valuation.inTransitValue,
        grandTotal: valuation.grandTotal,
      },
      checks,
      summary: {
        status: failed > 0 ? "fail" : warnings > 0 ? "warning" : "pass",
        failed,
        warnings,
        passed: checks.length - failed - warnings,
      },
    });
  },
);

// ── GET /accounts/reconciliation/customer-receivables ────────────────────────
// Customer-wise source-to-ledger reconciliation. This is deliberately
// read-only and does not try to make invoice arithmetic equal the books:
// opening balances, advances, overpayments and manual vouchers are real
// accounting inputs and are surfaced in the adjustment column.
router.get(
  "/accounts/reconciliation/customer-receivables",
  requireModuleView("page:/accounts/reconciliation"),
  async (req, res): Promise<void> => {
    const from = typeof req.query.fromDate === "string" ? req.query.fromDate : undefined;
    const to = typeof req.query.toDate === "string" ? req.query.toDate : undefined;
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
      res.status(400).json({ error: "fromDate/toDate must be valid YYYY-MM-DD dates" });
      return;
    }

    const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    const postingLocation = emp?.branchType && emp.branchType !== "headoffice"
      ? { type: emp.branchType as "warehouse" | "outlet", id: Number(emp.branchId ?? 0) }
      : getPostingLocationFilter(req);

    const { getUserDataScope, scopeLocationTypeWhere } = await import("../lib/dataScope");
    const { pushLocationFilter } = await import("../lib/queryFilters");
    const scope = await getUserDataScope(
      emp as { branchType: string; branchId: number },
    );
    const customerParams: any[] = [];
    const customerConds: string[] = [scopeLocationTypeWhere(scope, customerParams, "c")];
    pushLocationFilter(
      customerConds,
      customerParams,
      getLocationFilter(req),
      "COALESCE(c.location_type, 'headoffice')",
      "c.location_id",
    );

    const [{ rows: customers }, { rows: ledgers }, { rows: returnVouchers }, { rows: salesCharges }] =
      await Promise.all([
        pool.query<any>(
          `SELECT c.id, c.name
             FROM customers c
            WHERE ${customerConds.join(" AND ")}
            ORDER BY c.id`,
          customerParams,
        ),
        pool.query<any>(
          `SELECT id, code
             FROM account_ledgers
            WHERE code ~ '^CUST-[0-9]+$'`,
        ),
        pool.query<any>(
          `SELECT credit_note_id
             FROM sales_returns
            WHERE credit_note_id IS NOT NULL`,
        ),
        (() => {
          const p: any[] = [];
          const c: string[] = [
            "s.customer_id IS NOT NULL",
            "s.cancelled_at IS NULL",
            "s.branch_transfer_id IS NULL",
          ];
          if (from) { p.push(from); c.push(`s.sale_date >= $${p.length}`); }
          if (to) { p.push(to); c.push(`s.sale_date <= $${p.length}`); }
          if (postingLocation && postingLocation.type !== "company") {
            p.push(postingLocation.type);
            if (postingLocation.type === "headoffice") {
              c.push(`s.location_type = $${p.length}`);
            } else {
              p.push(Number(postingLocation.id));
              c.push(`s.location_type = $${p.length - 1} AND s.location_id = $${p.length}`);
            }
          }
          return pool.query<any>(
            `SELECT s.customer_id,
                    COALESCE(SUM(
                      CASE WHEN jsonb_typeof(COALESCE(s.other_charges, '[]'::jsonb)) = 'array'
                        THEN COALESCE((
                          SELECT SUM(NULLIF(charge->>'amount', '')::numeric)
                            FROM jsonb_array_elements(COALESCE(s.other_charges, '[]'::jsonb)) AS charge
                        ), 0)
                        ELSE 0
                      END
                    ), 0) AS other_charges
               FROM sales s
              WHERE ${c.join(" AND ")}
              GROUP BY s.customer_id`,
            p,
          );
        })(),
      ]);

    const customerById = new Map<number, { id: number; name: string }>(
      customers.map((c: any) => [Number(c.id), { id: Number(c.id), name: String(c.name ?? "") }]),
    );
    const ledgerToCustomer = new Map<number, number>();
    const customerLedgerIds: number[] = [];
    for (const row of ledgers) {
      const match = /^CUST-(\d+)$/.exec(String(row.code ?? ""));
      if (!match) continue;
      const ledgerId = Number(row.id);
      const customerId = Number(match[1]);
      ledgerToCustomer.set(ledgerId, customerId);
      if (customerById.has(customerId)) customerLedgerIds.push(ledgerId);
    }

    const openingByLedger = new Map<number, number>();
    if (customerLedgerIds.length > 0) {
      const openingParams: any[] = [customerLedgerIds];
      if (to) openingParams.push(to);
      const { rows: openings } = await pool.query<any>(
        `SELECT ledger_id,
                COALESCE(SUM(
                  CASE WHEN LOWER(COALESCE(balance_type, 'debit')) = 'debit'
                       THEN balance::numeric ELSE -balance::numeric END
                ), 0) AS amount
           FROM opening_balances
          WHERE ledger_id = ANY($1::int[])${to ? " AND as_of_date <= $2" : ""}
          GROUP BY ledger_id`,
        openingParams,
      );
      for (const row of openings) openingByLedger.set(Number(row.ledger_id), Number(row.amount));
    }

    const allPostings = await buildDerivedPostings(to ? { toDate: to } : {});
    const located = postingLocation
      ? allPostings.filter((p) => postingMatchesLocation(p, postingLocation))
      : allPostings;
    const before = from
      ? located.filter((p) => String(p.date).slice(0, 10) < from)
      : [];
    const period = located.filter((p) => !from || String(p.date).slice(0, 10) >= from);
    const salesReturnVoucherIds = new Set<number>(
      returnVouchers
        .map((r: any) => Number(r.credit_note_id))
        .filter((id: number) => Number.isInteger(id) && id > 0),
    );
    const chargesByCustomer = new Map<number, number>(
      salesCharges.map((r: any) => [Number(r.customer_id), Number(r.other_charges) || 0]),
    );

    type Totals = {
      openingBalance: number;
      sales: number;
      salesReturns: number;
      receipts: number;
      otherCharges: number;
      creditNotes: number;
      debitNotes: number;
      adjustments: number;
      expectedClosing: number;
      ledgerClosing: number;
      displayedOutstanding: number;
      difference: number;
    };
    const zeroTotals = (): Totals => ({
      openingBalance: 0, sales: 0, salesReturns: 0, receipts: 0,
      otherCharges: 0, creditNotes: 0, debitNotes: 0, adjustments: 0,
      expectedClosing: 0, ledgerClosing: 0, displayedOutstanding: 0, difference: 0,
    });
    const byCustomer = new Map<number, Totals>();
    for (const customerId of customerById.keys()) byCustomer.set(customerId, zeroTotals());
    const forLedger = (ledgerId: number): Totals | null => {
      const customerId = ledgerToCustomer.get(Number(ledgerId));
      return customerId == null ? null : byCustomer.get(customerId) ?? null;
    };
    const net = (p: { debit: number; credit: number }) => Number(p.debit || 0) - Number(p.credit || 0);

    for (const ledgerId of customerLedgerIds) {
      const totals = byCustomer.get(ledgerToCustomer.get(ledgerId)!);
      if (totals) {
        totals.openingBalance += openingByLedger.get(ledgerId) ?? 0;
        totals.ledgerClosing += openingByLedger.get(ledgerId) ?? 0;
      }
    }
    for (const p of before) {
      const totals = forLedger(Number(p.ledgerId));
      if (totals) {
        totals.openingBalance += net(p);
        totals.ledgerClosing += net(p);
      }
    }
    for (const p of period) {
      const totals = forLedger(Number(p.ledgerId));
      if (!totals) continue;
      const debit = Number(p.debit) || 0;
      const credit = Number(p.credit) || 0;
      totals.ledgerClosing += debit - credit;
      const source = String(p.source ?? "");
      const description = String(p.description ?? "");
      const voucherId = source === "credit_note"
        ? Number(String(p.entryId ?? "").replace(/^jv:/, ""))
        : 0;

      if (source === "sale" && debit > 0 && description.startsWith("Invoice ")) totals.sales += debit;
      else if (source === "sale" && credit > 0 && description.includes("Payment received")) totals.receipts += credit;
      else if (source === "receipt" && credit > 0) totals.receipts += credit;
      else if (source === "credit_note" && credit > 0 && salesReturnVoucherIds.has(voucherId)) totals.salesReturns += credit;
      else if (source === "credit_note" && credit > 0) totals.creditNotes += credit;
      else if (source === "debit_note" && debit > 0) totals.debitNotes += debit;
      else totals.adjustments += debit - credit;
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const rows = [...customerById.values()].map((customer) => {
      const t = byCustomer.get(customer.id) ?? zeroTotals();
      t.openingBalance = round2(t.openingBalance);
      t.sales = round2(t.sales);
      t.salesReturns = round2(t.salesReturns);
      t.receipts = round2(t.receipts);
      t.otherCharges = round2(chargesByCustomer.get(customer.id) ?? 0);
      t.creditNotes = round2(t.creditNotes);
      t.debitNotes = round2(t.debitNotes);
      t.adjustments = round2(t.adjustments);
      t.expectedClosing = round2(
        t.openingBalance + t.sales + t.debitNotes + t.adjustments
        - t.salesReturns - t.receipts - t.creditNotes,
      );
      t.ledgerClosing = round2(t.ledgerClosing);
      t.displayedOutstanding = t.ledgerClosing;
      t.difference = round2(t.expectedClosing - t.ledgerClosing);
      return { ...customer, ...t };
    });
    const totals = rows.reduce((acc, row) => {
      for (const key of Object.keys(acc) as Array<keyof Totals>) {
        acc[key] = round2(acc[key] + Number(row[key] ?? 0)) as never;
      }
      return acc;
    }, zeroTotals());

    res.json({
      period: { fromDate: from ?? null, toDate: to ?? null },
      location: postingLocation,
      definitions: {
        openingBalance: "Opening balance plus pre-period postings for the selected location.",
        displayedOutstanding: "Authoritative customer ledger closing balance; never invoice arithmetic.",
        otherCharges: "Source-document charges already included in sales invoice totals; informational only.",
        difference: "Expected closing minus ledger closing. A non-zero value is a reconciliation defect.",
      },
      customers: rows,
      totals,
    });
  },
);

// ── GET /reconciliation/bank-ledgers ─────────────────────────────────────────
// Returns all active ledgers under STD-BANK hierarchy (for destination dropdown)
// Serves Reconciliation, Cash Balance (accounts + sales) pages.
router.get("/reconciliation/bank-ledgers", requireModuleView(["page:/accounts/reconciliation", "page:/accounts/cash-in-outlet"]), async (req, res): Promise<void> => {
  const access = await bookAccessScope(((req as any).employee ?? {}));
  const viewLocation = getLocationFilter(req);
  const { rows } = await pool.query(`
    SELECT cba.id AS account_id, cba.ledger_id, cba.name, cba.account_type,
           cba.requires_reconciliation, COALESCE(cba.location_type, 'headoffice') AS location_type,
           COALESCE(cba.location_id, 0) AS location_id,
           al.code, al.bank_details,
           COALESCE(w.name, o.name, 'Head Office') AS location_name
      FROM cash_bank_accounts cba
      JOIN account_ledgers al ON al.id = cba.ledger_id
      LEFT JOIN warehouses w ON cba.location_type = 'warehouse' AND w.id = cba.location_id
      LEFT JOIN outlets o ON cba.location_type = 'outlet' AND o.id = cba.location_id
     WHERE cba.ledger_id IS NOT NULL
       AND cba.account_type <> 'cash'
       AND COALESCE(al.is_active, true)
     ORDER BY cba.location_type, location_name, cba.name, cba.id
  `);

  res.json(rows
    .filter((r: any) => {
      if (access.ledgerIds && !access.ledgerIds.has(Number(r.ledger_id))) return false;
      if (!viewLocation) return true;
      if (viewLocation.locationType === "headoffice") return r.location_type === "headoffice";
      return r.location_type === viewLocation.locationType
        && Number(r.location_id) === Number(viewLocation.locationId);
    })
    .map((r: any) => ({
      // `id` remains the ledger id for legacy batch consumers. The new
      // reconciliation surface uses accountId for the Cash & Bank identity.
      id: Number(r.ledger_id),
      accountId: Number(r.account_id),
      ledgerId: Number(r.ledger_id),
      name: r.name,
      code: r.code ?? null,
      accountType: r.account_type,
      requiresReconciliation: r.requires_reconciliation === true,
      bankDetails: r.bank_details ?? null,
      locationType: r.location_type ?? "headoffice",
      locationId: r.location_id == null ? 0 : Number(r.location_id),
      locationName: r.location_name ?? "Head Office",
    })));
});

// ── GET /reconciliation/bank-transactions ──────────────────────────────────────
// Account-based reconciliation view. It is deliberately built from the same
// derived posting stream as Bank Book, then grouped by the exact
// (ledger_id, entry_id) identity. In particular, an allocation receipt that
// settles several invoices remains one receipt transaction.
router.get("/reconciliation/bank-transactions", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const {
    locationType, locationId, bankAccountId, fromDate, toDate, search,
  } = req.query as Record<string, string | undefined>;
  if ((fromDate && !isIsoDate(fromDate)) || (toDate && !isIsoDate(toDate))) {
    res.status(400).json({ error: "fromDate/toDate must be valid YYYY-MM-DD dates" });
    return;
  }
  if (fromDate && toDate && fromDate > toDate) {
    res.status(400).json({ error: "fromDate cannot be later than toDate" });
    return;
  }
  if ((locationType && !locationId) || (!locationType && locationId)) {
    res.status(400).json({ error: "locationType and locationId must be provided together" });
    return;
  }
  const accountFilter = bankAccountId == null || bankAccountId === "" ? null : Number(bankAccountId);
  if (accountFilter != null && (!Number.isInteger(accountFilter) || accountFilter <= 0)) {
    res.status(400).json({ error: "bankAccountId must be a valid Cash & Bank account id" });
    return;
  }

  const access = await bookAccessScope((req as any).employee ?? {});
  // The page may deliberately request a location different from the global
  // sidebar context.  Prefer the explicit query filter; falling back to the
  // header keeps older callers working.
  const explicitLocation = locationType && locationId
    ? { locationType, locationId: Number(locationId) }
    : null;
  const viewLocation = explicitLocation ?? getLocationFilter(req);
  const postingLocation = explicitLocation
    ? {
        type: explicitLocation.locationType as "warehouse" | "outlet" | "headoffice",
        id: explicitLocation.locationId,
      }
    : getPostingLocationFilter(req);
  const { rows: accountRows } = await pool.query(`
    SELECT cba.id AS account_id, cba.ledger_id, cba.name, cba.account_type,
           cba.requires_reconciliation, COALESCE(cba.location_type, 'headoffice') AS location_type,
           COALESCE(cba.location_id, 0) AS location_id,
           COALESCE(w.name, o.name, 'Head Office') AS location_name
      FROM cash_bank_accounts cba
      JOIN account_ledgers al ON al.id = cba.ledger_id
      LEFT JOIN warehouses w ON cba.location_type = 'warehouse' AND w.id = cba.location_id
      LEFT JOIN outlets o ON cba.location_type = 'outlet' AND o.id = cba.location_id
     WHERE cba.ledger_id IS NOT NULL
       AND cba.account_type <> 'cash'
       AND COALESCE(al.is_active, true)
  `);
  const accountLocationMatches = (r: any) => {
    if (!viewLocation) return true;
    if (viewLocation.locationType === "headoffice") return r.location_type === "headoffice";
    return r.location_type === viewLocation.locationType
      && Number(r.location_id) === Number(viewLocation.locationId);
  };
  const accounts = accountRows.filter((r: any) =>
    (!access.ledgerIds || access.ledgerIds.has(Number(r.ledger_id)))
    && accountLocationMatches(r)
    && (accountFilter == null || Number(r.account_id) === accountFilter),
  );
  if (accountFilter != null && !accounts.some((r: any) => Number(r.account_id) === accountFilter)) {
    // Do not disclose whether another location owns the account.
    res.json([]);
    return;
  }
  if (accounts.length === 0) {
    // Keep going for Head Office so historical, unassigned bank-ledger rows
    // can be shown as undetermined instead of being silently discarded.
    if (!access.dataScope.isHeadOffice) {
      res.json([]);
      return;
    }
  }

  const accountByLedger = new Map<number, any>(
    accounts.map((r: any) => [Number(r.ledger_id), r]),
  );
  const { rows: bankTreeRows } = await pool.query(`
    WITH RECURSIVE bank_tree AS (
      SELECT id, parent_id FROM account_ledgers WHERE code = 'STD-BANK'
      UNION ALL
      SELECT l.id, l.parent_id
        FROM account_ledgers l
        JOIN bank_tree b ON b.id = l.parent_id
    )
    SELECT id FROM bank_tree
  `);
  const bankLedgerIds = new Set<number>(bankTreeRows.map((r: any) => Number(r.id)));
  const postings = await buildDerivedPostings({ toDate });
  const visible = postings.filter((p: any) => {
    const account = accountByLedger.get(Number(p.ledgerId));
    const undetermined = !account && bankLedgerIds.has(Number(p.ledgerId));
    if (!account && !undetermined) return false;
    if (accountFilter != null && undetermined) return false;
    if (postingLocation && !postingMatchesLocation(p, postingLocation)) return false;
    if (access.ledgerIds
      && !access.ledgerIds.has(Number(p.ledgerId))
      && !isLocationInScope(access.dataScope, p.locationType, p.locationId)) return false;
    // buildDerivedPostings normalises business dates to YYYY-MM-DD. Keep the
    // slice here as a defensive boundary for older/custom posting producers.
    const postingDate = String(p.date ?? "").slice(0, 10);
    if (fromDate && postingDate < fromDate) return false;
    if (toDate && postingDate > toDate) return false;
    if (search) {
      const needle = search.toLowerCase();
       return [p.entryId, p.voucherNumber, p.description, account?.name ?? "Undetermined bank account"]
        .some((v) => String(v ?? "").toLowerCase().includes(needle));
    }
    return true;
  });

  type Txn = {
    entryId: string; ledgerId: number; date: string; source: string;
    voucherNumber: string | null; description: string; debit: number; credit: number;
    locationType: string | null; locationId: number | null;
  };
  const grouped = new Map<string, Txn>();
  for (const p of visible) {
    const ledgerId = Number(p.ledgerId);
    const key = `${ledgerId}:${p.entryId}`;
    const current = grouped.get(key);
    if (current) {
      current.debit = Math.round((current.debit + Number(p.debit ?? 0)) * 100) / 100;
      current.credit = Math.round((current.credit + Number(p.credit ?? 0)) * 100) / 100;
    } else {
      grouped.set(key, {
        entryId: String(p.entryId),
        ledgerId,
        date: String(p.date).slice(0, 10),
        source: String(p.source),
        voucherNumber: p.voucherNumber ?? null,
        description: String(p.description ?? ""),
        debit: Number(p.debit ?? 0),
        credit: Number(p.credit ?? 0),
        locationType: p.locationType ?? null,
        locationId: p.locationId == null ? null : Number(p.locationId),
      });
    }
  }

  const txns = [...grouped.values()];
  const ledgerIds = [...new Set(txns.map((t) => t.ledgerId))];
  const entryIds = [...new Set(txns.map((t) => t.entryId))];
  const reconciliationByKey = new Map<string, any>();
  if (ledgerIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT ledger_id, entry_id, status, reconciled_at, reconciled_by,
              unreconciled_at, unreconciled_by, reconciliation_reference
         FROM bank_reconciliation_entries
        WHERE ledger_id = ANY($1::int[]) AND entry_id = ANY($2::text[])`,
      [ledgerIds, entryIds],
    );
    for (const row of rows) reconciliationByKey.set(`${Number(row.ledger_id)}:${row.entry_id}`, row);
  }

  const { rows: parties } = await pool.query(`
    SELECT 'sale:' || s.id::text AS entry_id, c.name AS party_name
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    UNION ALL
    SELECT 'purchase:' || p.id::text AS entry_id, v.name AS party_name
      FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id
    UNION ALL
    SELECT 'sale_payment:' || sp.id::text AS entry_id, c.name AS party_name
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      LEFT JOIN customers c ON c.id = s.customer_id
    UNION ALL
    SELECT 'receipt:' || r.id::text AS entry_id,
           COALESCE(c.name, v.name, al.name) AS party_name
      FROM receipts r
      JOIN account_ledgers al ON al.id = r.received_from_ledger_id
      LEFT JOIN customers c ON al.code = 'CUST-' || c.id::text
      LEFT JOIN vendors v ON al.code = 'VEND-' || v.id::text
    UNION ALL
    SELECT 'payment:' || p.id::text AS entry_id,
           COALESCE(v.name, c.name, al.name) AS party_name
      FROM payments p
      JOIN account_ledgers al ON al.id = p.paid_to_ledger_id
      LEFT JOIN vendors v ON al.code = 'VEND-' || v.id::text
      LEFT JOIN customers c ON al.code = 'CUST-' || c.id::text
    UNION ALL
    SELECT 'jv:' || jv.id::text AS entry_id,
           COALESCE(c.name, v.name, al.name) AS party_name
      FROM journal_vouchers jv
      LEFT JOIN account_ledgers al ON al.id = jv.party_ledger_id
      LEFT JOIN customers c ON al.code = 'CUST-' || c.id::text
      LEFT JOIN vendors v ON al.code = 'VEND-' || v.id::text
  `);
  const partyByEntry = new Map<string, string | null>(
    parties.map((p: any) => [String(p.entry_id), p.party_name ?? null]),
  );

  const ordered = txns
    .sort((a, b) => b.date.localeCompare(a.date) || b.entryId.localeCompare(a.entryId));
  const mapped = ordered.map((t) => {
      const account = accountByLedger.get(t.ledgerId);
      const saved = reconciliationByKey.get(`${t.ledgerId}:${t.entryId}`);
      const net = Math.round((t.debit - t.credit) * 100) / 100;
      return {
        id: `${t.ledgerId}:${t.entryId}`,
        entryId: t.entryId,
        ledgerId: t.ledgerId,
        accountId: account ? Number(account.account_id) : null,
        accountName: account?.name ?? "Undetermined bank account",
        accountType: account?.account_type ?? "bank",
        accountLocationType: account?.location_type ?? null,
        accountLocationId: account?.location_id == null ? null : Number(account.location_id),
        accountLocationName: account?.location_name ?? "Undetermined",
        date: t.date,
        source: t.source,
        voucherNumber: t.voucherNumber,
        description: t.description,
        counterpartyName: partyByEntry.get(t.entryId) ?? null,
        debit: Math.round(t.debit * 100) / 100,
        credit: Math.round(t.credit * 100) / 100,
        amount: Math.abs(net),
        direction: net >= 0 ? "in" : "out",
        locationType: t.locationType,
        locationId: t.locationId,
        reconciliationEligible: !!account,
        reconciliationStatus: saved?.status ?? "unreconciled",
        reconciledAt: saved?.reconciled_at ?? null,
        reconciledBy: saved?.reconciled_by ?? null,
        reconciliationReference: saved?.reconciliation_reference ?? null,
      };
    });
  const eligible = mapped.filter((t) => t.reconciliationEligible);
  const totals = {
    eligibleCount: eligible.length,
    eligibleAmount: Math.round(eligible.reduce((sum, t) => sum + Number(t.amount || 0), 0) * 100) / 100,
    reconciledCount: eligible.filter((t) => t.reconciliationStatus === "reconciled").length,
    reconciledAmount: Math.round(eligible
      .filter((t) => t.reconciliationStatus === "reconciled")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0) * 100) / 100,
    unreconciledCount: eligible.filter((t) => t.reconciliationStatus !== "reconciled").length,
    unreconciledAmount: Math.round(eligible
      .filter((t) => t.reconciliationStatus !== "reconciled")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0) * 100) / 100,
  };
  res.json({ transactions: mapped, totals });
});

// ── GET /reconciliation/bank-audit ───────────────────────────────────────────
// Compares the authoritative derived bank posting stream with Cash & Bank
// assignments. Missing assignments are reported rather than guessed.
router.get("/reconciliation/bank-audit", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const access = await bookAccessScope((req as any).employee ?? {});
  const viewLocation = getLocationFilter(req);
  const { rows: accounts } = await pool.query(`
    SELECT cba.id AS account_id, cba.ledger_id, cba.name,
           COALESCE(cba.location_type, 'headoffice') AS location_type,
           COALESCE(cba.location_id, 0) AS location_id,
           COALESCE(w.name, o.name, 'Head Office') AS location_name
      FROM cash_bank_accounts cba
      JOIN account_ledgers al ON al.id = cba.ledger_id
      LEFT JOIN warehouses w ON cba.location_type = 'warehouse' AND w.id = cba.location_id
      LEFT JOIN outlets o ON cba.location_type = 'outlet' AND o.id = cba.location_id
     WHERE cba.account_type <> 'cash' AND COALESCE(al.is_active, true)
  `);
  const allowed = accounts.filter((a: any) =>
    (!access.ledgerIds || access.ledgerIds.has(Number(a.ledger_id))) &&
    (!viewLocation ||
      (viewLocation.locationType === "headoffice"
        ? a.location_type === "headoffice"
        : a.location_type === viewLocation.locationType
          && Number(a.location_id) === Number(viewLocation.locationId))),
  );
  const accountByLedger = new Map<number, any>(allowed.map((a: any) => [Number(a.ledger_id), a]));
  const postings = await buildDerivedPostings({});
  const postingLocation = getPostingLocationFilter(req);
  const identity = new Map<string, any>();
  const duplicateKeys = new Set<string>();
  const seenPostingSignatures = new Set<string>();
  const undetermined: any[] = [];
  const sourceCounts = new Map<string, { count: number; amount: number }>();
  for (const p of postings as any[]) {
    const ledgerId = Number(p.ledgerId);
    if (access.ledgerIds && !access.ledgerIds.has(ledgerId)
      && !isLocationInScope(access.dataScope, p.locationType, p.locationId)) continue;
    if (postingLocation && !postingMatchesLocation(p, postingLocation)) continue;
    const key = `${ledgerId}:${p.entryId}`;
    const signature = [
      key, p.source, String(p.date).slice(0, 10), Number(p.debit ?? 0),
      Number(p.credit ?? 0), p.voucherNumber ?? "",
    ].join("|");
    if (seenPostingSignatures.has(signature)) duplicateKeys.add(key);
    seenPostingSignatures.add(signature);
    const current = identity.get(key);
    if (current) {
      current.debit += Number(p.debit ?? 0);
      current.credit += Number(p.credit ?? 0);
      current.legs += 1;
      continue;
    }
    identity.set(key, {
      ledgerId,
      entryId: String(p.entryId),
      date: String(p.date).slice(0, 10),
      source: String(p.source),
      debit: Number(p.debit ?? 0),
      credit: Number(p.credit ?? 0),
      legs: 1,
    });
    if (!accountByLedger.has(ledgerId) && String(p.source) !== "opening_balance") {
      undetermined.push({
        ledgerId,
        entryId: String(p.entryId),
        date: String(p.date).slice(0, 10),
        source: String(p.source),
        reason: "missing_bank_account_assignment",
      });
    }
  }
  const { rows: saved } = await pool.query(
    `SELECT ledger_id, entry_id, status
       FROM bank_reconciliation_entries
      WHERE status = 'reconciled'`,
  );
  const savedByKey = new Set(saved.map((r: any) => `${Number(r.ledger_id)}:${r.entry_id}`));
  const byAccount = new Map<number, any>();
  for (const account of allowed) {
    byAccount.set(Number(account.account_id), {
      accountId: Number(account.account_id),
      ledgerId: Number(account.ledger_id),
      accountName: account.name,
      locationName: account.location_name,
      eligibleCount: 0,
      eligibleAmount: 0,
      reconciledCount: 0,
      reconciledAmount: 0,
      unreconciledCount: 0,
      unreconciledAmount: 0,
      duplicateCount: 0,
      duplicateAmount: 0,
    });
  }
  for (const row of identity.values()) {
    const account = accountByLedger.get(row.ledgerId);
    if (!account) continue;
    const item = byAccount.get(Number(account.account_id))!;
    const amount = Math.abs(Number(row.debit) - Number(row.credit));
    const key = `${row.ledgerId}:${row.entryId}`;
    item.eligibleCount += 1;
    item.eligibleAmount += amount;
    const sourceKey = (() => {
      if (row.source === "sale") return "SALE";
      if (row.source === "receipt") return "RECEIPT";
      if (row.source === "payment") return "PAYMENT";
      if (row.source === "expense" || row.source === "deposit") return "OTHER BANK TRANSACTION";
      return "OTHER BANK TRANSACTION";
    })();
    const sourceTotal = sourceCounts.get(sourceKey) ?? { count: 0, amount: 0 };
    sourceTotal.count += 1;
    sourceTotal.amount += amount;
    sourceCounts.set(sourceKey, sourceTotal);
    if (duplicateKeys.has(key)) {
      item.duplicateCount += 1;
      item.duplicateAmount += amount;
    }
    if (savedByKey.has(key)) {
      item.reconciledCount += 1;
      item.reconciledAmount += amount;
    } else {
      item.unreconciledCount += 1;
      item.unreconciledAmount += amount;
    }
    byAccount.set(Number(account.account_id), item);
  }
  for (const row of byAccount.values()) {
    for (const key of ["eligibleAmount", "reconciledAmount", "unreconciledAmount", "duplicateAmount"]) {
      row[key] = Math.round(Number(row[key]) * 100) / 100;
    }
  }
  res.json({
    accounts: [...byAccount.values()],
    totals: {
      eligibleCount: [...byAccount.values()].reduce((n, row) => n + Number(row.eligibleCount), 0),
      eligibleAmount: Math.round([...byAccount.values()].reduce((n, row) => n + Number(row.eligibleAmount), 0) * 100) / 100,
      reconciledCount: [...byAccount.values()].reduce((n, row) => n + Number(row.reconciledCount), 0),
      reconciledAmount: Math.round([...byAccount.values()].reduce((n, row) => n + Number(row.reconciledAmount), 0) * 100) / 100,
      unreconciledCount: [...byAccount.values()].reduce((n, row) => n + Number(row.unreconciledCount), 0),
      unreconciledAmount: Math.round([...byAccount.values()].reduce((n, row) => n + Number(row.unreconciledAmount), 0) * 100) / 100,
      duplicateCount: [...byAccount.values()].reduce((n, row) => n + Number(row.duplicateCount), 0),
      duplicateAmount: Math.round([...byAccount.values()].reduce((n, row) => n + Number(row.duplicateAmount), 0) * 100) / 100,
    },
    sourceCounts: Object.fromEntries([...sourceCounts.entries()].map(([source, value]) => [
      source, { count: value.count, amount: Math.round(value.amount * 100) / 100 },
    ])),
    undetermined,
    legacySettlementBatchesPreserved: true,
    notes: [
      "Eligible totals are derived from the bank ledger posting stream.",
      "Cash accounts and opening balances are excluded.",
      "Legacy electronic settlement batches are not part of this resettable state.",
    ],
  });
});

// ── GET /reconciliation/bank-batches ─────────────────────────────────────────
router.get("/reconciliation/bank-batches", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const access = await bookAccessScope((req as any).employee ?? {});
  const viewLocation = getLocationFilter(req);
  const { rows } = await pool.query(`
    SELECT b.*, cba.name AS bank_account_name,
           COALESCE(w.name, o.name, 'Head Office') AS location_name,
           COUNT(i.id)::int AS item_count
      FROM bank_reconciliation_batches b
      JOIN cash_bank_accounts cba ON cba.id = b.bank_account_id
      LEFT JOIN warehouses w ON b.location_type = 'warehouse' AND w.id = b.location_id
      LEFT JOIN outlets o ON b.location_type = 'outlet' AND o.id = b.location_id
      LEFT JOIN bank_reconciliation_batch_items i ON i.batch_id = b.id
     GROUP BY b.id, cba.name, w.name, o.name
      ORDER BY b.created_at DESC
  `);
  const visible = rows.filter((r: any) =>
    (!access.ledgerIds || access.ledgerIds.has(Number(r.bank_ledger_id)))
      && (!viewLocation
        || (viewLocation.locationType === "headoffice"
          ? r.location_type === "headoffice"
          : r.location_type === viewLocation.locationType
            && Number(r.location_id) === Number(viewLocation.locationId))),
  );
  res.json(visible.map((r: any) => ({
    id: Number(r.id),
    batchReference: r.batch_reference,
    reconciliationDate: String(r.reconciliation_date).slice(0, 10),
    bankAccountId: Number(r.bank_account_id),
    bankLedgerId: Number(r.bank_ledger_id),
    bankAccountName: r.bank_account_name,
    locationType: r.location_type,
    locationId: Number(r.location_id),
    locationName: r.location_name,
    grossAmount: Number(r.gross_amount),
    processingCharge: Number(r.processing_charge),
    netAmount: Number(r.net_amount),
    accountingImpact: r.accounting_impact,
    itemCount: Number(r.item_count),
    createdBy: r.created_by,
    createdAt: r.created_at,
    status: r.status,
  })));
});

// ── GET /reconciliation/bank-batches/:id ──────────────────────────────────────
router.get("/reconciliation/bank-batches/:id", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid reconciliation batch id." });
    return;
  }
  const access = await bookAccessScope((req as any).employee ?? {});
  const viewLocation = getLocationFilter(req);
  const { rows: [batch] } = await pool.query(
    `SELECT b.*, cba.name AS bank_account_name,
            COALESCE(w.name, o.name, 'Head Office') AS location_name
       FROM bank_reconciliation_batches b
       JOIN cash_bank_accounts cba ON cba.id = b.bank_account_id
       LEFT JOIN warehouses w ON b.location_type = 'warehouse' AND w.id = b.location_id
       LEFT JOIN outlets o ON b.location_type = 'outlet' AND o.id = b.location_id
      WHERE b.id = $1`,
    [id],
  );
  if (!batch
    || (access.ledgerIds && !access.ledgerIds.has(Number(batch.bank_ledger_id)))
    || (viewLocation && (viewLocation.locationType === "headoffice"
      ? batch.location_type !== "headoffice"
      : batch.location_type !== viewLocation.locationType
        || Number(batch.location_id) !== Number(viewLocation.locationId)))) {
    res.status(404).json({ error: "Reconciliation batch not found." });
    return;
  }
  const { rows: items } = await pool.query(
    `SELECT id, entry_id, ledger_id, source, transaction_date, debit, credit, amount
       FROM bank_reconciliation_batch_items
      WHERE batch_id = $1
      ORDER BY transaction_date, id`,
    [id],
  );
  res.json({
    id: Number(batch.id),
    batchReference: batch.batch_reference,
    reconciliationDate: String(batch.reconciliation_date).slice(0, 10),
    bankAccountId: Number(batch.bank_account_id),
    bankLedgerId: Number(batch.bank_ledger_id),
    bankAccountName: batch.bank_account_name,
    locationType: batch.location_type,
    locationId: Number(batch.location_id),
    locationName: batch.location_name,
    grossAmount: Number(batch.gross_amount),
    processingCharge: Number(batch.processing_charge),
    netAmount: Number(batch.net_amount),
    accountingImpact: batch.accounting_impact,
    itemCount: items.length,
    createdBy: batch.created_by,
    createdAt: batch.created_at,
    status: batch.status,
    items: items.map((item: any) => ({
      id: Number(item.id),
      entryId: item.entry_id,
      ledgerId: Number(item.ledger_id),
      source: item.source,
      transactionDate: String(item.transaction_date).slice(0, 10),
      debit: Number(item.debit),
      credit: Number(item.credit),
      amount: Number(item.amount),
    })),
  });
});

// ── POST /reconciliation/bank-batches ────────────────────────────────────────
// This is a metadata-only review batch. It deliberately does not create a
// receipt, payment, journal voucher, customer-ledger leg, or bank posting.
router.post("/reconciliation/bank-batches", requireModuleAction("page:/accounts/reconciliation", "add"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, any>;
  const selected = Array.isArray(body.transactions) ? body.transactions : [];
  const bankAccountId = Number(body.bankAccountId);
  const reconciliationDate = String(body.reconciliationDate ?? "");
  const chargeText = body.processingCharge == null ? "0" : String(body.processingCharge).trim();
  if (selected.length === 0 || selected.length > 500) {
    res.status(400).json({ error: "Select between 1 and 500 bank transactions." });
    return;
  }
  if (!Number.isInteger(bankAccountId) || bankAccountId <= 0) {
    res.status(400).json({ error: "bankAccountId is required." });
    return;
  }
  if (!isIsoDate(reconciliationDate)) {
    res.status(400).json({ error: "reconciliationDate must be a real YYYY-MM-DD date." });
    return;
  }
  // The reference belongs to the statement/reconciliation date, not to the
  // server's current calendar year. This matters when an old bank statement is
  // reviewed today or a future-dated statement is prepared in advance.
  const reconciliationYear = Number(reconciliationDate.slice(0, 4));
  if (!/^\d+(?:\.\d{1,2})?$/.test(chargeText)) {
    res.status(400).json({ error: "processingCharge must be a non-negative amount with at most two decimals." });
    return;
  }
  const processingCharge = Math.round(Number(chargeText) * 100) / 100;
  const identities = selected.map((item: any) => ({
    entryId: String(item?.entryId ?? "").trim(),
    ledgerId: Number(item?.ledgerId),
  }));
  if (identities.some((x: any) => !x.entryId || x.entryId.length > 200 || !Number.isInteger(x.ledgerId) || x.ledgerId <= 0)) {
    res.status(400).json({ error: "Every transaction must contain a valid entryId and ledgerId." });
    return;
  }
  const uniqueKeys = new Set(identities.map((x: any) => `${x.ledgerId}:${x.entryId}`));
  if (uniqueKeys.size !== identities.length) {
    res.status(400).json({ error: "A transaction may appear only once in a batch." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const access = await bookAccessScope((req as any).employee ?? {});
    const requestedLocation = getLocationFilter(req);
    const requestedPostingLocation = getPostingLocationFilter(req);
    const { rows: [account] } = await client.query(
      `SELECT cba.id AS account_id, cba.ledger_id, cba.name, cba.account_type,
              COALESCE(cba.location_type, 'headoffice') AS location_type,
              COALESCE(cba.location_id, 0) AS location_id,
              COALESCE(w.name, o.name, 'Head Office') AS location_name
         FROM cash_bank_accounts cba
         JOIN account_ledgers al ON al.id = cba.ledger_id
         LEFT JOIN warehouses w ON cba.location_type = 'warehouse' AND w.id = cba.location_id
         LEFT JOIN outlets o ON cba.location_type = 'outlet' AND o.id = cba.location_id
        WHERE cba.id = $1 AND cba.account_type <> 'cash'
          AND COALESCE(al.is_active, true)
        FOR UPDATE OF cba`,
      [bankAccountId],
    );
    if (!account
      || (access.ledgerIds && !access.ledgerIds.has(Number(account.ledger_id)))
      || !matchesViewLocation(account, requestedLocation)) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Bank account not found." });
      return;
    }

    // Advisory locks cover the first reconciliation of an identity, where no
    // status row exists yet. Sorting makes concurrent batches acquire locks in
    // the same order and prevents deadlocks.
    const sorted = [...identities].sort((a: any, b: any) =>
      `${a.ledgerId}:${a.entryId}`.localeCompare(`${b.ledgerId}:${b.entryId}`));
    for (const identity of sorted) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('bank-reconciliation-entry'), hashtext($1))`,
        [`${identity.ledgerId}:${identity.entryId}`],
      );
    }

    const postings = await buildDerivedPostings({ q: client });
    const byKey = new Map<string, any>();
    for (const posting of postings as any[]) {
      const key = `${Number(posting.ledgerId)}:${posting.entryId}`;
      const current = byKey.get(key);
      if (current) {
        current.debit += Number(posting.debit ?? 0);
        current.credit += Number(posting.credit ?? 0);
      } else {
        byKey.set(key, {
          ...posting,
          ledgerId: Number(posting.ledgerId),
          entryId: String(posting.entryId),
          debit: Number(posting.debit ?? 0),
          credit: Number(posting.credit ?? 0),
        });
      }
    }

    const chosen: any[] = [];
    for (const identity of identities) {
      const posting = byKey.get(`${identity.ledgerId}:${identity.entryId}`);
      if (!posting || identity.ledgerId !== Number(account.ledger_id) || posting.source === "opening_balance") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `Transaction ${identity.entryId} is not an eligible transaction in the selected bank account.` });
        return;
      }
      if (access.ledgerIds && !access.ledgerIds.has(identity.ledgerId)
        && !isLocationInScope(access.dataScope, posting.locationType, posting.locationId)) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "One or more transactions are outside your location scope." });
        return;
      }
      if (requestedPostingLocation && !postingMatchesLocation(posting, requestedPostingLocation)) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "One or more transactions are outside the selected location." });
        return;
      }
      if (posting.locationType && !isLocationInScope(access.dataScope, posting.locationType, posting.locationId)
        && !access.dataScope.isHeadOffice) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "One or more transactions are outside your location scope." });
        return;
      }
      const { rows: [existing] } = await client.query(
        `SELECT status FROM bank_reconciliation_entries
          WHERE ledger_id = $1 AND entry_id = $2
          FOR UPDATE`,
        [identity.ledgerId, identity.entryId],
      );
      if (existing?.status === "reconciled") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `Transaction ${identity.entryId} is already reconciled.` });
        return;
      }
      chosen.push(posting);
    }

    const grossAmount = Math.round(chosen.reduce((sum, p) =>
      sum + Math.abs(Number(p.debit) - Number(p.credit)), 0) * 100) / 100;
    const netAmount = Math.round((grossAmount - processingCharge) * 100) / 100;
    if (processingCharge > grossAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "processingCharge cannot exceed the selected gross amount." });
      return;
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('bank-reconciliation-batch-reference'), $1::int)`,
      [reconciliationYear],
    );
    const { rows: [maxRow] } = await client.query(
      `SELECT COALESCE(MAX((regexp_replace(batch_reference, '^BANK-RECON-\\d+-', ''))::int), 0) AS max_seq
         FROM bank_reconciliation_batches
        WHERE batch_reference ~ ('^BANK-RECON-' || $1::text || '-\\d+$')`,
      [reconciliationYear],
    );
    const sequence = Number(maxRow.max_seq) + 1;
    const batchReference = `BANK-RECON-${reconciliationYear}-${String(sequence).padStart(4, "0")}`;
    const { rows: [batch] } = await client.query(
      `INSERT INTO bank_reconciliation_batches
         (batch_reference, reconciliation_date, bank_account_id, bank_ledger_id,
          location_type, location_id, gross_amount, processing_charge, net_amount,
          accounting_impact, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'none',$10)
       RETURNING id`,
      [
        batchReference, reconciliationDate, Number(account.account_id), Number(account.ledger_id),
        account.location_type, Number(account.location_id), grossAmount, processingCharge,
        netAmount, (req as any).employee?.username ?? "system",
      ],
    );
    for (const posting of chosen) {
      await client.query(
        `INSERT INTO bank_reconciliation_batch_items
           (batch_id, entry_id, ledger_id, source, transaction_date, debit, credit, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          batch.id, posting.entryId, Number(posting.ledgerId), posting.source, String(posting.date).slice(0, 10),
          Number(posting.debit), Number(posting.credit),
          Math.abs(Number(posting.debit) - Number(posting.credit)),
        ],
      );
      await client.query(
        `INSERT INTO bank_reconciliation_entries
           (entry_id, ledger_id, source, transaction_date, debit, credit, voucher_number,
             description, location_type, location_id, status, reconciled_at, reconciled_by,
             unreconciled_at, unreconciled_by, reconciliation_reference)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reconciled',now(),$11,NULL,NULL,$12)
         ON CONFLICT (ledger_id, entry_id) DO UPDATE
           SET source=EXCLUDED.source, transaction_date=EXCLUDED.transaction_date,
               debit=EXCLUDED.debit, credit=EXCLUDED.credit,
               voucher_number=EXCLUDED.voucher_number, description=EXCLUDED.description,
               location_type=EXCLUDED.location_type, location_id=EXCLUDED.location_id,
                status='reconciled', reconciled_at=now(), reconciled_by=EXCLUDED.reconciled_by,
                unreconciled_at=NULL, unreconciled_by=NULL,
                reconciliation_reference=EXCLUDED.reconciliation_reference`,
        [
          posting.entryId, Number(posting.ledgerId), posting.source, String(posting.date).slice(0, 10),
          Number(posting.debit), Number(posting.credit), posting.voucherNumber ?? null,
          posting.description ?? "", posting.locationType ?? null, posting.locationId ?? null,
           (req as any).employee?.username ?? "system", batchReference,
        ],
      );
    }
    await logActivityInTransaction(client, {
      action: "CREATE",
      module: "reconciliation",
      entityType: "bank_reconciliation_batch",
      entityId: batch.id,
      description: `Bank reconciliation batch ${batchReference}`,
      metadata: {
        after: {
          batchReference, bankAccountId: Number(account.account_id), bankLedgerId: Number(account.ledger_id),
          itemCount: chosen.length, grossAmount, processingCharge, netAmount,
          accountingImpact: "none",
        },
      },
      user: (req as any).employee?.username,
    });
    await client.query("COMMIT");
    res.status(201).json({
      id: Number(batch.id), batchReference, reconciliationDate,
      bankAccountId: Number(account.account_id), bankLedgerId: Number(account.ledger_id),
      itemCount: chosen.length, grossAmount, processingCharge, netAmount,
      accountingImpact: "none", status: "active",
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") {
      res.status(409).json({ error: "One or more selected transactions were reconciled concurrently. Refresh and try again." });
      return;
    }
    console.error("Bank reconciliation batch error:", err);
    res.status(500).json({ error: err?.message ?? "Failed to create bank reconciliation batch." });
  } finally {
    client.release();
  }
});

// ── PATCH /reconciliation/bank-batches/:id ────────────────────────────────────
// Editing replaces the batch's reviewed transaction set and metadata atomically.
// It never creates or changes accounting documents.
router.patch("/reconciliation/bank-batches/:id", requireModuleAction("page:/accounts/reconciliation", "edit"), async (req, res): Promise<void> => {
  const batchId = Number(req.params.id);
  const body = (req.body ?? {}) as Record<string, any>;
  const selected = Array.isArray(body.transactions) ? body.transactions : [];
  const reconciliationDate = String(body.reconciliationDate ?? "");
  const chargeText = body.processingCharge == null ? "0" : String(body.processingCharge).trim();
  if (!Number.isInteger(batchId) || batchId <= 0) {
    res.status(400).json({ error: "Invalid reconciliation batch id." });
    return;
  }
  if (selected.length === 0 || selected.length > 500) {
    res.status(400).json({ error: "Select between 1 and 500 bank transactions." });
    return;
  }
  if (!isIsoDate(reconciliationDate)) {
    res.status(400).json({ error: "reconciliationDate must be a real YYYY-MM-DD date." });
    return;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(chargeText)) {
    res.status(400).json({ error: "processingCharge must be a non-negative amount with at most two decimals." });
    return;
  }
  const processingCharge = Math.round(Number(chargeText) * 100) / 100;
  const identities = selected.map((item: any) => ({
    entryId: String(item?.entryId ?? "").trim(),
    ledgerId: Number(item?.ledgerId),
  }));
  if (identities.some((x: any) => !x.entryId || x.entryId.length > 200 || !Number.isInteger(x.ledgerId) || x.ledgerId <= 0)) {
    res.status(400).json({ error: "Every transaction must contain a valid entryId and ledgerId." });
    return;
  }
  const uniqueKeys = new Set(identities.map((x: any) => `${x.ledgerId}:${x.entryId}`));
  if (uniqueKeys.size !== identities.length) {
    res.status(400).json({ error: "A transaction may appear only once in a batch." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [batch] } = await client.query(
      `SELECT b.*, cba.name AS bank_account_name,
              COALESCE(w.name, o.name, 'Head Office') AS location_name
         FROM bank_reconciliation_batches b
         JOIN cash_bank_accounts cba ON cba.id = b.bank_account_id
         LEFT JOIN warehouses w ON b.location_type = 'warehouse' AND w.id = b.location_id
         LEFT JOIN outlets o ON b.location_type = 'outlet' AND o.id = b.location_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [batchId],
    );
    if (!batch) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Reconciliation batch not found." });
      return;
    }
    if (batch.status !== "active") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Only active reconciliation batches can be edited." });
      return;
    }
    const access = await bookAccessScope((req as any).employee ?? {});
    const requestedLocation = getLocationFilter(req);
    const requestedPostingLocation = getPostingLocationFilter(req);
    if (access.ledgerIds && !access.ledgerIds.has(Number(batch.bank_ledger_id))) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Reconciliation batch not found." });
      return;
    }
    if (!matchesViewLocation(batch, requestedLocation)) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Reconciliation batch not found." });
      return;
    }

    const { rows: currentItems } = await client.query(
      `SELECT entry_id, ledger_id
         FROM bank_reconciliation_batch_items
        WHERE batch_id = $1
        FOR UPDATE`,
      [batchId],
    );
    const currentKeys = new Set(currentItems.map((item: any) => `${Number(item.ledger_id)}:${item.entry_id}`));
    const allKeys = new Map<string, { entryId: string; ledgerId: number }>();
    for (const item of currentItems) {
      allKeys.set(`${Number(item.ledger_id)}:${item.entry_id}`, {
        entryId: String(item.entry_id),
        ledgerId: Number(item.ledger_id),
      });
    }
    for (const identity of identities) {
      allKeys.set(`${identity.ledgerId}:${identity.entryId}`, identity);
    }
    for (const identity of [...allKeys.values()].sort((a, b) =>
      `${a.ledgerId}:${a.entryId}`.localeCompare(`${b.ledgerId}:${b.entryId}`))) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('bank-reconciliation-entry'), hashtext($1))`,
        [`${identity.ledgerId}:${identity.entryId}`],
      );
    }

    const { rows: accounts } = await client.query(
      `SELECT cba.id AS account_id, cba.ledger_id,
              COALESCE(cba.location_type, 'headoffice') AS location_type,
              COALESCE(cba.location_id, 0) AS location_id
         FROM cash_bank_accounts cba
         JOIN account_ledgers al ON al.id = cba.ledger_id
        WHERE cba.id = $1 AND cba.account_type <> 'cash'
          AND COALESCE(al.is_active, true)`,
      [Number(batch.bank_account_id)],
    );
    const account = accounts[0];
    if (!account) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "The bank account for this batch is no longer active." });
      return;
    }

    const postings = await buildDerivedPostings({ q: client });
    const byKey = new Map<string, any>();
    for (const posting of postings as any[]) {
      const key = `${Number(posting.ledgerId)}:${posting.entryId}`;
      const current = byKey.get(key);
      if (current) {
        current.debit += Number(posting.debit ?? 0);
        current.credit += Number(posting.credit ?? 0);
      } else {
        byKey.set(key, {
          ...posting,
          ledgerId: Number(posting.ledgerId),
          entryId: String(posting.entryId),
          debit: Number(posting.debit ?? 0),
          credit: Number(posting.credit ?? 0),
        });
      }
    }

    const chosen: any[] = [];
    for (const identity of identities) {
      const key = `${identity.ledgerId}:${identity.entryId}`;
      const posting = byKey.get(key);
      if (!posting || identity.ledgerId !== Number(batch.bank_ledger_id) || posting.source === "opening_balance") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `Transaction ${identity.entryId} is not an eligible transaction in this bank account.` });
        return;
      }
      if (access.ledgerIds && !access.ledgerIds.has(identity.ledgerId)
        && !isLocationInScope(access.dataScope, posting.locationType, posting.locationId)) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "One or more transactions are outside your location scope." });
        return;
      }
      if (requestedPostingLocation && !postingMatchesLocation(posting, requestedPostingLocation)) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "One or more transactions are outside the selected location." });
        return;
      }
      if (posting.locationType && !isLocationInScope(access.dataScope, posting.locationType, posting.locationId)
        && !access.dataScope.isHeadOffice) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "One or more transactions are outside your location scope." });
        return;
      }
      const { rows: [owner] } = await client.query(
        `SELECT batch_id
           FROM bank_reconciliation_batch_items
          WHERE ledger_id = $1 AND entry_id = $2
          FOR UPDATE`,
        [identity.ledgerId, identity.entryId],
      );
      if (owner && Number(owner.batch_id) !== batchId) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `Transaction ${identity.entryId} already belongs to another reconciliation batch.` });
        return;
      }
      const { rows: [existing] } = await client.query(
        `SELECT status, reconciliation_reference
           FROM bank_reconciliation_entries
          WHERE ledger_id = $1 AND entry_id = $2
          FOR UPDATE`,
        [identity.ledgerId, identity.entryId],
      );
      if (existing?.status === "reconciled" && !currentKeys.has(key)
        && existing.reconciliation_reference !== batch.batch_reference) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `Transaction ${identity.entryId} is already reconciled.` });
        return;
      }
      chosen.push(posting);
    }

    const grossAmount = Math.round(chosen.reduce((sum, posting) =>
      sum + Math.abs(Number(posting.debit) - Number(posting.credit)), 0) * 100) / 100;
    if (processingCharge > grossAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "processingCharge cannot exceed the selected gross amount." });
      return;
    }
    const netAmount = Math.round((grossAmount - processingCharge) * 100) / 100;
    const removed = [...currentKeys].filter(key => !uniqueKeys.has(key));
    for (const key of removed) {
      const [ledgerIdText, ...entryParts] = key.split(":");
      const ledgerId = Number(ledgerIdText);
      const entryId = entryParts.join(":");
      const { rows: [existing] } = await client.query(
        `SELECT status, reconciliation_reference
           FROM bank_reconciliation_entries
          WHERE ledger_id = $1 AND entry_id = $2
          FOR UPDATE`,
        [ledgerId, entryId],
      );
      if (existing?.status === "reconciled"
        && existing.reconciliation_reference
        && existing.reconciliation_reference !== batch.batch_reference) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `Transaction ${entryId} was changed outside this batch and cannot be removed.` });
        return;
      }
      await client.query(
        `UPDATE bank_reconciliation_entries
            SET status='unreconciled', unreconciled_at=now(),
                unreconciled_by=$3, reconciled_at=NULL, reconciled_by=NULL,
                reconciliation_reference=NULL
          WHERE ledger_id=$1 AND entry_id=$2 AND status='reconciled'`,
        [ledgerId, entryId, (req as any).employee?.username ?? "system"],
      );
    }

    await client.query(`DELETE FROM bank_reconciliation_batch_items WHERE batch_id = $1`, [batchId]);
    for (const posting of chosen) {
      await client.query(
        `INSERT INTO bank_reconciliation_batch_items
           (batch_id, entry_id, ledger_id, source, transaction_date, debit, credit, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          batchId, posting.entryId, Number(posting.ledgerId), posting.source, String(posting.date).slice(0, 10),
          Number(posting.debit), Number(posting.credit),
          Math.abs(Number(posting.debit) - Number(posting.credit)),
        ],
      );
      await client.query(
        `INSERT INTO bank_reconciliation_entries
           (entry_id, ledger_id, source, transaction_date, debit, credit, voucher_number,
            description, location_type, location_id, status, reconciled_at, reconciled_by,
            unreconciled_at, unreconciled_by, reconciliation_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reconciled',now(),$11,NULL,NULL,$12)
         ON CONFLICT (ledger_id, entry_id) DO UPDATE
           SET source=EXCLUDED.source, transaction_date=EXCLUDED.transaction_date,
               debit=EXCLUDED.debit, credit=EXCLUDED.credit,
               voucher_number=EXCLUDED.voucher_number, description=EXCLUDED.description,
               location_type=EXCLUDED.location_type, location_id=EXCLUDED.location_id,
               status='reconciled', reconciled_at=now(), reconciled_by=EXCLUDED.reconciled_by,
               unreconciled_at=NULL, unreconciled_by=NULL,
               reconciliation_reference=EXCLUDED.reconciliation_reference`,
        [
          posting.entryId, Number(posting.ledgerId), posting.source, String(posting.date).slice(0, 10),
          Number(posting.debit), Number(posting.credit), posting.voucherNumber ?? null,
          posting.description ?? "", posting.locationType ?? null, posting.locationId ?? null,
          (req as any).employee?.username ?? "system", batch.batch_reference,
        ],
      );
    }
    await client.query(
      `UPDATE bank_reconciliation_batches
          SET reconciliation_date=$2, gross_amount=$3, processing_charge=$4, net_amount=$5
        WHERE id=$1`,
      [batchId, reconciliationDate, grossAmount, processingCharge, netAmount],
    );
    await logActivityInTransaction(client, {
      action: "UPDATE",
      module: "reconciliation",
      entityType: "bank_reconciliation_batch",
      entityId: batchId,
      description: `Updated bank reconciliation batch ${batch.batch_reference}`,
      metadata: {
        before: {
          reconciliationDate: String(batch.reconciliation_date).slice(0, 10),
          itemCount: currentItems.length,
          grossAmount: Number(batch.gross_amount),
          processingCharge: Number(batch.processing_charge),
          netAmount: Number(batch.net_amount),
        },
        after: {
          reconciliationDate, itemCount: chosen.length, grossAmount, processingCharge, netAmount,
          removedCount: removed.length,
          accountingImpact: "none",
        },
      },
      user: (req as any).employee?.username,
    });
    await client.query("COMMIT");
    res.json({
      id: batchId,
      batchReference: batch.batch_reference,
      reconciliationDate,
      bankAccountId: Number(batch.bank_account_id),
      bankLedgerId: Number(batch.bank_ledger_id),
      itemCount: chosen.length,
      grossAmount,
      processingCharge,
      netAmount,
      accountingImpact: "none",
      status: "active",
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") {
      res.status(409).json({ error: "One or more selected transactions were reconciled concurrently. Refresh and try again." });
      return;
    }
    console.error("Bank reconciliation batch update error:", err);
    res.status(500).json({ error: err?.message ?? "Failed to update bank reconciliation batch." });
  } finally {
    client.release();
  }
});

// ── POST /reconciliation/bank-reset ──────────────────────────────────────────
// Administrator-only reset of review state. It does not touch any financial
// document, voucher, ledger, GST, stock, or legacy settlement batch.
router.post("/reconciliation/bank-reset", requireModuleAction("page:/accounts/reconciliation", "delete"), async (req, res): Promise<void> => {
  if (!(await isLevelOneAdmin((req as any).employee ?? {}))) {
    res.status(403).json({ error: "Only an Administrator can reset bank reconciliation state." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const [accountCount, statusTotals, batchTotals, batchItems, bankTreeRows] = await Promise.all([
      client.query(`
        SELECT COUNT(*)::int AS count
          FROM cash_bank_accounts cba
          JOIN account_ledgers al ON al.id = cba.ledger_id
         WHERE cba.account_type <> 'cash' AND COALESCE(al.is_active, true)
      `),
      client.query(`
        SELECT status, COUNT(*)::int AS count,
               COALESCE(SUM(ABS(debit - credit)), 0)::numeric AS amount
          FROM bank_reconciliation_entries
         GROUP BY status
      `),
      client.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(gross_amount), 0)::numeric AS gross,
               COALESCE(SUM(processing_charge), 0)::numeric AS charges,
               COALESCE(SUM(net_amount), 0)::numeric AS net
          FROM bank_reconciliation_batches
      `),
      client.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(amount), 0)::numeric AS amount
          FROM bank_reconciliation_batch_items
      `),
      client.query(`
        WITH RECURSIVE bank_tree AS (
          SELECT id, parent_id FROM account_ledgers WHERE code = 'STD-BANK'
          UNION ALL
          SELECT l.id, l.parent_id
            FROM account_ledgers l
            JOIN bank_tree b ON b.id = l.parent_id
        )
        SELECT id FROM bank_tree
      `),
    ]);
    const postings = await buildDerivedPostings({ q: client });
    const bankLedgerIds = new Set<number>(bankTreeRows.rows.map((r: any) => Number(r.id)));
    const { rows: assignedBankAccounts } = await client.query(`
      SELECT cba.id AS account_id, cba.ledger_id
        FROM cash_bank_accounts cba
        JOIN account_ledgers al ON al.id = cba.ledger_id
       WHERE cba.account_type <> 'cash' AND COALESCE(al.is_active, true)
    `);
    const assignedLedgers = new Set<number>(assignedBankAccounts.map((r: any) => Number(r.ledger_id)));
    const identity = new Map<string, { source: string; amount: number }>();
    for (const posting of postings as any[]) {
      const ledgerId = Number(posting.ledgerId);
      if (!bankLedgerIds.has(ledgerId) || posting.source === "opening_balance") continue;
      const key = `${ledgerId}:${posting.entryId}`;
      const amount = Math.abs(Number(posting.debit ?? 0) - Number(posting.credit ?? 0));
      const prior = identity.get(key);
      if (prior) prior.amount += amount;
      else identity.set(key, { source: String(posting.source), amount });
    }
    const eligibleIdentities = [...identity.values()].filter((_row, index) => {
      const key = [...identity.keys()][index];
      return assignedLedgers.has(Number(key.split(":")[0]));
    });
    const sourceCounts: Record<string, { count: number; amount: number }> = {};
    for (const row of eligibleIdentities) {
      const source = row.source === "sale" ? "SALE"
        : row.source === "receipt" ? "RECEIPT"
          : row.source === "payment" ? "PAYMENT"
            : "OTHER BANK TRANSACTION";
      sourceCounts[source] ??= { count: 0, amount: 0 };
      sourceCounts[source].count += 1;
      sourceCounts[source].amount += row.amount;
    }
    const statusByName = new Map<string, any>(statusTotals.rows.map((r: any) => [String(r.status), r]));
    const before = {
      bankAccountCount: Number(accountCount.rows[0]?.count ?? 0),
      bankLedgerTransactionCount: identity.size,
      eligibleTransactionCount: eligibleIdentities.length,
      eligibleTransactionAmount: Math.round(eligibleIdentities.reduce((n, r) => n + r.amount, 0) * 100) / 100,
      reconciledTransactionCount: Number(statusByName.get("reconciled")?.count ?? 0),
      reconciledTransactionAmount: Number(statusByName.get("reconciled")?.amount ?? 0),
      unreconciledTransactionCount: Number(statusByName.get("unreconciled")?.count ?? 0),
      unreconciledTransactionAmount: Number(statusByName.get("unreconciled")?.amount ?? 0),
      batchCount: Number(batchTotals.rows[0]?.count ?? 0),
      batchGrossAmount: Number(batchTotals.rows[0]?.gross ?? 0),
      batchProcessingCharges: Number(batchTotals.rows[0]?.charges ?? 0),
      batchNetAmount: Number(batchTotals.rows[0]?.net ?? 0),
      batchItemCount: Number(batchItems.rows[0]?.count ?? 0),
      batchItemAmount: Number(batchItems.rows[0]?.amount ?? 0),
      sourceCounts: Object.fromEntries(Object.entries(sourceCounts).map(([source, value]) => [
        source, { count: value.count, amount: Math.round(value.amount * 100) / 100 },
      ])),
      accountingImpact: "none: account-based reconciliation is metadata-only",
    };
    const requestedBy = (req as any).employee?.username ?? "system";
    const snapshotInsert = await client.query(
      `INSERT INTO bank_reconciliation_reset_audits
         (reason, requested_by, snapshot)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, requested_at`,
      ["Reconciliation workflow reset/rebuilt", requestedBy, JSON.stringify(before)],
    );
    const deletedItems = await client.query(`DELETE FROM bank_reconciliation_batch_items RETURNING id`);
    const deletedBatches = await client.query(`DELETE FROM bank_reconciliation_batches RETURNING id`);
    await client.query(
      `UPDATE bank_reconciliation_reset_audits
          SET deleted_batch_count = $2, deleted_item_count = $3
        WHERE id = $1`,
      [Number(snapshotInsert.rows[0].id), deletedBatches.rowCount ?? 0, deletedItems.rowCount ?? 0],
    );
    await client.query(
      `UPDATE bank_reconciliation_entries
          SET status='unreconciled', unreconciled_at=now(),
              unreconciled_by=$1, reconciled_at=NULL, reconciled_by=NULL,
              reconciliation_reference=NULL`,
       [requestedBy],
    );
    await logActivityInTransaction(client, {
      action: "DELETE",
      module: "reconciliation",
      entityType: "bank_reconciliation_reset",
      description: "Reconciliation Reset",
      metadata: {
        before: {
          ...before,
        },
        after: { reconciledEntryCount: 0, batchCount: 0, accountingImpact: "none" },
        resetAuditId: Number(snapshotInsert.rows[0].id),
        deletedBatchItemCount: deletedItems.rowCount ?? 0,
        deletedBatchCount: deletedBatches.rowCount ?? 0,
        legacySettlementBatchesPreserved: true,
      },
      user: requestedBy,
    });
    await client.query("COMMIT");
    res.json({
      reset: true,
      resetAuditId: Number(snapshotInsert.rows[0].id),
      before,
      reconciledEntriesReset: Number(before.reconciledTransactionCount),
      bankBatchesDeleted: deletedBatches.rowCount ?? 0,
      batchItemsDeleted: deletedItems.rowCount ?? 0,
      legacySettlementBatchesPreserved: true,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ── POST /reconciliation/bank-book/:entryId/reconcile ────────────────────────
// One-step Bank Book status change. This never creates a voucher or posting:
// the selected posting is re-read from the authoritative derived book inside
// the transaction, and only its reconciliation metadata is changed.
router.post(
  "/reconciliation/bank-book/:entryId/reconcile",
  requireModuleAction(["page:/accounts/bank-book", "page:/accounts/reconciliation"], "edit"),
  async (req, res): Promise<void> => {
    const entryId = decodeURIComponent(String(req.params.entryId ?? "")).trim();
    const ledgerId = Number((req.body as any)?.ledgerId);
    const reconciled = (req.body as any)?.reconciled;
    const referenceRaw = (req.body as any)?.reference;
    const reference = referenceRaw == null ? null : String(referenceRaw).trim().slice(0, 200) || null;

    if (!entryId || entryId.length > 200 || !Number.isInteger(ledgerId) || ledgerId <= 0) {
      res.status(400).json({ error: "entryId and a valid bank ledgerId are required." });
      return;
    }
    if (typeof reconciled !== "boolean") {
      res.status(400).json({ error: "reconciled must be true or false." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const kind = await ledgerBookKind(ledgerId, client);
      if (kind !== "bank") {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Bank ledger not found." });
        return;
      }

      const access = await bookAccessScope((req as any).employee ?? {});
      if (access.ledgerIds && !access.ledgerIds.has(ledgerId)) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Bank ledger not found." });
        return;
      }
      const { rows: assignedAccount } = await client.query(
        `SELECT 1
           FROM cash_bank_accounts
          WHERE ledger_id = $1
            AND account_type <> 'cash'
          LIMIT 1`,
        [ledgerId],
      );
      if (assignedAccount.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Bank account not found." });
        return;
      }

      // Coordinate with the multi-select batch route even when this is the
      // first reconciliation of the identity and no status row exists yet.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('bank-reconciliation-entry'), hashtext($1))`,
        [`${ledgerId}:${entryId}`],
      );
      const book = await computeCashBankBook({
        q: client,
        ledgerId,
        dataScope: access.dataScope,
        accessibleLedgerIds: access.ledgerIds ? [...access.ledgerIds] : undefined,
      });
      const entry = book?.entries.find((candidate: any) =>
        candidate.entryId === entryId && Number(candidate.ledgerId) === ledgerId,
      );
      if (!entry) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Bank transaction not found." });
        return;
      }
      if (!entry.reconciliationEligible) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Opening balances cannot be reconciled as bank transactions." });
        return;
      }

      const { rows: [existing] } = await client.query(
        `SELECT * FROM bank_reconciliation_entries
          WHERE ledger_id = $1 AND entry_id = $2
          FOR UPDATE`,
        [ledgerId, entryId],
      );
      const previousStatus = existing?.status ?? "unreconciled";
      const username = (req as any).employee?.username ?? "system";

      if (!reconciled && previousStatus !== "reconciled") {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Transaction is already unreconciled." });
        return;
      }

      let saved: any;
      if (reconciled) {
        const { rows: [row] } = await client.query(
          `INSERT INTO bank_reconciliation_entries
             (entry_id, ledger_id, source, transaction_date, debit, credit,
              voucher_number, description, location_type, location_id, status,
              reconciled_at, reconciled_by, reconciliation_reference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reconciled',
                   now(), $11, $12)
           ON CONFLICT (ledger_id, entry_id) DO UPDATE
             SET source = EXCLUDED.source,
                 transaction_date = EXCLUDED.transaction_date,
                 debit = EXCLUDED.debit,
                 credit = EXCLUDED.credit,
                 voucher_number = EXCLUDED.voucher_number,
                 description = EXCLUDED.description,
                 location_type = EXCLUDED.location_type,
                 location_id = EXCLUDED.location_id,
                 status = 'reconciled',
                 reconciled_at = now(),
                 reconciled_by = EXCLUDED.reconciled_by,
                 unreconciled_at = NULL,
                 unreconciled_by = NULL,
                 reconciliation_reference = EXCLUDED.reconciliation_reference
           RETURNING *`,
          [
            entry.entryId, ledgerId, entry.source, entry.date, entry.debit, entry.credit,
            entry.voucherNumber ?? null, entry.description, entry.locationType ?? null,
            entry.locationId ?? null, username, reference,
          ],
        );
        saved = row;
      } else {
        const { rows: [row] } = await client.query(
          `UPDATE bank_reconciliation_entries
              SET status = 'unreconciled',
                  unreconciled_at = now(),
                  unreconciled_by = $3,
                  reconciliation_reference = NULL
            WHERE ledger_id = $1 AND entry_id = $2
            RETURNING *`,
          [ledgerId, entryId, username],
        );
        saved = row;
      }

      const nextStatus = reconciled ? "reconciled" : "unreconciled";
      await logActivityInTransaction(client, {
        action: "UPDATE",
        module: "reconciliation",
        entityType: "bank_reconciliation_entry",
        entityId: saved.id,
        description: `${reconciled ? "Reconciled" : "Unreconciled"} ${entry.source} ${entry.entryId}`,
        metadata: {
          before: { status: previousStatus },
          after: {
            status: nextStatus,
            entryId: entry.entryId,
            ledgerId,
            source: entry.source,
            reference: reconciled ? reference : null,
          },
        },
        user: username,
      });
      await client.query("COMMIT");

      res.json({
        ...entry,
        reconciliationStatus: nextStatus,
        reconciledAt: reconciled ? saved.reconciled_at : null,
        reconciledBy: reconciled ? saved.reconciled_by : null,
        reconciliationReference: reconciled ? saved.reconciliation_reference : null,
      });
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      res.status(500).json({ error: err.message ?? "Failed to update bank reconciliation status." });
    } finally {
      client.release();
    }
  },
);

// ── POST /reconciliation/bank-accounts ───────────────────────────────────────
// A bank account is the one balance-sheet leaf with no master record of its own,
// so retiring hand-made ledgers left it with no way to exist — and a batch cannot
// be settled without a destination account, which would strand reconciliation
// entirely on a fresh install. Provisioning the account creates its ledger, which
// is the same rule every other ledger in the chart now follows.
router.post(
  "/reconciliation/bank-accounts",
  requireModuleAction("page:/accounts/reconciliation", "add"),
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    /** Trimmed text, or `undefined` when the value is the wrong type or too long. */
    const readText = (key: string, max: number): string | undefined => {
      const raw = body[key];
      if (raw === undefined || raw === null) return "";
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim();
      return trimmed.length > max ? undefined : trimmed;
    };

    const name = readText("name", 120);
    const bankName = readText("bankName", 120);
    const accountNumber = readText("accountNumber", 64);
    const ifscCode = readText("ifscCode", 32);
    const branch = readText("branch", 120);

    if ([name, bankName, accountNumber, ifscCode, branch].some((v) => v === undefined)) {
      res.status(400).json({ error: "Bank account details must be text within the allowed length." });
      return;
    }
    if (!name) { res.status(400).json({ error: "Give the bank account a name." }); return; }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Check-then-insert has to be one writer at a time or two clicks race past
      // the duplicate check and leave two ledgers with the same name.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('reconciliation:bank-account:create'))");

      const { rows: [bankRoot] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-BANK' LIMIT 1`,
      );
      if (!bankRoot) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "The standard Bank group is missing from the chart of accounts." });
        return;
      }

      const { rows: [dupe] } = await client.query(
        `SELECT id FROM account_ledgers WHERE parent_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [bankRoot.id, name],
      );
      if (dupe) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `A bank account named "${name}" already exists.` });
        return;
      }

      const bankDetails = {
        bankName: bankName ?? "",
        accountNumber: accountNumber ?? "",
        ifscCode: ifscCode ?? "",
        branch: branch ?? "",
      };
      const { rows: [created] } = await client.query(
        `INSERT INTO account_ledgers (name, type, parent_id, section, is_system_group, is_group, bank_details)
         VALUES ($1, 'asset', $2, NULL, false, false, $3::jsonb)
         RETURNING id, name, bank_details`,
        [name, bankRoot.id, JSON.stringify(bankDetails)],
      );
      await logActivityInTransaction(client, {
        action: "CREATE", module: "reconciliation", entityType: "bank_account", entityId: created.id,
        description: `Bank account ${name}`,
        metadata: { after: { name, ...bankDetails } },
        user: (req as any).employee?.username,
      });
      await client.query("COMMIT");

      res.status(201).json({
        id: created.id,
        name: created.name,
        code: null,
        bankDetails: created.bank_details ?? null,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
);

// ── GET /reconciliation/pending ───────────────────────────────────────────────
// Lists all pending electronic sale_payments
router.get("/reconciliation/pending", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const { outletId, locationType, locationId, method, fromDate, toDate, search } =
    req.query as Record<string, string | undefined>;

  const params: any[] = ["pending"];
  const conds: string[] = ["sp.reconciliation_status = $1"];

  applyLocationScope(req, params, conds, { locationType, locationId, outletId });
  // 'bank' also matches the legacy 'card' / 'bank_transfer' values, which mean
  // the same thing and are never rewritten in place.
  if (method) {
    const matches = method === 'bank' ? ['bank', ...LEGACY_BANK_MODES] : [method];
    params.push(matches); conds.push(`sp.method = ANY($${params.length}::text[])`);
  }
  if (fromDate) { params.push(fromDate);           conds.push(`sp.payment_date >= $${params.length}`); }
  if (toDate)   { params.push(toDate);             conds.push(`sp.payment_date <= $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR s.legacy_invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const where = conds.join(" AND ");
  const { rows } = await pool.query(
    `SELECT sp.id, sp.sale_id, sp.payment_date, sp.method, sp.amount::numeric AS amount,
            sp.reference_number, sp.notes, sp.reconciliation_status,
            sp.created_at,
            s.invoice_number, s.location_type, s.location_id::int AS location_id,
            ${SALE_LOCATION_NAME} AS location_name,
            c.name AS customer_name
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     ${SALE_LOCATION_JOINS}
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${where}
     ORDER BY sp.payment_date DESC, sp.id DESC`,
    params
  );

  res.json(rows.map((r: any) => ({
    id: r.id,
    saleId: r.sale_id,
    paymentDate: r.payment_date,
    method: r.method,
    amount: Number(r.amount),
    referenceNumber: r.reference_number,
    notes: r.notes,
    reconciliationStatus: r.reconciliation_status,
    locationType: r.location_type,
    locationId: r.location_id,
    createdAt: r.created_at,
    invoiceNumber: r.invoice_number,
    locationName: r.location_name ?? "—",
    customerName: r.customer_name ?? null,
  })));
});

// ── GET /reconciliation/batches ───────────────────────────────────────────────
router.get("/reconciliation/batches", requireModuleView("page:/accounts/reconciliation"), async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT rb.*,
            rb.gross_amount::numeric AS gross_amount,
            rb.charges::numeric AS charges,
            rb.net_amount::numeric AS net_amount,
            al.name AS bank_ledger_name,
            COUNT(rbi.id)::int AS item_count
     FROM reconciliation_batches rb
     LEFT JOIN account_ledgers al ON al.id = rb.destination_bank_ledger_id
     LEFT JOIN reconciliation_batch_items rbi ON rbi.batch_id = rb.id
     GROUP BY rb.id, al.name
     ORDER BY rb.created_at DESC`
  );

  res.json(rows.map((r: any) => ({
    id: r.id,
    batchReference: r.batch_reference,
    settlementDate: r.settlement_date,
    grossAmount: Number(r.gross_amount),
    charges: Number(r.charges),
    netAmount: Number(r.net_amount),
    destinationBankLedgerId: r.destination_bank_ledger_id,
    bankLedgerName: r.bank_ledger_name ?? "",
    externalReference: r.external_reference,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    status: r.status,
    itemCount: r.item_count,
  })));
});

// ── GET /reconciliation/batches/:id ──────────────────────────────────────────
router.get("/reconciliation/batches/:id", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid batch id" }); return; }

  const { rows: [batch] } = await pool.query(
    `SELECT rb.*,
            rb.gross_amount::numeric AS gross_amount,
            rb.charges::numeric AS charges,
            rb.net_amount::numeric AS net_amount,
            al.name AS bank_ledger_name
     FROM reconciliation_batches rb
     LEFT JOIN account_ledgers al ON al.id = rb.destination_bank_ledger_id
     WHERE rb.id = $1`,
    [id]
  );
  if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

  const { rows: items } = await pool.query(
    `SELECT rbi.id, rbi.sale_payment_id, rbi.amount::numeric AS amount,
            sp.method, sp.payment_date, sp.reference_number,
            s.invoice_number, s.id AS sale_id,
            ${SALE_LOCATION_NAME} AS location_name,
            c.name AS customer_name
     FROM reconciliation_batch_items rbi
     JOIN sale_payments sp ON sp.id = rbi.sale_payment_id
     JOIN sales s ON s.id = sp.sale_id
     ${SALE_LOCATION_JOINS}
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE rbi.batch_id = $1
     ORDER BY sp.payment_date`,
    [id]
  );

  res.json({
    id: batch.id,
    batchReference: batch.batch_reference,
    settlementDate: batch.settlement_date,
    grossAmount: Number(batch.gross_amount),
    charges: Number(batch.charges),
    netAmount: Number(batch.net_amount),
    destinationBankLedgerId: batch.destination_bank_ledger_id,
    bankLedgerName: batch.bank_ledger_name ?? "",
    externalReference: batch.external_reference,
    notes: batch.notes,
    createdBy: batch.created_by,
    createdAt: batch.created_at,
    status: batch.status,
    items: items.map((i: any) => ({
      id: i.id,
      salePaymentId: i.sale_payment_id,
      amount: Number(i.amount),
      method: i.method,
      paymentDate: i.payment_date,
      referenceNumber: i.reference_number,
      invoiceNumber: i.invoice_number,
      saleId: i.sale_id,
      locationName: i.location_name ?? "—",
      customerName: i.customer_name ?? null,
    })),
  });
});

// ── POST /reconciliation/batches ──────────────────────────────────────────────
router.post("/reconciliation/batches", requireModuleAction("page:/accounts/reconciliation", "add"), async (req, res): Promise<void> => {
  const {
    salePaymentIds, charges, settlementDate,
    destinationBankLedgerId, externalReference, notes,
  } = req.body as {
    salePaymentIds: number[];
    charges: number;
    settlementDate: string;
    destinationBankLedgerId: number;
    externalReference?: string;
    notes?: string;
  };

  if (!Array.isArray(salePaymentIds) || salePaymentIds.length === 0) {
    res.status(400).json({ error: "salePaymentIds must be a non-empty array" }); return;
  }
  if (!settlementDate) { res.status(400).json({ error: "settlementDate is required" }); return; }
  if (!isIsoDate(settlementDate)) { res.status(400).json({ error: "settlementDate must be a real calendar date in YYYY-MM-DD form" }); return; }
  if (!destinationBankLedgerId) { res.status(400).json({ error: "destinationBankLedgerId is required" }); return; }

  // Month lock: a reconciliation batch posts new receipt/payment vouchers dated
  // settlementDate — it may not be created in a locked month.
  if (await respondIfMonthLocked(res, pool, [settlementDate], "reconciliation batch")) return;

  const parsedCharges = Number(charges ?? 0);
  if (parsedCharges < 0) { res.status(400).json({ error: "charges cannot be negative" }); return; }

  const createdBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Verify all payments exist, are pending, and lock them
    const { rows: payments } = await client.query(
      `SELECT id, amount::numeric AS amount, reconciliation_status, sale_id
       FROM sale_payments WHERE id = ANY($1) FOR UPDATE`,
      [salePaymentIds]
    );

    if (payments.length !== salePaymentIds.length) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "One or more payment IDs not found" }); return;
    }

    const nonPending = payments.filter((p: any) => p.reconciliation_status !== "pending");
    if (nonPending.length > 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Payments ${nonPending.map((p: any) => p.id).join(", ")} are not pending reconciliation` }); return;
    }

    // 2. Compute gross
    const grossAmount = payments.reduce((s: number, p: any) => s + Number(p.amount), 0);
    const netAmount   = grossAmount - parsedCharges;

    if (netAmount <= 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Net amount (₹${netAmount.toFixed(2)}) must be positive. Reduce charges.` }); return;
    }
    if (parsedCharges >= grossAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Charges cannot be greater than or equal to gross amount" }); return;
    }

    // 3. Verify destination bank ledger is under STD-BANK
    const { rows: allLedgers } = await client.query(`SELECT id, parent_id, code FROM account_ledgers`);
    const bankRoot = allLedgers.find((l: any) => l.code === "STD-BANK");
    if (!bankRoot) { await client.query("ROLLBACK"); res.status(500).json({ error: "STD-BANK ledger not found" }); return; }

    const bankIds = new Set<number>([bankRoot.id]);
    for (let i = 0; i < 5; i++) {
      for (const l of allLedgers) {
        if (l.parent_id && bankIds.has(l.parent_id)) bankIds.add(l.id);
      }
    }
    if (!bankIds.has(Number(destinationBankLedgerId))) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Destination ledger must be a bank account under the Bank ledger group" }); return;
    }

    // 4. Get STD-ELEC-CLR ledger
    const { rows: [clearingLedger] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
    );
    if (!clearingLedger) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Electronic clearing ledger not configured" }); return;
    }

    // 5. Get STD-PROC-CHG ledger (for charges)
    const { rows: [chargesLedger] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = 'STD-PROC-CHG'`
    );
    if (!chargesLedger && parsedCharges > 0) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Processor charges ledger not configured" }); return;
    }

    // 6. Generate batch reference — COUNT(*) is a duplicate-key bug (deleting a
    //    row makes the next insert reuse a number, and concurrent inserts collide).
    //    Serialize allocation with a per-year advisory lock (held to COMMIT) and
    //    derive the next sequence from MAX(existing suffix)+1 INSIDE the txn —
    //    the check-then-insert guard pattern used elsewhere in this codebase.
    const year = new Date().getFullYear();
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('reconciliation-batch-ref'), $1)`, [year]);
    const { rows: [maxRow] } = await client.query(
      `SELECT COALESCE(MAX((regexp_replace(batch_reference, '^RECON-\\d+-', ''))::int), 0) AS max_seq
       FROM reconciliation_batches
       WHERE batch_reference ~ ('^RECON-' || $1 || '-\\d+$')`,
      [String(year)]
    );
    const seq = Number(maxRow.max_seq) + 1;
    const batchReference = `RECON-${year}-${String(seq).padStart(4, "0")}`;

    // 7. Create reconciliation batch
    const { rows: [batch] } = await client.query(
      `INSERT INTO reconciliation_batches (batch_reference, settlement_date, gross_amount, charges, net_amount, destination_bank_ledger_id, external_reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [batchReference, settlementDate, grossAmount, parsedCharges, netAmount, destinationBankLedgerId, externalReference ?? null, notes ?? null, createdBy]
    );

    // 8. Create batch items and mark payments reconciled
    for (const p of payments) {
      await client.query(
        `INSERT INTO reconciliation_batch_items (batch_id, sale_payment_id, amount) VALUES ($1, $2, $3)`,
        [batch.id, p.id, Number(p.amount)]
      );
      await client.query(
        `UPDATE sale_payments SET reconciliation_status = 'reconciled' WHERE id = $1`,
        [p.id]
      );
    }

    // 9. Post accounting entries
    // Both vouchers belong to the location that owns the destination bank
    // account (usually Head Office) — stamped explicitly so located cash
    // books and dashboards see the settlement where the money actually landed.
    const batchLocRes = await resolveMoneyVoucherLocation((req as any).employee, undefined, Number(destinationBankLedgerId));
    const batchLoc = batchLocRes.ok ? batchLocRes.loc : { locationType: 'headoffice', locationId: 0 };

    // Dr Bank (net) — receipt: received_from=clearing, received_in=bank
    const recVoucher = await nextVoucherNumber(client, 'receipt', settlementDate);
    const { rows: [settlementReceipt] } = await client.query(
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, source, location_type, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'settlement', $7, $8) RETURNING id`,
      [recVoucher, settlementDate, clearingLedger.id, destinationBankLedgerId, netAmount,
        `Bank settlement ${batchReference} — ${payments.length} payments`,
        batchLoc.locationType, Number(batchLoc.locationId)]
    );

    // Dr Charges expense (if any) — payment: paid_from=clearing, paid_to=charges ledger
    let chargePayment: any = null;
    if (parsedCharges > 0 && chargesLedger) {
      const payVoucher = await nextVoucherNumber(client, 'payment', settlementDate);
      const { rows: [createdChargePayment] } = await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, source, location_type, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'settlement', $7, $8) RETURNING id`,
        [payVoucher, settlementDate, clearingLedger.id, chargesLedger.id, parsedCharges,
          `Processor charges for ${batchReference}`,
          batchLoc.locationType, Number(batchLoc.locationId)]
      );
      chargePayment = createdChargePayment;
    }

    await logActivityInTransaction(client, {
      action: "CREATE", module: "accounts", entityType: "receipt_voucher", entityId: Number(settlementReceipt.id),
      user: (req as any).employee?.username,
      description: `Settlement receipt ${recVoucher} — ₹${netAmount}`,
      metadata: { source: "reconciliation", batchReference, amount: netAmount, settlementDate },
    });
    if (chargePayment) {
      await logActivityInTransaction(client, {
        action: "CREATE", module: "accounts", entityType: "payment_voucher", entityId: Number(chargePayment.id),
        user: (req as any).employee?.username,
        description: `Processor charges for ${batchReference} — ₹${parsedCharges}`,
        metadata: { source: "reconciliation", batchReference, amount: parsedCharges, settlementDate },
      });
    }
    await logActivityInTransaction(client, {
      action: "CREATE", module: "reconciliation", entityType: "reconciliation_batch", entityId: batch.id,
      user: (req as any).employee?.username,
      description: `Reconciliation batch ${batchReference} — ${payments.length} payments, net ₹${netAmount}`,
      metadata: { after: { batchReference, grossAmount, charges: parsedCharges, netAmount, itemCount: payments.length } },
    });
    await client.query("COMMIT");

    res.status(201).json({
      id: batch.id,
      batchReference,
      settlementDate,
      grossAmount,
      charges: parsedCharges,
      netAmount,
      destinationBankLedgerId,
      itemCount: payments.length,
      status: "active",
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Reconciliation error:", err);
    res.status(500).json({ error: err.message ?? "Failed to create reconciliation batch" });
  } finally {
    client.release();
  }
});

// ── GET /reconciliation/reconciled ────────────────────────────────────────────
// Lists reconciled + matched sale_payments so a user can prove (Match) an entry
// against a specific ledger posting/voucher, or reverse a match (Un-match).
// The matched_* audit columns are startup-migration columns INVISIBLE to
// Drizzle, so they are read here with raw SQL via `pool`.
router.get("/reconciliation/reconciled", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const { outletId, locationType, locationId, method, status, fromDate, toDate, search } =
    req.query as Record<string, string | undefined>;

  const params: any[] = [];
  const conds: string[] = [];

  // Only the two post-pending states are relevant here.
  if (status === 'reconciled' || status === 'matched') {
    params.push(status); conds.push(`sp.reconciliation_status = $${params.length}`);
  } else {
    params.push(['reconciled', 'matched']); conds.push(`sp.reconciliation_status = ANY($${params.length}::text[])`);
  }

  applyLocationScope(req, params, conds, { locationType, locationId, outletId });
  if (method) {
    const matches = method === 'bank' ? ['bank', ...LEGACY_BANK_MODES] : [method];
    params.push(matches); conds.push(`sp.method = ANY($${params.length}::text[])`);
  }
  if (fromDate) { params.push(fromDate); conds.push(`sp.payment_date >= $${params.length}`); }
  if (toDate)   { params.push(toDate);   conds.push(`sp.payment_date <= $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR s.legacy_invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const where = conds.join(" AND ");
  const { rows } = await pool.query(
    `SELECT sp.id, sp.sale_id, sp.payment_date, sp.method, sp.amount::numeric AS amount,
            sp.reference_number, sp.notes, sp.reconciliation_status,
            sp.created_at, sp.matched_reference, sp.matched_by, sp.matched_at,
            s.invoice_number, s.location_type, s.location_id::int AS location_id,
            ${SALE_LOCATION_NAME} AS location_name,
            c.name AS customer_name
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     ${SALE_LOCATION_JOINS}
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${where}
     ORDER BY sp.payment_date DESC, sp.id DESC`,
    params
  );

  const salePaymentRows = rows.map((r: any) => ({
    entryType: "sale_payment",
    id: r.id,
    saleId: r.sale_id,
    paymentDate: r.payment_date,
    method: r.method,
    amount: Number(r.amount),
    referenceNumber: r.reference_number,
    notes: r.notes,
    reconciliationStatus: r.reconciliation_status,
    outletId: r.outlet_id,
    createdAt: r.created_at,
    matchedReference: r.matched_reference ?? null,
    matchedBy: r.matched_by ?? null,
    matchedAt: r.matched_at ?? null,
    invoiceNumber: r.invoice_number,
    locationName: r.location_name ?? "—",
    customerName: r.customer_name ?? null,
  }));

  // Bank Book reconciliation uses the same review surface, but its source is
  // the generic posting identity rather than sale_payments. It is intentionally
  // read-only here: status changes still go through the atomic Bank Book route.
  const bankRows: any[] = [];
  if (!method && status !== "matched") {
    const bankParams: any[] = ["reconciled"];
    const bankConds = ["bre.status = $1"];
    const bankAccess = await bookAccessScope((req as any).employee ?? {});
    if (bankAccess.ledgerIds) {
      // A branch may see company-level postings on its own bank ledger, so
      // ledger ownership is the authoritative scope here; location snapshots
      // are still used for Head Office's optional filter.
      bankParams.push([...bankAccess.ledgerIds]);
      bankConds.push(`bre.ledger_id = ANY($${bankParams.length}::int[])`);
    } else {
      applyBankEntryLocationScope(req, bankParams, bankConds, { locationType, locationId });
    }
    if (fromDate) { bankParams.push(fromDate); bankConds.push(`bre.transaction_date >= $${bankParams.length}`); }
    if (toDate) { bankParams.push(toDate); bankConds.push(`bre.transaction_date <= $${bankParams.length}`); }
    if (search) {
      bankParams.push(`%${search}%`);
      bankConds.push(`(bre.voucher_number ILIKE $${bankParams.length} OR bre.description ILIKE $${bankParams.length} OR bre.entry_id ILIKE $${bankParams.length})`);
    }
    const bankResult = await pool.query(
      `SELECT bre.id, bre.entry_id, bre.ledger_id, bre.source,
              bre.transaction_date, bre.debit::numeric AS debit, bre.credit::numeric AS credit,
              bre.voucher_number, bre.description, bre.location_type, bre.location_id,
              bre.status, bre.reconciled_at, bre.reconciled_by,
              bre.reconciliation_reference,
              al.name AS bank_ledger_name,
              COALESCE(o.name, w.name, 'Head Office') AS location_name
         FROM bank_reconciliation_entries bre
         JOIN account_ledgers al ON al.id = bre.ledger_id
         LEFT JOIN outlets o ON bre.location_type = 'outlet' AND o.id = bre.location_id
         LEFT JOIN warehouses w ON bre.location_type = 'warehouse' AND w.id = bre.location_id
        WHERE ${bankConds.join(" AND ")}
        ORDER BY bre.transaction_date DESC, bre.id DESC`,
      bankParams,
    );
    bankRows.push(...bankResult.rows.map((r: any) => ({
      entryType: "bank_book",
      id: r.id,
      entryId: r.entry_id,
      ledgerId: r.ledger_id,
      saleId: null,
      paymentDate: r.transaction_date,
      method: r.source,
      amount: Number(r.debit) || Number(r.credit),
      referenceNumber: r.reconciliation_reference ?? null,
      reconciliationStatus: r.status,
      matchedReference: null,
      matchedBy: r.reconciled_by ?? null,
      matchedAt: r.reconciled_at ?? null,
      invoiceNumber: r.voucher_number ?? r.entry_id,
      locationName: r.location_name ?? "—",
      customerName: null,
      source: r.source,
      bankLedgerName: r.bank_ledger_name,
      description: r.description,
    })));
  }

  res.json([...salePaymentRows, ...bankRows]);
});

// ── POST /reconciliation/:id/match ────────────────────────────────────────────
// Transition Reconciled -> Matched. Ties the entry to a specific ledger
// posting / voucher reference so it can be PROVEN. Records who matched it and
// when. Only a Reconciled entry may become Matched — any other current state
// is rejected with 409 stating the state it is actually in.
// matched_* are startup-migration columns invisible to Drizzle → write via `pool`.
router.post("/reconciliation/:id/match", requireModuleAction("page:/accounts/reconciliation", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }

  const matchedReference = String((req.body as any)?.matchedReference ?? "").trim();
  if (!matchedReference) {
    res.status(400).json({ error: "matchedReference is required — the voucher / ledger posting this entry proves against" });
    return;
  }

  const matchedBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [payment] } = await client.query(
      `SELECT id, reconciliation_status FROM sale_payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!payment) { await client.query("ROLLBACK"); res.status(404).json({ error: "Payment not found" }); return; }

    if (payment.reconciliation_status !== 'reconciled') {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Only a Reconciled entry may be Matched. This entry is currently "${payment.reconciliation_status ?? 'pending'}".`,
      });
      return;
    }

    await client.query(
      `UPDATE sale_payments
       SET reconciliation_status = 'matched',
           matched_reference = $2,
           matched_by = $3,
           matched_at = now()
       WHERE id = $1`,
      [id, matchedReference, matchedBy]
    );

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE", module: "reconciliation", entityType: "sale_payment", entityId: id,
      description: `Matched payment #${id} to ${matchedReference}`,
      metadata: { after: { reconciliationStatus: 'matched', matchedReference, matchedBy } },
    }).catch(() => {});

    res.json({ id, reconciliationStatus: 'matched', matchedReference, matchedBy });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Match error:", err);
    res.status(500).json({ error: err.message ?? "Failed to match payment" });
  } finally {
    client.release();
  }
});

// ── POST /reconciliation/:id/unmatch ──────────────────────────────────────────
// Reverse a match: Matched -> Reconciled, clearing the stored reference and
// audit stamps. Only a Matched entry may be un-matched; anything else is 409.
router.post("/reconciliation/:id/unmatch", requireModuleAction("page:/accounts/reconciliation", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [payment] } = await client.query(
      `SELECT id, reconciliation_status FROM sale_payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!payment) { await client.query("ROLLBACK"); res.status(404).json({ error: "Payment not found" }); return; }

    if (payment.reconciliation_status !== 'matched') {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Only a Matched entry may be un-matched. This entry is currently "${payment.reconciliation_status ?? 'pending'}".`,
      });
      return;
    }

    await client.query(
      `UPDATE sale_payments
       SET reconciliation_status = 'reconciled',
           matched_reference = NULL,
           matched_by = NULL,
           matched_at = NULL
       WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE", module: "reconciliation", entityType: "sale_payment", entityId: id,
      description: `Un-matched payment #${id} (reverted to reconciled)`,
      metadata: { after: { reconciliationStatus: 'reconciled' } },
    }).catch(() => {});

    res.json({ id, reconciliationStatus: 'reconciled', matchedReference: null });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Un-match error:", err);
    res.status(500).json({ error: err.message ?? "Failed to un-match payment" });
  } finally {
    client.release();
  }
});

export default router;
