/**
 * Canonical purchase-bill arithmetic.
 *
 * This module is imported by BOTH the API server (which is the authority that
 * persists the numbers) and the ERP web app (which previews them while the
 * user types). Sharing one implementation is the only way to guarantee the
 * requirement that "the figure on screen and the figure in the database are
 * identical" — two hand-written copies drift the moment either side is edited.
 *
 * Nothing here touches the database, express or react, so it stays importable
 * from a browser bundle, a node bundle and a plain `node --test` script alike.
 */

export type PriceMode = "exclusive" | "inclusive";
export type TaxType = "intra" | "inter";

export const PRICE_MODES: readonly PriceMode[] = ["exclusive", "inclusive"] as const;

/** Narrow an untrusted value to a rate mode, defaulting to the historical
 *  behaviour (every bill written before rate mode existed was GST-exclusive). */
export function asPriceMode(v: unknown): PriceMode {
  return String(v ?? "").trim().toLowerCase() === "inclusive" ? "inclusive" : "exclusive";
}

/** Narrow an untrusted value to a supply type. Accepts the ledger-side spellings
 *  ('igst'/'cgst_sgst') as well so a line read back out of an old bill maps. */
export function asTaxType(v: unknown): TaxType {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "inter" || s === "igst" ? "inter" : "intra";
}

/** Money rounding used at every step, on both sides of the wire: half-up to
 *  paise. Applied per line so the bill total is the sum of the numbers the user
 *  can actually see, never a more-precise figure that disagrees with them. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export interface PurchaseLineInput {
  quantity?: unknown;
  unitCost?: unknown;
  /** Discount as a percentage of the line's gross value. */
  discount?: unknown;
  gstRate?: unknown;
  taxType?: unknown;
  /** Per-line override; the bill-level mode is used when absent. */
  priceMode?: unknown;
}

export interface PurchaseLineAmounts {
  quantity: number;
  /** The rate exactly as keyed in — inclusive or exclusive of GST per priceMode. */
  unitCost: number;
  discount: number;
  gstRate: number;
  taxType: TaxType;
  priceMode: PriceMode;
  /** qty x rate, in the mode the rate was entered in. */
  lineSubtotal: number;
  discountAmt: number;
  /** lineSubtotal - discountAmt, still in the entered mode. */
  netAmount: number;
  /** GST-exclusive base. In inclusive mode this is the reverse-tax figure. */
  taxableValue: number;
  taxAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** taxableValue + taxAmount. In inclusive mode this equals netAmount. */
  lineTotal: number;
  /**
   * Inventory cost basis per unit: net of discount AND net of GST.
   *
   * GST on a purchase is recoverable input tax, not part of the cost of the
   * goods — the books already debit Purchases with the taxable value and the
   * input-GST ledgers with the tax. Valuing stock at the gross rate would put
   * tax into inventory and put the stock valuation permanently out of step
   * with the purchase ledger.
   */
  costPerUnit: number;
}

/**
 * Price one line.
 *
 * Order of operations (the same order a GST invoice prints in):
 *   gross    = qty x rate
 *   discount = gross x disc%
 *   net      = gross - discount
 * exclusive: taxable = net;                  tax = taxable x gst%
 * inclusive: taxable = net / (1 + gst%);     tax = net - taxable
 *
 * Inclusive is a reverse charge, NOT gst% of the gross: at 5%, 105 is 100
 * taxable + 5 tax, never 105 + 5.25.
 */
export function calcPurchaseLine(
  li: PurchaseLineInput,
  billPriceMode: PriceMode = "exclusive",
): PurchaseLineAmounts {
  const quantity = num(li.quantity);
  const unitCost = num(li.unitCost);
  const discount = num(li.discount);
  const gstRate = num(li.gstRate);
  const taxType = asTaxType(li.taxType);
  const priceMode = li.priceMode == null ? billPriceMode : asPriceMode(li.priceMode);

  const lineSubtotal = round2(quantity * unitCost);
  const discountAmt = round2((lineSubtotal * discount) / 100);
  const netAmount = round2(lineSubtotal - discountAmt);

  let taxableValue: number;
  let taxAmount: number;
  if (priceMode === "inclusive") {
    taxableValue = round2(netAmount / (1 + gstRate / 100));
    taxAmount = round2(netAmount - taxableValue);
  } else {
    taxableValue = netAmount;
    taxAmount = round2((taxableValue * gstRate) / 100);
  }

  // Split so the heads always re-add to taxAmount exactly: halving twice and
  // rounding each half leaves a paisa adrift on odd amounts.
  const intra = taxType === "intra";
  const cgst = intra ? round2(taxAmount / 2) : 0;
  const sgst = intra ? round2(taxAmount - cgst) : 0;
  const igst = intra ? 0 : taxAmount;

  const lineTotal = round2(taxableValue + taxAmount);
  const costPerUnit = quantity > 0 ? round2(taxableValue / quantity) : 0;

  return {
    quantity, unitCost, discount, gstRate, taxType, priceMode,
    lineSubtotal, discountAmt, netAmount,
    taxableValue, taxAmount, cgst, sgst, igst,
    lineTotal, costPerUnit,
  };
}

export interface PurchaseBillTotals {
  /** Sum of the line gross values, in the mode they were entered in. */
  subtotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  taxTotal: number;
  /** taxableTotal + taxTotal, before rupee rounding. */
  rawTotal: number;
  /** The rupee adjustment: totalAmount - rawTotal (can be negative). */
  roundOff: number;
  /** What the vendor is billed, rounded to whole rupees as the ERP has always done. */
  totalAmount: number;
}

export interface PurchaseBillAmounts<T extends PurchaseLineInput> extends PurchaseBillTotals {
  lines: Array<T & PurchaseLineAmounts>;
}

/** Price every line and foot the bill. Totals are sums of the per-line rounded
 *  figures, so the footer always equals the column above it. */
export function calcPurchaseBill<T extends PurchaseLineInput>(
  lines: readonly T[],
  billPriceMode: PriceMode = "exclusive",
): PurchaseBillAmounts<T> {
  const priced = (lines ?? []).map((li) => ({ ...li, ...calcPurchaseLine(li, billPriceMode) }));

  const sum = (pick: (l: PurchaseLineAmounts) => number) =>
    round2(priced.reduce((acc, l) => acc + pick(l), 0));

  const subtotal = sum((l) => l.lineSubtotal);
  const discountTotal = sum((l) => l.discountAmt);
  const taxableTotal = sum((l) => l.taxableValue);
  const cgstTotal = sum((l) => l.cgst);
  const sgstTotal = sum((l) => l.sgst);
  const igstTotal = sum((l) => l.igst);
  const taxTotal = sum((l) => l.taxAmount);

  const rawTotal = round2(taxableTotal + taxTotal);
  const totalAmount = Math.round(rawTotal);
  const roundOff = round2(totalAmount - rawTotal);

  return {
    lines: priced,
    subtotal, discountTotal, taxableTotal,
    cgstTotal, sgstTotal, igstTotal, taxTotal,
    rawTotal, roundOff, totalAmount,
  };
}
