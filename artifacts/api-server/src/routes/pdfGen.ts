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
import { pool } from "@workspace/db";

/** Company header, read server-side so a document cannot be printed under a
 *  letterhead the caller made up. */
async function companyHeader(): Promise<any> {
  try {
    const { rows: [cs] } = await pool.query<any>(
      `SELECT company_name, address, city, state, pincode, gst_number, phone, email
         FROM company_settings ORDER BY id LIMIT 1`,
    );
    if (!cs) return undefined;
    return {
      companyName: cs.company_name ?? undefined,
      address: cs.address ?? undefined, city: cs.city ?? undefined,
      state: cs.state ?? undefined, pincode: cs.pincode ?? undefined,
      gstNumber: cs.gst_number ?? undefined,
      phone: cs.phone ?? undefined, email: cs.email ?? undefined,
    };
  } catch { return undefined; }
}

const router = Router();

// ── Delivery Challan ──────────────────────────────────────────────────────────
router.post("/pdf/challan", requireModuleAction("page:/transfers", "download"), async (req, res) => {
  try {
    const buffer = generateChallanPdf(req.body);
    const safe = (req.body.challanNo || "Challan").replace(/[^A-Za-z0-9_-]+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safe}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] challan error:", err);
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
router.post("/pdf/report", requireModuleAction("page:/reports/sales", "download"), async (req, res) => {
  try {
    const body = validateReportBody(req, res, "PDF");
    if (!body) return;

    // Company header comes from server-side settings — clients never send it.
    const { rows: [cs] } = await pool.query<any>(
      `SELECT company_name, address, city, state, pincode, gst_number, phone, email
       FROM company_settings ORDER BY id LIMIT 1`,
    ).catch(() => ({ rows: [undefined as any] }));

    const buffer = generateReportPdf({
      title: body.title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
      metaRows: Array.isArray(body.metaRows) ? (body.metaRows as [string, string][]) : undefined,
      orientation: body.orientation === "landscape" ? "landscape" : "portrait",
      sections: body.sections,
      footerNote: typeof body.footerNote === "string" ? body.footerNote : undefined,
      cs: cs ? {
        companyName: cs.company_name ?? undefined,
        address: cs.address ?? undefined,
        city: cs.city ?? undefined,
        state: cs.state ?? undefined,
        pincode: cs.pincode ?? undefined,
        gstNumber: cs.gst_number ?? undefined,
        phone: cs.phone ?? undefined,
        email: cs.email ?? undefined,
      } : undefined,
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
router.post("/xlsx/report", requireModuleAction("page:/reports/sales", "download"), async (req, res) => {
  try {
    const body = validateReportBody(req, res, "Excel");
    if (!body) return;

    const { rows: [cs] } = await pool.query<any>(
      `SELECT company_name, address, city, state, pincode, gst_number, phone, email
       FROM company_settings ORDER BY id LIMIT 1`,
    ).catch(() => ({ rows: [undefined as any] }));

    const buffer = await generateReportXlsx({
      title: body.title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle : undefined,
      metaRows: Array.isArray(body.metaRows) ? (body.metaRows as [string, string][]) : undefined,
      orientation: body.orientation === "landscape" ? "landscape" : "portrait",
      sections: body.sections,
      footerNote: typeof body.footerNote === "string" ? body.footerNote : undefined,
      cs: cs ? {
        companyName: cs.company_name ?? undefined,
        address: cs.address ?? undefined,
        city: cs.city ?? undefined,
        state: cs.state ?? undefined,
        pincode: cs.pincode ?? undefined,
        gstNumber: cs.gst_number ?? undefined,
        phone: cs.phone ?? undefined,
        email: cs.email ?? undefined,
      } : undefined,
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

    const buffer = generateExpenseVoucherPdf({ ...v, cs: await companyHeader() });
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
