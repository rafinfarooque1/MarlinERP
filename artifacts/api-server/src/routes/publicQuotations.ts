/**
 * Public (unauthenticated) quotation PDF endpoint.
 *
 * GET /api/public/quotations/:token[.pdf][?download=1]
 *
 * Mirrors /public/invoices/:token, but the token is signed in a DIFFERENT
 * HMAC context ("q.{id}.{exp}") — an invoice token can never open a quotation
 * and vice versa, even for the same numeric id.
 */
import { Router } from "express";
import { verifyQuotationShareToken } from "../lib/shareToken";
import { assembleQuotationData, renderInvoicePdf } from "../services/invoicePdf";

const router = Router();

router.get("/public/quotations/:token", async (req, res): Promise<void> => {
  const raw = String(Array.isArray(req.params.token) ? req.params.token[0] : req.params.token)
    .replace(/\.pdf$/i, "");

  const quotationId = verifyQuotationShareToken(raw);
  if (!quotationId) {
    res.status(404).type("text/plain").send("This quotation link is invalid or has expired.");
    return;
  }

  const data = await assembleQuotationData(quotationId);
  if (!data) {
    res.status(404).type("text/plain").send("Quotation not found.");
    return;
  }

  // Rendered fresh on every request — always reflects the latest saved quotation.
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
