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
