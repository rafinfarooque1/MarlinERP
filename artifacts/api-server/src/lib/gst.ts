/** Valid Indian GST rate slabs. Item/material tax rates and purchase line
 *  GST rates must be one of these. */
export const GST_SLABS = [0, 5, 12, 18, 28];

export function isValidGstSlab(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && GST_SLABS.includes(n);
}

export const gstSlabErrorMessage = (v: unknown) =>
  `Invalid GST rate "${v}". Valid slabs: ${GST_SLABS.join("%, ")}%`;

/**
 * Per-line CGST/SGST/IGST heads with a fallback for legacy lines that carry
 * only `taxAmount` + `taxType` (no per-head split): 'igst'/'inter' puts the
 * whole amount on IGST, anything else splits it 50/50 CGST/SGST (matching how
 * computeLineTax/calcLineItems have always split intra-state tax).
 * Used by BOTH the ledger derivation and the GST report endpoints so the two
 * can never disagree on how a line's tax is classified.
 */
export function lineTaxHeads(li: any): { cgst: number; sgst: number; igst: number } {
  let cgst = Number(li?.cgst ?? 0), sgst = Number(li?.sgst ?? 0), igst = Number(li?.igst ?? 0);
  const taxAmount = Number(li?.taxAmount ?? 0);
  if (cgst + sgst + igst <= 0.004 && taxAmount > 0.004) {
    const t = String(li?.taxType ?? "").toLowerCase();
    if (t === "igst" || t === "inter") {
      igst = taxAmount;
    } else {
      cgst = Math.round((taxAmount / 2) * 100) / 100;
      sgst = Math.round((taxAmount - cgst) * 100) / 100;
    }
  }
  return { cgst, sgst, igst };
}

/** Ledger codes for the six GST ledgers seeded under Duty & Tax (STD-DTX). */
export const GST_LEDGER_CODES = {
  outputCgst: "STD-OUT-CGST",
  outputSgst: "STD-OUT-SGST",
  outputIgst: "STD-OUT-IGST",
  inputCgst: "STD-INP-CGST",
  inputSgst: "STD-INP-SGST",
  inputIgst: "STD-INP-IGST",
} as const;
