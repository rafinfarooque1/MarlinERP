/**
 * Dev-only harness: render invoice PDFs straight from the service.
 *
 * Exercises the exact code path every channel uses (preview, download,
 * WhatsApp) without going through HTTP auth, so a layout change can be checked
 * against real sales in a couple of seconds.
 *
 *   node scripts/build-harness.mjs scripts/render-invoice.ts /tmp/harness.mjs
 *   node /tmp/harness.mjs 13 11          # real sales, as stored
 *   node /tmp/harness.mjs --matrix       # the payment/tax/overflow matrix
 *
 * The matrix mutates the assembled data in memory and never writes to the
 * database: the cases it needs (part-paid, cancelled, inter-state, twenty long
 * line items) would otherwise mean inventing sales and the accounting entries
 * that come with them.
 */
import { writeFileSync } from "node:fs";
import {
  assembleInvoiceData, renderInvoicePdf, type InvoiceData,
} from "../src/services/invoicePdf";
import { computePaymentPosition, buildUpiRequest } from "../src/lib/salePaymentPosition";

/** Re-derive the position and the UPI request together — they must agree. */
function settle(d: InvoiceData, received: number): void {
  d.position = computePaymentPosition({
    totalAmount: d.sale.totalAmount,
    amountReceived: received,
    creditAdjustments: 0,
    cancelledAt: d.sale.cancelledAt,
  });
  d.upiRequest = buildUpiRequest({
    position: d.position,
    upiId: d.issuer.upiId,
    payeeName: d.issuer.tradeName,
    reference: d.sale.invoiceNumber ?? String(d.sale.id),
  });
  if (received <= 0) d.recordedPayments = [];
}

const LONG_NAME =
  "Premium Alphonso Mango Pulp — Individually Quick Frozen, Grade A Export Select, 1kg Vacuum Pack (Seasonal Harvest 2026)";

const SCENARIOS: Record<string, { sale: number; apply: (d: InvoiceData) => void }> = {
  "unpaid-full-bank": {
    sale: 13,
    apply: d => settle(d, 0),
  },
  "partial-full-bank": {
    sale: 13,
    apply: d => settle(d, 40),
  },
  "cancelled": {
    sale: 13,
    apply: d => { d.sale.cancelledAt = "2026-07-30T00:00:00.000Z"; settle(d, 0); },
  },
  "igst-interstate": {
    sale: 13,
    apply: d => {
      for (const li of d.sale.lineItems) {
        li.taxType = "igst";
        li.igst = (li.cgst ?? 0) + (li.sgst ?? 0);
        li.cgst = 0; li.sgst = 0;
      }
      settle(d, 0);
    },
  },
  "no-bank-no-upi": {
    sale: 13,
    apply: d => { d.issuer.bank = null; d.issuer.upiId = ""; settle(d, 0); },
  },
  "no-upi-bank-only": {
    sale: 13,
    apply: d => { d.issuer.upiId = ""; settle(d, 0); },
  },
  "no-fssai": {
    sale: 13,
    apply: d => { d.issuer.fssai = ""; settle(d, 0); },
  },
  // Two GST slabs on one bill: the summary must show CGST 2.5% and CGST 6% as
  // separate rows, not one lump captioned with the first line's rate.
  "mixed-gst-rates": {
    sale: 13,
    apply: d => {
      const base = d.sale.lineItems[0];
      if (!base) return;
      const at = (rate: number) => {
        const taxable = Number(base.lineSubtotal ?? 0);
        const tax = Math.round(taxable * rate) / 100;
        return { ...base, taxRate: rate, taxAmount: tax, cgst: tax / 2, sgst: tax / 2, igst: 0, taxType: "intra" };
      };
      d.sale.lineItems = [at(5), at(12), { ...at(5), itemName: `${base.itemName} (second 5% line)` }];
      settle(d, 0);
    },
  },
  "long-item-names": {
    sale: 13,
    apply: d => {
      d.sale.lineItems = d.sale.lineItems.map(li => ({ ...li, itemName: LONG_NAME }));
      settle(d, 0);
    },
  },
  "multi-page": {
    sale: 13,
    apply: d => {
      const base = d.sale.lineItems[0];
      d.sale.lineItems = Array.from({ length: 26 }, (_, i) => ({
        ...base,
        itemName: i % 3 === 0 ? LONG_NAME : `${base?.itemName ?? "Item"} — variant ${i + 1}`,
        quantity: i + 1,
      }));
      settle(d, 0);
    },
  },
};

async function render(data: InvoiceData, tag: string): Promise<void> {
  const { buffer, fileName } = await renderInvoicePdf(data);
  const out = `/tmp/inv-${tag}.pdf`;
  writeFileSync(out, buffer);
  console.log(
    `${tag.padEnd(20)} -> ${out} (${String(buffer.length).padStart(6)} B) ${fileName}\n` +
    `${" ".repeat(22)}issuer=${data.issuer.source}#${data.issuer.locationId} "${data.issuer.tradeName}" ` +
    `gstin=${data.issuer.gstin || "-"} fssai=${data.issuer.fssai || "-"} ` +
    `bank=${data.issuer.bank ? data.issuer.bank.name : "none"} upi=${data.issuer.upiId || "-"} ` +
    `status=${data.position.status} outstanding=${data.position.outstanding} ` +
    `gaps=[${data.issuer.incomplete.join(",")}]`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--matrix") {
    for (const [tag, sc] of Object.entries(SCENARIOS)) {
      const data = await assembleInvoiceData(sc.sale);
      if (!data) { console.log(`${tag}: sale ${sc.sale} NOT FOUND`); continue; }
      sc.apply(data);
      await render(data, tag);
    }
    process.exit(0);
  }

  const ids = args.map(Number).filter(Number.isFinite);
  if (ids.length === 0) {
    console.error("usage: node /tmp/harness.mjs <saleId>... | --matrix");
    process.exit(1);
  }
  for (const id of ids) {
    const data = await assembleInvoiceData(id);
    if (!data) { console.log(`sale ${id}: NOT FOUND`); continue; }
    await render(data, String(id));
  }
  process.exit(0);
}

void main();
