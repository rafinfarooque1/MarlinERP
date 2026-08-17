/**
 * POST /api/pdf/challan  — generates a delivery-challan PDF and returns it inline.
 * POST /api/pdf/payslip  — generates a payslip PDF and returns it inline.
 *
 * Both endpoints require authentication (handled by global requireAuth middleware in app.ts).
 * The caller sends pre-assembled data as JSON; the server renders it with jsPDF.
 */
import { Router } from "express";
import { requireModuleAction } from "../middleware/permissions";
import { generateChallanPdf } from "../services/challanPdf";
import { generatePayslipPdf } from "../services/payslipPdf";
import { generateReportPdf, type ReportPdfInput } from "../services/reportPdf";
import { generateReportXlsx } from "../services/reportXlsx";
import { generateExpenseVoucherPdf } from "../services/expenseVoucherPdf";
import { generateMoneyVoucherPdf } from "../services/moneyVoucherPdf";
import { generateJournalVoucherPdf, type JournalVoucherKind } from "../services/journalVoucherPdf";
import { generateReturnNotePdf } from "../services/returnNotePdf";
import { generatePurchaseBillPdf } from "../services/purchaseBillPdf";
import { loadPurchaseBillDoc } from "./purchases";
import { getUserDataScope } from "../lib/dataScope";
import { ownLocationScope, scopeLedgerIds, scopeMoneyWhere, callerLocation } from "../lib/moneyScope";
import { resolveLocationIssuer, type InvoiceIssuer } from "../lib/billingProfile";
import { getLocationFilter } from "../lib/requestLocation";
import { pool } from "@workspace/db";

const router = Router();

// ── Delivery Challan ──────────────────────────────────────────────────────────
// The caller sends only the transfer id — the challan is assembled from the
// stored transfer row (endpoints, lines, status), never from client-composed
// figures. The letterhead is the DISPATCHING location's identity. LBAC mirrors
// the transfers list: a branch user prints only transfers touching their own
// scope; outside it = 404.
router.post("/pdf/challan", requireModuleAction("page:/transfers", "download"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id is required" }); return; }

    const params: unknown[] = [id];
    const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const scope = await getUserDataScope(emp ?? { branchType: "headoffice", branchId: 0 });
    const { scopeTransferWhere } = await import("../lib/dataScope");
    const scopeCond = scopeTransferWhere(scope, params, "t");

    const { rows: [t] } = await pool.query<any>(`
      SELECT t.*,
             COALESCE(wf.name, of_.name, CASE WHEN t.from_type = 'headoffice' THEN 'Head Office' END) AS from_name,
             COALESCE(wt.name, ot.name, CASE WHEN t.to_type = 'headoffice' THEN 'Head Office' END) AS to_name
        FROM stock_transfers t
        LEFT JOIN warehouses wf ON t.from_type = 'warehouse' AND wf.id = t.from_id
        LEFT JOIN outlets   of_ ON t.from_type = 'outlet'    AND of_.id = t.from_id
        LEFT JOIN warehouses wt ON t.to_type = 'warehouse' AND wt.id = t.to_id
        LEFT JOIN outlets    ot ON t.to_type = 'outlet'    AND ot.id = t.to_id
       WHERE t.id = $1 AND ${scopeCond}`, params);
    if (!t) { res.status(404).json({ error: "Transfer not found" }); return; }

    // Resolve item names/HSN/unit from the masters — transfer lines store only
    // ids. materialType scopes the lookup (polymorphic ids overlap).
    const rawLines: any[] = Array.isArray(t.line_items) ? t.line_items : [];
    const itemIds = rawLines.filter(l => (l.materialType ?? "item") === "item").map(l => Number(l.itemId));
    const matIds = rawLines.filter(l => (l.materialType ?? "item") !== "item").map(l => Number(l.itemId));
    const [itemRows, matRows] = await Promise.all([
      itemIds.length
        ? pool.query<any>(`SELECT id, name, unit, hsn_code FROM items WHERE id = ANY($1::int[])`, [itemIds])
        : Promise.resolve({ rows: [] as any[] }),
      matIds.length
        ? pool.query<any>(`SELECT id, name, unit, hsn_code FROM materials WHERE id = ANY($1::int[])`, [matIds])
        : Promise.resolve({ rows: [] as any[] }),
    ]);
    const nameMap = new Map<string, { name: string; unit: string | null; hsn: string | null }>();
    for (const r of itemRows.rows) nameMap.set(`item:${r.id}`, { name: r.name, unit: r.unit, hsn: r.hsn_code });
    for (const r of matRows.rows) nameMap.set(`mat:${r.id}`, { name: r.name, unit: r.unit, hsn: r.hsn_code });

    const lineItems = rawLines.map((l) => {
      const isItem = (l.materialType ?? "item") === "item";
      const m = nameMap.get(`${isItem ? "item" : "mat"}:${Number(l.itemId)}`);
      return {
        name: m?.name ?? `Item #${l.itemId}`,
        hsnCode: m?.hsn ?? null,
        quantity: Number(l.quantity ?? 0),
        unit: m?.unit ?? null,
      };
    });

    // Letterhead = the dispatching location's identity.
    const issuer = await resolveLocationIssuer(
      pool,
      t.from_type === "warehouse" ? "warehouse" : t.from_type === "outlet" ? "outlet" : null,
      t.from_id != null ? Number(t.from_id) : null,
    );

    const buffer = await generateChallanPdf({
      issuer,
      logoDataUrl: issuer.logoUrl,
      challanNo: t.challan_number ?? "—",
      date: t.transfer_date,
      fromName: t.from_name ?? "—",
      fromType: t.from_type,
      toName: t.to_name ?? "—",
      toType: t.to_type,
      lineItems,
      isInterstate: !!t.is_interstate,
      status: t.status ?? null,
      notes: t.notes ?? null,
      approvedBy: t.approved_by ?? null,
    });
    const safe = String(t.challan_number || "Challan").replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] challan error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Purchase Invoice (bill) ───────────────────────────────────────────────────
// Server-rendered from the stored bill under the RECEIVING location's
// letterhead. LBAC lives in loadPurchaseBillDoc — outside scope = 404, the
// same answer as "does not exist".
router.post("/pdf/purchase-bill", requireModuleAction("page:/production/purchase", "download"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id is required" }); return; }

    const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const scope = await getUserDataScope(emp ?? { branchType: "headoffice", branchId: 0 });
    const purchase = await loadPurchaseBillDoc(id, scope);
    if (!purchase) { res.status(404).json({ error: "Purchase bill not found" }); return; }

    const issuer = await resolveLocationIssuer(
      pool,
      purchase.locationType === "warehouse" ? "warehouse" : purchase.locationType === "outlet" ? "outlet" : null,
      purchase.locationId != null ? Number(purchase.locationId) : null,
    );
    const { buffer, fileName } = await generatePurchaseBillPdf({
      issuer, logoDataUrl: issuer.logoUrl, purchase,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] purchase-bill error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Generic tabular report (Reports Center exports) ──────────────────────────
const MAX_REPORT_ROWS = 3000;

/**
 * Shape-check + row-cap shared by the PDF and Excel renderers, so the two
 * cannot drift into accepting different payloads.
 * Returns null and writes the response when the body is unusable.
 */
function validateReportBody(req: any, res: any, format: "PDF" | "Excel"): ReportPdfInput | null {
  const body = req.body as Partial<ReportPdfInput>;
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ error: "title is required" }); return null;
  }
  if (!Array.isArray(body.sections) || body.sections.length === 0) {
    res.status(400).json({ error: "at least one section is required" }); return null;
  }
  let rowCount = 0;
  for (const s of body.sections) {
    if (!s || !Array.isArray(s.columns) || s.columns.length === 0 || !Array.isArray(s.rows)) {
      res.status(400).json({ error: "each section needs columns[] and rows[]" }); return null;
    }
    rowCount += s.rows.length;
  }
  if (rowCount > MAX_REPORT_ROWS) {
    res.status(413).json({ error: `Report too large for ${format} (${rowCount} rows, max ${MAX_REPORT_ROWS}). Narrow the date range or use CSV.` });
    return null;
  }
  return body as ReportPdfInput;
}

// Download covers every output channel — saving the PDF and sending it to a
// printer alike — so the guard no longer cares which button was pressed.
// Clients may still send an `intent` field; it is ignored.
//
// Any-of guard: the renderer is a shared surface — the Reports Center AND the
// books pages (Ledger, Day Book, Cash/Bank Book, Trial Balance) export through
// it, so holding Download on any ONE of those pages is enough. The payload is
// preformatted rows the caller could already see on screen; the page's own
// view gate decided what data reached the client in the first place.
const REPORT_EXPORT_PAGES = [
  "page:/reports/sales",
  "page:/accounts/ledger",
  "page:/accounts/day-book",
  "page:/accounts/cash-book",
  "page:/accounts/bank-book",
  "page:/accounts/trial-balance",
];

/**
 * Letterhead identity for a books/report export.
 *
 * The export prints under the CURRENT working location's profile (the global
 * sidebar selector rides in as x-location-type/x-location-id — a view filter
 * the page's own data already honoured). The header is client-sent view
 * context, so it is intersected with the caller's LBAC scope before it may
 * select a letterhead. Head Office, "All Locations", an out-of-scope id or a
 * deleted location all fall back to the company profile, so the header is
 * never empty; a live in-scope location always prints under its own identity,
 * matching the invoice convention.
 */
async function reportHeaderProfile(req: any): Promise<ReportPdfInput["cs"]> {
  try {
    const loc = getLocationFilter(req);
    if (loc && (loc.locationType === "warehouse" || loc.locationType === "outlet")) {
      // The header is a client view filter, never authority: intersect it with
      // the caller's location scope (LBAC) before letting it pick a letterhead.
      // A forged or out-of-scope id falls back to the company profile instead
      // of leaking another location's GSTIN/address onto an export.
      const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
      const scope = await getUserDataScope(emp ?? { branchType: "headoffice", branchId: 0 });
      const allowed = scope.isHeadOffice
        || (loc.locationType === "warehouse" && scope.warehouseIds.includes(loc.locationId))
        || (loc.locationType === "outlet" && scope.outletIds.includes(loc.locationId));
      if (allowed) {
        const issuer: InvoiceIssuer = await resolveLocationIssuer(pool, loc.locationType, loc.locationId);
        // A live location always prints under its own identity — even with a
        // blank profile — matching the invoice convention (seller = the
        // location, never the company). Only a deleted location (blank issuer)
        // drops through to the company profile.
        if (issuer.tradeName || issuer.addressLines.length > 0) {
          return {
            companyName: issuer.tradeName || issuer.locationName || undefined,
            address: issuer.addressLines.join(", ") || undefined,
            gstNumber: issuer.gstin || undefined,
            phone: issuer.phone || undefined,
            email: issuer.email || undefined,
          };
        }
      }
    }
  } catch { /* fall through to the company profile */ }
  const { rows: [cs] } = await pool.query<any>(
    `SELECT company_name, address, city, state, pincode, gst_number, phone, email
     FROM company_settings ORDER BY id LIMIT 1`,
  ).catch(() => ({ rows: [undefined as any] }));
  return cs ? {
    companyName: cs.company_name ?? undefined,
    address: cs.address ?? undefined,
    city: cs.city ?? undefined,
    state: cs.state ?? undefined,
    pincode: cs.pincode ?? undefined,
    gstNumber: cs.gst_number ?? undefined,
    phone: cs.phone ?? undefined,
    email: cs.email ?? undefined,
  } : undefined;
}

router.post("/pdf/report", requireModuleAction(REPORT_EXPORT_PAGES, "download"), async (req, res) => {
  try {
    const body = validateReportBody(req, res, "PDF");
    if (!body) return;

    const cs = await reportHeaderProfile(req);

    const buffer = generateReportPdf({
      title: body.title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
      metaRows: Array.isArray(body.metaRows) ? (body.metaRows as [string, string][]) : undefined,
      orientation: body.orientation === "landscape" ? "landscape" : "portrait",
      sections: body.sections,
      footerNote: typeof body.footerNote === "string" ? body.footerNote : undefined,
      cs,
    });
    const safe = body.title.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "Report";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] report error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Generic tabular report — Excel ───────────────────────────────────────────
// Same payload as /pdf/report. Always `download`: there is no such thing as
// printing a spreadsheet straight out of the browser.
router.post("/xlsx/report", requireModuleAction(REPORT_EXPORT_PAGES, "download"), async (req, res) => {
  try {
    const body = validateReportBody(req, res, "Excel");
    if (!body) return;

    const cs = await reportHeaderProfile(req);

    const buffer = await generateReportXlsx({
      title: body.title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
      metaRows: Array.isArray(body.metaRows) ? (body.metaRows as [string, string][]) : undefined,
      orientation: body.orientation === "landscape" ? "landscape" : "portrait",
      sections: body.sections,
      footerNote: typeof body.footerNote === "string" ? body.footerNote : undefined,
      cs,
    });
    const safe = body.title.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "Report";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.xlsx"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] xlsx error:", err);
    res.status(500).json({ error: "Excel generation failed" });
  }
});

// ── Expense payment voucher ───────────────────────────────────────────────────
// Assembled from an id, not from client-posted JSON: a voucher is an accounting
// document, so it must state what the books hold and nothing else. `source`
// selects which of the two expense surfaces the id belongs to — a Head Office
// expense paid from a company cash/bank account, or a location expense paid out
// of a warehouse's own cash.
// Gated on download — the single right that covers every output channel,
// printing included, under the five-action model.
router.post("/pdf/expense-voucher", requireModuleAction(["page:/accounts/expenses", "page:/sales/expenses"], "download"), async (req, res) => {
  try {
    const source = String(req.body?.source ?? "");
    const id = Number(req.body?.id);
    if (source !== "direct" && source !== "location") {
      res.status(400).json({ error: "source must be 'direct' or 'location'" }); return;
    }
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id is required" }); return;
    }

    const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const isHO = !emp || emp.branchType === "headoffice";

    let v: {
      voucherNumber: string; expenseDate: string; amount: number;
      category: string | null; description: string | null;
      expenseLedgerName: string; paidFromName: string; paidFromLabel: string;
      locationName: string; recordedBy: string | null; recordedAt: string | null;
      attachmentUrl: string | null;
      ownerType: string | null; ownerId: number | null;
    };

    if (source === "direct") {
      const { rows: [r] } = await pool.query<any>(`
        SELECT e.id, e.expense_number, e.expense_date, e.amount, e.description,
               e.category, e.attachment_url, e.location_type, e.location_id, e.created_at,
               al.name AS ledger_name, cb.name AS cash_bank_name,
               emp.name AS created_by_name,
               COALESCE(w.name, o.name) AS location_name
        FROM expenses e
        LEFT JOIN account_ledgers    al  ON al.id  = e.ledger_account_id
        LEFT JOIN cash_bank_accounts cb  ON cb.id  = e.payment_account_id
        LEFT JOIN employees          emp ON emp.id = e.created_by
        LEFT JOIN warehouses w ON e.location_type = 'warehouse' AND w.id = e.location_id
        LEFT JOIN outlets    o ON e.location_type = 'outlet'    AND o.id = e.location_id
        WHERE e.id = $1`, [id]);
      if (!r) { res.status(404).json({ error: "Expense not found" }); return; }
      v = {
        voucherNumber: r.expense_number ?? `EXP-${r.id}`,
        expenseDate: r.expense_date,
        amount: Number(r.amount),
        category: r.category ?? null,
        description: r.description ?? null,
        expenseLedgerName: r.ledger_name ?? "",
        paidFromName: r.cash_bank_name ?? "",
        paidFromLabel: "Paid From",
        locationName: r.location_name ?? "Head Office",
        recordedBy: r.created_by_name ?? null,
        recordedAt: r.created_at ?? null,
        attachmentUrl: r.attachment_url ?? null,
        ownerType: r.location_type ?? "headoffice",
        ownerId: r.location_id ?? null,
      };
    } else {
      const { rows: [r] } = await pool.query<any>(`
        SELECT p.id, p.voucher_number, p.payment_date, p.amount, p.narration,
               p.expense_category, p.attachment_url, p.created_at,
               pt.name AS expense_name, pf.name AS cash_name,
               COALESCE(w.name, o.name) AS location_name,
               CASE WHEN w.id IS NOT NULL THEN 'warehouse'
                    WHEN o.id IS NOT NULL THEN 'outlet' END AS owner_type,
               COALESCE(w.id, o.id) AS owner_id
        FROM payments p
        LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
        LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
        LEFT JOIN warehouses w ON w.cash_ledger_id = p.paid_from_ledger_id
        LEFT JOIN outlets    o ON o.cash_ledger_id = p.paid_from_ledger_id
        WHERE p.id = $1`, [id]);
      if (!r) { res.status(404).json({ error: "Expense not found" }); return; }
      v = {
        voucherNumber: r.voucher_number ?? `PAY-${r.id}`,
        expenseDate: r.payment_date,
        amount: Number(r.amount),
        category: r.expense_category ?? null,
        description: r.narration ?? null,
        expenseLedgerName: r.expense_name ?? "",
        paidFromName: r.cash_name ?? "",
        paidFromLabel: "Paid From (Cash)",
        locationName: r.location_name ?? "—",
        recordedBy: null,
        recordedAt: r.created_at ?? null,
        attachmentUrl: r.attachment_url ?? null,
        ownerType: r.owner_type ?? null,
        ownerId: r.owner_id != null ? Number(r.owner_id) : null,
      };
    }

    // A branch user may only print a voucher for its own location.
    if (!isHO && emp) {
      if (v.ownerType !== emp.branchType || Number(v.ownerId) !== Number(emp.branchId)) {
        res.status(403).json({ error: "Access denied: you may only print your own location's vouchers" });
        return;
      }
    }

    // Letterhead = the spending location's identity (company as fallback).
    const expIssuer = await resolveLocationIssuer(
      pool,
      v.ownerType === "warehouse" ? "warehouse" : v.ownerType === "outlet" ? "outlet" : null,
      v.ownerId != null ? Number(v.ownerId) : null,
    );
    const buffer = await generateExpenseVoucherPdf({ ...v, issuer: expIssuer, logoDataUrl: expIssuer.logoUrl });
    const safe = String(v.voucherNumber).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Voucher-${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] expense voucher error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Receipt / Payment voucher ─────────────────────────────────────────────────
// Assembled from the stored row only — a voucher is an accounting document, so
// it must state what the books hold and nothing else. Visibility follows the
// exact same LBAC rule as the register lists (ledger-leg scope), so a branch
// user can print precisely the vouchers they can see, and a voucher outside
// their scope is a 404, not a hint that it exists.
router.post("/pdf/money-voucher", (req, res, next) => {
  // The download right is checked against the SPECIFIC voucher kind: a role
  // holding only the Receipt Voucher page must not print payments through this
  // shared route (Accounts › Vouchers remains an any-kind override).
  const kind = String(req.body?.kind ?? "");
  if (kind !== "receipt" && kind !== "payment") {
    res.status(400).json({ error: "kind must be 'receipt' or 'payment'" }); return;
  }
  const kindKey = kind === "receipt"
    ? "page:/operations/receipt-voucher" : "page:/operations/payment-voucher";
  requireModuleAction(["page:/accounts/vouchers", kindKey], "download")(req, res, next);
}, async (req, res) => {
  try {
    // Validated by the guard middleware above.
    const kind = String(req.body?.kind) as "receipt" | "payment";
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id is required" }); return;
    }

    const scope = ownLocationScope((req as any).employee);
    const ledgerIds = await scopeLedgerIds(scope);
    const params: unknown[] = [];

    let row: any;
    if (kind === "payment") {
      let where = scopeMoneyWhere(scope, ledgerIds, params, "p", ["paid_from_ledger_id", "paid_to_ledger_id"]);
      params.push(id);
      const { rows: [r] } = await pool.query<any>(`
        SELECT p.voucher_number, p.payment_date AS voucher_date, p.amount, p.narration,
               p.reference_number, p.created_by, p.created_at,
               p.location_type, p.location_id,
               pf.name AS cash_bank_name, pt.name AS party_name,
               COALESCE(w.name, o.name) AS location_name
          FROM payments p
          LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
          LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
          LEFT JOIN warehouses w ON p.location_type = 'warehouse' AND w.id = p.location_id
          LEFT JOIN outlets    o ON p.location_type = 'outlet'    AND o.id = p.location_id
         WHERE (${where}) AND p.id = $${params.length}`, params);
      row = r;
    } else {
      let where = scopeMoneyWhere(scope, ledgerIds, params, "p", ["received_in_ledger_id", "received_from_ledger_id"]);
      params.push(id);
      const { rows: [r] } = await pool.query<any>(`
        SELECT p.voucher_number, p.receipt_date AS voucher_date, p.amount, p.narration,
               p.reference_number, p.created_by, p.created_at,
               p.location_type, p.location_id,
               ri.name AS cash_bank_name, rf.name AS party_name,
               COALESCE(w.name, o.name) AS location_name
          FROM receipts p
          LEFT JOIN account_ledgers ri ON ri.id = p.received_in_ledger_id
          LEFT JOIN account_ledgers rf ON rf.id = p.received_from_ledger_id
          LEFT JOIN warehouses w ON p.location_type = 'warehouse' AND w.id = p.location_id
          LEFT JOIN outlets    o ON p.location_type = 'outlet'    AND o.id = p.location_id
         WHERE (${where}) AND p.id = $${params.length}`, params);
      row = r;
    }
    if (!row) { res.status(404).json({ error: "Voucher not found" }); return; }

    // The letterhead is the ISSUING LOCATION — same resolution as the invoice
    // seller, with company settings only as the resolver's own fallback.
    const locType = row.location_type === "warehouse" ? "warehouse"
      : row.location_type === "outlet" ? "outlet" : null;
    const issuer = await resolveLocationIssuer(
      pool, locType, row.location_id != null ? Number(row.location_id) : null,
    );

    const buffer = await generateMoneyVoucherPdf({
      kind,
      issuer,
      // The issuer's own logo (its location's, else the company's).
      logoDataUrl: issuer.logoUrl,
      voucherNumber: row.voucher_number ?? "—",
      voucherDate: row.voucher_date,
      amount: Number(row.amount),
      partyName: row.party_name ?? "",
      cashBankName: row.cash_bank_name ?? "",
      referenceNumber: row.reference_number ?? null,
      narration: row.narration ?? null,
      locationName: row.location_name ?? "Head Office",
      recordedBy: row.created_by ?? null,
      recordedAt: row.created_at ?? null,
    });
    const safe = String(row.voucher_number ?? id).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Voucher-${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] money voucher error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Employee advance voucher ─────────────────────────────────────────────────
// Prints the BOOK ENTRY an advance actually made — the linked payment voucher
// (new flow) or the migration journal voucher (legacy) — never a bespoke
// client-composed sheet. Guarded on the HR Advances page; access follows the
// advances list's own rule (self-scoped unless the caller holds view-all at
// Head Office), NOT the money-ledger scope: an HR user may print the voucher
// behind an advance they may list, and nothing else through this route.
// NULL links fail closed.
router.post("/pdf/advance-voucher", requireModuleAction("page:/hr/advances", "download"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id is required" }); return; }

    const { rows: [adv] } = await pool.query<any>(`
      SELECT ea.*, e.name AS employee_name
        FROM employee_advances ea JOIN employees e ON e.id = ea.employee_id
       WHERE ea.id = $1`, [id]);
    if (!adv) { res.status(404).json({ error: "Advance not found" }); return; }

    // Mirror GET /hr/advances: self-scoped unless a Head Office caller holds
    // the page view right. Outside scope = 404, same as "does not exist".
    const emp = (req as any).employee as { id: number; branchType: string; hierarchyId: number } | undefined;
    if (emp) {
      const { hasModuleAction } = await import("../middleware/permissions");
      const canViewAll = await hasModuleAction(emp.hierarchyId, "page:/hr/advances", "view");
      if ((!canViewAll || emp.branchType !== "headoffice") && Number(adv.employee_id) !== Number(emp.id)) {
        res.status(404).json({ error: "Advance not found" }); return;
      }
    }

    if (adv.payment_voucher_id != null) {
      // New-flow advance: the linked PAYMENT voucher is the document.
      const { rows: [row] } = await pool.query<any>(`
        SELECT p.voucher_number, p.payment_date AS voucher_date, p.amount, p.narration,
               p.reference_number, p.created_by, p.created_at,
               p.location_type, p.location_id,
               pf.name AS cash_bank_name, pt.name AS party_name,
               COALESCE(w.name, o.name) AS location_name
          FROM payments p
          LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
          LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
          LEFT JOIN warehouses w ON p.location_type = 'warehouse' AND w.id = p.location_id
          LEFT JOIN outlets    o ON p.location_type = 'outlet'    AND o.id = p.location_id
         WHERE p.id = $1`, [adv.payment_voucher_id]);
      if (!row) { res.status(404).json({ error: "Linked voucher not found" }); return; }
      const issuer = await resolveLocationIssuer(
        pool,
        row.location_type === "warehouse" ? "warehouse" : row.location_type === "outlet" ? "outlet" : null,
        row.location_id != null ? Number(row.location_id) : null,
      );
      const buffer = await generateMoneyVoucherPdf({
        kind: "payment",
        issuer,
        logoDataUrl: issuer.logoUrl,
        voucherNumber: row.voucher_number ?? "—",
        voucherDate: row.voucher_date,
        amount: Number(row.amount),
        partyName: row.party_name ?? adv.employee_name ?? "",
        cashBankName: row.cash_bank_name ?? "",
        referenceNumber: row.reference_number ?? null,
        narration: row.narration ?? (adv.note ? `Advance to ${adv.employee_name}: ${adv.note}` : null),
        locationName: row.location_name ?? "Head Office",
        recordedBy: row.created_by ?? null,
        recordedAt: row.created_at ?? null,
      });
      const safe = String(row.voucher_number ?? id).replace(/[^A-Za-z0-9_-]+/g, "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="Advance-${safe}.pdf"`);
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
      return;
    }

    if (adv.migrated_voucher_id != null) {
      // Legacy advance: its balance was migrated by a journal voucher — that
      // JV is the only book entry this advance has.
      const { rows: [v] } = await pool.query<any>(`
        SELECT v.*, pl.name AS party_name,
               COALESCE(w.name, o.name) AS location_name
          FROM journal_vouchers v
          LEFT JOIN account_ledgers pl ON pl.id = v.party_ledger_id
          LEFT JOIN warehouses w ON v.location_type = 'warehouse' AND w.id = v.location_id
          LEFT JOIN outlets    o ON v.location_type = 'outlet'    AND o.id = v.location_id
         WHERE v.id = $1`, [adv.migrated_voucher_id]);
      const kind = String(v?.voucher_type ?? "") as JournalVoucherKind;
      if (!v || !["journal", "contra", "credit_note", "debit_note"].includes(kind)) {
        res.status(404).json({ error: "Linked voucher not found" }); return;
      }
      const { rows: lines } = await pool.query<any>(`
        SELECT l.debit, l.credit, al.name AS ledger_name, al.code AS ledger_code
          FROM journal_voucher_lines l
          LEFT JOIN account_ledgers al ON al.id = l.ledger_id
         WHERE l.voucher_id = $1 ORDER BY l.id`, [adv.migrated_voucher_id]);
      const issuer = await resolveLocationIssuer(
        pool,
        v.location_type === "warehouse" ? "warehouse" : v.location_type === "outlet" ? "outlet" : null,
        v.location_id != null ? Number(v.location_id) : null,
      );
      const buffer = await generateJournalVoucherPdf({
        kind,
        issuer,
        logoDataUrl: issuer.logoUrl,
        voucherNumber: v.voucher_number ?? "—",
        voucherDate: v.voucher_date,
        partyName: v.party_name ?? adv.employee_name ?? null,
        reason: v.reason ?? null,
        narration: v.narration ?? null,
        lines: lines.map((l) => ({
          ledgerName: l.ledger_name ?? "—",
          ledgerCode: l.ledger_code ?? null,
          debit: Number(l.debit),
          credit: Number(l.credit),
        })),
        locationName: v.location_name ?? (v.location_type === "headoffice" ? "Head Office" : null),
        recordedBy: v.created_by ?? null,
        recordedAt: v.created_at ?? null,
      });
      const safe = String(v.voucher_number ?? id).replace(/[^A-Za-z0-9_-]+/g, "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="Advance-${safe}.pdf"`);
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
      return;
    }

    // No link at all — fail closed rather than invent a document.
    res.status(404).json({ error: "No voucher is linked to this advance" });
  } catch (err) {
    console.error("[pdfGen] advance voucher error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Journal-family voucher (journal / contra / credit note / debit note) ─────
// The caller sends only the voucher id. The voucher row, its ledger legs and
// the issuing location's letterhead are all read back from the database, so
// the print can never disagree with the books. LBAC mirrors
// GET /accounts/journal-vouchers/:id — a branch user may only print vouchers
// stamped with their own location, and learns nothing about other ids (404).
router.post("/pdf/journal-voucher", requireModuleAction("page:/accounts/vouchers", "download"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id is required" }); return;
    }

    const { rows: [v] } = await pool.query<any>(`
      SELECT v.*, pl.name AS party_name,
             COALESCE(w.name, o.name) AS location_name
        FROM journal_vouchers v
        LEFT JOIN account_ledgers pl ON pl.id = v.party_ledger_id
        LEFT JOIN warehouses w ON v.location_type = 'warehouse' AND w.id = v.location_id
        LEFT JOIN outlets    o ON v.location_type = 'outlet'    AND o.id = v.location_id
       WHERE v.id = $1`, [id]);
    if (!v) { res.status(404).json({ error: "Voucher not found" }); return; }

    const kind = String(v.voucher_type) as JournalVoucherKind;
    if (!["journal", "contra", "credit_note", "debit_note"].includes(kind)) {
      // Receipts/payments print through /pdf/money-voucher.
      res.status(400).json({ error: "Not a journal-family voucher" }); return;
    }

    const employee = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    if (employee?.branchType && employee.branchType !== "headoffice") {
      const own = callerLocation(employee);
      if (v.location_type !== own.locationType || Number(v.location_id) !== Number(own.locationId)) {
        res.status(404).json({ error: "Voucher not found" });
        return;
      }
    }

    const { rows: lines } = await pool.query<any>(`
      SELECT l.debit, l.credit, al.name AS ledger_name, al.code AS ledger_code
        FROM journal_voucher_lines l
        LEFT JOIN account_ledgers al ON al.id = l.ledger_id
       WHERE l.voucher_id = $1 ORDER BY l.id`, [id]);

    // The letterhead is the ISSUING LOCATION — same resolution as the invoice
    // seller; 'headoffice'/unstamped vouchers fall through to the company.
    const locType = v.location_type === "warehouse" ? "warehouse"
      : v.location_type === "outlet" ? "outlet" : null;
    const issuer = await resolveLocationIssuer(
      pool, locType, v.location_id != null ? Number(v.location_id) : null,
    );

    const buffer = await generateJournalVoucherPdf({
      kind,
      issuer,
      logoDataUrl: issuer.logoUrl,
      voucherNumber: v.voucher_number ?? "—",
      voucherDate: v.voucher_date,
      partyName: v.party_name ?? null,
      reason: v.reason ?? null,
      narration: v.narration ?? null,
      lines: lines.map((l) => ({
        ledgerName: l.ledger_name ?? "—",
        ledgerCode: l.ledger_code ?? null,
        debit: Number(l.debit),
        credit: Number(l.credit),
      })),
      locationName: v.location_name ?? (v.location_type === "headoffice" ? "Head Office" : null),
      recordedBy: v.created_by ?? null,
      recordedAt: v.created_at ?? null,
    });
    const safe = String(v.voucher_number ?? id).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Voucher-${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] journal voucher error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Return notes (sales / purchase) ──────────────────────────────────────────
// The caller sends only the return id; every figure printed is the stored
// return row's own prorated money — never recomputed. LBAC mirrors the list
// endpoints: a sales return belongs to the location it was taken at, a
// purchase return to its bill's location; outside the caller's scope = 404.

/** True when the location is inside the caller's LBAC scope. */
function inScope(
  scope: { isHeadOffice: boolean; warehouseIds: number[]; outletIds: number[] },
  locType: string | null, locId: number | null,
): boolean {
  if (scope.isHeadOffice) return true;
  if (locType === "warehouse") return scope.warehouseIds.includes(Number(locId));
  if (locType === "outlet") return scope.outletIds.includes(Number(locId));
  return false;
}

router.post("/pdf/sales-return", requireModuleAction("page:/returns", "download"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id is required" }); return; }

    const { rows: [r] } = await pool.query<any>(`
      SELECT sr.*, s.invoice_number, c.name AS customer_name,
             jv.voucher_number AS note_number,
             COALESCE(w.name, o.name) AS location_name
        FROM sales_returns sr
        JOIN sales s ON s.id = sr.sale_id
        LEFT JOIN customers c ON c.id = sr.customer_id
        LEFT JOIN journal_vouchers jv ON jv.id = sr.credit_note_id
        LEFT JOIN warehouses w ON sr.location_type = 'warehouse' AND w.id = sr.location_id
        LEFT JOIN outlets    o ON sr.location_type = 'outlet'    AND o.id = sr.location_id
       WHERE sr.id = $1`, [id]);
    if (!r) { res.status(404).json({ error: "Return not found" }); return; }

    const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const scope = emp ? await getUserDataScope(emp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
    if (!inScope(scope, r.location_type, r.location_id)) {
      res.status(404).json({ error: "Return not found" }); return;
    }

    const issuer = await resolveLocationIssuer(
      pool,
      r.location_type === "warehouse" ? "warehouse" : r.location_type === "outlet" ? "outlet" : null,
      r.location_id != null ? Number(r.location_id) : null,
    );

    const lines = (Array.isArray(r.line_items) ? r.line_items : []).map((li: any) => ({
      name: li.itemName ?? "—",
      unit: li.unit ?? "",
      quantity: Number(li.quantity ?? 0),
      taxableAmount: Number(li.taxableAmount ?? 0),
      taxAmount: Number(li.taxAmount ?? 0),
      grossAmount: Number(li.grossAmount ?? 0),
    }));

    const buffer = await generateReturnNotePdf({
      kind: "sales",
      issuer,
      logoDataUrl: issuer.logoUrl,
      returnNumber: r.return_number ?? "—",
      returnDate: r.return_date,
      againstNumber: r.invoice_number ?? `Sale #${r.sale_id}`,
      noteNumber: r.note_number ?? null,
      refundMode: r.refund_mode ?? null,
      partyLabel: "Returned By",
      partyName: r.customer_name ?? "Walk-in Customer",
      reason: r.reason ?? null,
      lines,
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.tax_total),
      totalAmount: Number(r.total_amount),
      locationName: r.location_name ?? null,
      recordedBy: r.created_by ?? null,
      recordedAt: r.created_at ?? null,
    });
    const safe = String(r.return_number ?? id).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Return-${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] sales return error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

router.post("/pdf/purchase-return", requireModuleAction("page:/returns", "download"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "id is required" }); return; }

    const { rows: [r] } = await pool.query<any>(`
      SELECT pr.*, p.invoice_number, p.location_type, p.location_id,
             v.name AS vendor_name,
             jv.voucher_number AS note_number,
             COALESCE(w.name, o.name) AS location_name
        FROM purchase_returns pr
        JOIN purchases p ON p.id = pr.purchase_id
        LEFT JOIN vendors v ON v.id = pr.vendor_id
        LEFT JOIN journal_vouchers jv ON jv.id = pr.debit_note_id
        LEFT JOIN warehouses w ON p.location_type = 'warehouse' AND w.id = p.location_id
        LEFT JOIN outlets    o ON p.location_type = 'outlet'    AND o.id = p.location_id
       WHERE pr.id = $1`, [id]);
    if (!r) { res.status(404).json({ error: "Return not found" }); return; }

    const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const scope = emp ? await getUserDataScope(emp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
    if (!inScope(scope, r.location_type, r.location_id)) {
      res.status(404).json({ error: "Return not found" }); return;
    }

    const issuer = await resolveLocationIssuer(
      pool,
      r.location_type === "warehouse" ? "warehouse" : r.location_type === "outlet" ? "outlet" : null,
      r.location_id != null ? Number(r.location_id) : null,
    );

    const lines = (Array.isArray(r.line_items) ? r.line_items : []).map((li: any) => ({
      name: li.materialName ?? li.itemName ?? "—",
      unit: li.unit ?? "",
      quantity: Number(li.quantity ?? 0),
      taxableAmount: Number(li.taxableAmount ?? 0),
      taxAmount: Number(li.taxAmount ?? 0),
      grossAmount: Number(li.grossAmount ?? 0),
    }));

    const buffer = await generateReturnNotePdf({
      kind: "purchase",
      issuer,
      logoDataUrl: issuer.logoUrl,
      returnNumber: r.return_number ?? "—",
      returnDate: r.return_date,
      againstNumber: r.invoice_number ?? `PB #${r.purchase_id}`,
      noteNumber: r.note_number ?? null,
      refundMode: null,
      partyLabel: "Returned To",
      partyName: r.vendor_name ?? "—",
      reason: r.reason ?? null,
      lines,
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.tax_total),
      totalAmount: Number(r.total_amount),
      locationName: r.location_name ?? null,
      recordedBy: r.created_by ?? null,
      recordedAt: r.created_at ?? null,
    });
    const safe = String(r.return_number ?? id).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Return-${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] purchase return error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ── Payslip ───────────────────────────────────────────────────────────────────
// The caller sends only the payroll id. Everything printed is read back from the
// stored payroll row, so a slip can never disagree with the approved figures —
// and it stays correct after the statutory rates are changed, because the row
// holds the rates the run was computed with.
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function branchLabel(branchType?: string | null, branchId?: number | null): Promise<string> {
  if (!branchType || branchType === "headoffice") return "Head Office";
  const table = branchType === "warehouse" || branchType === "outlet" ? "warehouses" : null;
  if (!table || !branchId) return branchType;
  try {
    const { rows: [r] } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [branchId]);
    return r?.name ?? branchType;
  } catch { return branchType; }
}

router.post("/pdf/payslip", requireModuleAction("page:/hr/payroll", "download"), async (req, res) => {
  try {
    const payrollId = Number(req.body?.payrollId);
    if (!Number.isInteger(payrollId) || payrollId <= 0) {
      res.status(400).json({ error: "payrollId is required" });
      return;
    }

    const { rows: [pr] } = await pool.query(
      `SELECT pr.*, e.name AS employee_name, e.branch_type, e.branch_id, e.join_date, e.username
         FROM payroll pr JOIN employees e ON e.id = pr.employee_id
        WHERE pr.id = $1`,
      [payrollId],
    );
    if (!pr) { res.status(404).json({ error: "Payroll record not found" }); return; }

    // A non-Head-Office user may only download their own salary slip.
    const scope = (req as any).employee as { id: number; branchType: string } | undefined;
    if (scope && scope.branchType !== "headoffice" && scope.id !== Number(pr.employee_id)) {
      res.status(403).json({ error: "You can only download your own salary slip." });
      return;
    }

    const { rows: [cs] } = await pool.query<any>(
      `SELECT company_name, address, city, state, pincode, gst_number, phone, email, logo_url
         FROM company_settings ORDER BY id LIMIT 1`,
    ).catch(() => ({ rows: [undefined as any] }));

    const monthLabel = pr.pay_period_label
      || `${MONTH_LABELS[Number(pr.month) - 1] ?? pr.month} ${pr.year}`;

    const buffer = await generatePayslipPdf({
      cs: cs ? {
        companyName: cs.company_name ?? undefined,
        address: cs.address ?? undefined, city: cs.city ?? undefined,
        state: cs.state ?? undefined, pincode: cs.pincode ?? undefined,
        gstNumber: cs.gst_number ?? undefined,
        phone: cs.phone ?? undefined, email: cs.email ?? undefined,
        // Only an inline image can be drawn straight into the PDF. A stored
        // URL would need fetching, which this renderer deliberately does not do.
        logoDataUrl: typeof cs.logo_url === "string" && cs.logo_url.startsWith("data:image/")
          ? cs.logo_url : undefined,
      } : undefined,
      employeeName: pr.employee_name ?? `Employee #${pr.employee_id}`,
      employeeCode: pr.username ?? String(pr.employee_id),
      branchName: await branchLabel(pr.branch_type, pr.branch_id),
      joinDate: pr.join_date ?? null,
      monthLabel,
      workingDays:  Number(pr.working_days ?? 0),
      presentDays:  Number(pr.present_days ?? 0),
      lopDays:      Number(pr.lop_days ?? 0),
      lopDeduction: Number(pr.lop_deduction ?? 0),
      // NULL (pre-LOP-policy rows) must stay null — the payslip switches its
      // attendance tiles on it, and 0 would claim leave was tracked and unused.
      paidLeaveUsed:    pr.paid_leave_used    == null ? null : Number(pr.paid_leave_used),
      paidLeaveAllowed: pr.paid_leave_allowed == null ? null : Number(pr.paid_leave_allowed),
      baseSalary:   Number(pr.base_salary ?? 0),
      allowancesBreakdown: Array.isArray(pr.allowances_breakdown) ? pr.allowances_breakdown : [],
      deductionsBreakdown: Array.isArray(pr.deductions_breakdown) ? pr.deductions_breakdown : [],
      grossPay:   Number(pr.gross_pay ?? 0),
      deductions: Number(pr.deductions ?? 0),
      // net_pay is stored after advance recovery; the extra amount is added at
      // approval, so it belongs in the take-home figure too.
      netPay:     Number(pr.net_pay ?? 0) + Number(pr.extra_amount ?? 0),
      advanceDeduction: Number(pr.advance_deduction ?? 0),
      extraAmount: Number(pr.extra_amount ?? 0),
      extraNote:   pr.extra_note ?? null,
      pfEmployer:  Number(pr.pf_employer ?? 0),
      esiEmployer: Number(pr.esi_employer ?? 0),
      status:      pr.status ?? "draft",
      paidAmount:  Number(pr.paid_amount ?? 0),
      isPaid:      pr.status === "paid" || pr.is_paid === true,
      paidDate:    pr.paid_date ?? null,
    });

    const emp = String(pr.employee_name || "Employee").replace(/[^A-Za-z0-9_-]+/g, "-");
    const mon = String(monthLabel).replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Payslip-${emp}-${mon}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] payslip error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

export default router;
