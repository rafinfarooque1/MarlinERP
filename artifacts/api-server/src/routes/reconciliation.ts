import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
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
                    COALESCE(SUM(COALESCE(s.other_charges, 0)::numeric), 0) AS other_charges
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
router.get("/reconciliation/bank-ledgers", requireModuleView(["page:/accounts/reconciliation", "page:/accounts/cash-in-outlet"]), async (_req, res): Promise<void> => {
  const { rows: allLedgers } = await pool.query(`SELECT id, name, parent_id, code, bank_details FROM account_ledgers ORDER BY id`);
  const bankRoot = allLedgers.find((r: any) => r.code === "STD-BANK");
  if (!bankRoot) { res.json([]); return; }

  const ids = new Set<number>([bankRoot.id]);
  for (let i = 0; i < 5; i++) {
    for (const r of allLedgers) {
      if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
    }
  }

  // Return only leaf ledgers (non-group), excluding the root itself
  const bankLedgers = allLedgers
    .filter((r: any) => ids.has(r.id) && r.id !== bankRoot.id && !allLedgers.some((c: any) => c.parent_id === r.id))
    .map((r: any) => ({
      id: r.id,
      name: r.name,
      code: r.code ?? null,
      bankDetails: r.bank_details ?? null,
    }));

  res.json(bankLedgers);
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

      await client.query("COMMIT");

      const nextStatus = reconciled ? "reconciled" : "unreconciled";
      logActivity({
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
      }).catch(() => {});

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
      await client.query("COMMIT");

      logActivity({
        action: "CREATE", module: "reconciliation", entityType: "bank_account", entityId: created.id,
        description: `Bank account ${name}`,
        metadata: { after: { name, ...bankDetails } },
      }).catch(() => {});

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
    await client.query(
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, source, location_type, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'settlement', $7, $8)`,
      [recVoucher, settlementDate, clearingLedger.id, destinationBankLedgerId, netAmount,
        `Bank settlement ${batchReference} — ${payments.length} payments`,
        batchLoc.locationType, Number(batchLoc.locationId)]
    );

    // Dr Charges expense (if any) — payment: paid_from=clearing, paid_to=charges ledger
    if (parsedCharges > 0 && chargesLedger) {
      const payVoucher = await nextVoucherNumber(client, 'payment', settlementDate);
      await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, source, location_type, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'settlement', $7, $8)`,
        [payVoucher, settlementDate, clearingLedger.id, chargesLedger.id, parsedCharges,
          `Processor charges for ${batchReference}`,
          batchLoc.locationType, Number(batchLoc.locationId)]
      );
    }

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "reconciliation", entityType: "reconciliation_batch", entityId: batch.id,
      description: `Reconciliation batch ${batchReference} — ${payments.length} payments, net ₹${netAmount}`,
      metadata: { after: { batchReference, grossAmount, charges: parsedCharges, netAmount, itemCount: payments.length } },
    }).catch(() => {});

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
