/**
 * POST /api/pdf/challan  — generates a delivery-challan PDF and returns it inline.
 * POST /api/pdf/payslip  — generates a payslip PDF and returns it inline.
 *
 * Both endpoints require authentication (handled by global requireAuth middleware in app.ts).
 * The caller sends pre-assembled data as JSON; the server renders it with jsPDF.
 */
import { Router } from "express";
import { generateChallanPdf } from "../services/challanPdf";
import { generatePayslipPdf } from "../services/payslipPdf";
import { generateReportPdf, type ReportPdfInput } from "../services/reportPdf";
import { pool } from "@workspace/db";

const router = Router();

// ── Delivery Challan ──────────────────────────────────────────────────────────
router.post("/pdf/challan", async (req, res) => {
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

router.post("/pdf/report", async (req, res) => {
  try {
    const body = req.body as Partial<ReportPdfInput>;
    if (!body || typeof body.title !== "string" || !body.title.trim()) {
      res.status(400).json({ error: "title is required" }); return;
    }
    if (!Array.isArray(body.sections) || body.sections.length === 0) {
      res.status(400).json({ error: "at least one section is required" }); return;
    }
    let rowCount = 0;
    for (const s of body.sections) {
      if (!s || !Array.isArray(s.columns) || s.columns.length === 0 || !Array.isArray(s.rows)) {
        res.status(400).json({ error: "each section needs columns[] and rows[]" }); return;
      }
      rowCount += s.rows.length;
    }
    if (rowCount > MAX_REPORT_ROWS) {
      res.status(413).json({ error: `Report too large for PDF (${rowCount} rows, max ${MAX_REPORT_ROWS}). Narrow the date range or use CSV.` });
      return;
    }

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

// ── Payslip ───────────────────────────────────────────────────────────────────
router.post("/pdf/payslip", async (req, res) => {
  try {
    const buffer = generatePayslipPdf(req.body);
    const emp = (req.body.employeeName || "Employee").replace(/[^A-Za-z0-9_-]+/g, "-");
    const mon = (req.body.monthLabel   || "Payslip"  ).replace(/[^A-Za-z0-9_-]+/g, "-");
    const filename = `Payslip-${emp}-${mon}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error("[pdfGen] payslip error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

export default router;
