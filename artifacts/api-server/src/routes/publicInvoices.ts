/**
 * Public (unauthenticated) invoice PDF endpoint.
 *
 * GET /api/public/invoices/:token[.pdf][?download=1]
 *
 * The token is an HMAC-signed, time-limited share token created via
 * POST /api/sales/:id/share-token. Customers receiving a WhatsApp link
 * open this endpoint directly — no login, no exposure of internal IDs
 * beyond what the signed token authorizes.
 *
 * Responds with a standards-compliant PDF and correct headers:
 *   Content-Type: application/pdf
 *   Content-Disposition: inline|attachment; filename="Invoice-….pdf"
 */
import { Router } from "express";
import { verifyInvoiceShareToken } from "../lib/shareToken";
import { assembleInvoiceData, renderInvoicePdf } from "../services/invoicePdf";

const router = Router();

router.get("/public/invoices/:token", async (req, res): Promise<void> => {
  const raw = String(Array.isArray(req.params.token) ? req.params.token[0] : req.params.token)
    .replace(/\.pdf$/i, "");

  const saleId = verifyInvoiceShareToken(raw);
  if (!saleId) {
    res.status(404).type("text/plain").send("This invoice link is invalid or has expired.");
    return;
  }

  const data = await assembleInvoiceData(saleId);
  if (!data) {
    res.status(404).type("text/plain").send("Invoice not found.");
    return;
  }

  // Rendered fresh on every request — always reflects the latest saved invoice.
  const { buffer, fileName } = await renderInvoicePdf(data);
  const disposition = req.query.download ? "attachment" : "inline";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(buffer);
});

export default router;
