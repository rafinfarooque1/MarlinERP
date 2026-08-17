/**
 * Client-side preview of the sale money math — mirrors the web POS
 * (marlin-erp Sales.tsx computeCartTotals) and therefore the server, so the
 * summary the cashier confirms matches the stored invoice to the paisa.
 * The server stays authoritative: it recomputes everything on save.
 *
 * Two pricing modes per line, exactly like the backend:
 *   taxable=false (default): price is the FINAL GST-inclusive figure —
 *     taxable value = gross / (1 + rate/100), tax extracted.
 *   taxable=true: price is the taxable BASE — GST added on top.
 *
 * The CGST/SGST/IGST split is deliberately NOT previewed here: the tax TOTAL
 * is identical either way, and the split needs the seller-state vs
 * customer-state rules the server owns (gst-place-of-supply).
 */

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Money entry: digits with at most 2 decimals ("120", "120.5", "120.50"). */
export function isMoneyString(s: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(s.trim());
}

/** Quantity entry: ≥ 1, up to 3 decimals (kg goods sell fractionally). */
export function isQtyString(s: string): boolean {
  if (!/^\d+(\.\d{1,3})?$/.test(s.trim())) return false;
  return Number(s) >= 1;
}

/** One cart line as the New Sale form holds it (inputs stay strings). */
export interface DraftLine {
  itemId: number;
  itemName: string;
  unit: string;
  /** GST rate from the item master. */
  taxRate: number;
  /** Item-master MRP — the price floor (0 = no floor). */
  mrp: number;
  quantity: string;
  unitPrice: string;
  /** Per-unit ₹ discount — ₹10 on qty 10 means ₹100 off the line. */
  unitDiscount: string;
  /** true → price is the taxable base (GST on top). */
  taxable: boolean;
}

export interface LineComputed {
  /** Post-item-discount, pre-bill-discount line value ("basis"). */
  basis: number;
  /** FINAL line value after the bill-discount share, incl. GST either mode. */
  lineGross: number;
  /** Taxable value of the line after all pre-tax discounts. */
  lineSubtotal: number;
  taxAmount: number;
}

export interface CartTotals {
  /** Σ qty × price before any discount. */
  grossItemValue: number;
  /** Σ per-unit discounts × qty. */
  itemDiscountTotal: number;
  /** Σ line bases — the cap for the bill discount. */
  basisSum: number;
  /** The ₹ bill discount actually applied (typed value capped at basisSum). */
  billDiscount: number;
  /** Σ taxable values. */
  subtotal: number;
  taxTotal: number;
  /** Goods + GST after item and bill discounts — the invoice total. */
  grandTotal: number;
  /** Aligned with the input lines — null where a line is not yet fillable
   * (no item, zero qty or zero price), so callers can index by position. */
  perLine: (LineComputed | null)[];
}

function lineGst(
  base: number,
  taxRate: number,
  taxableBase: boolean,
): { lineGross: number; lineSubtotal: number; taxAmount: number } {
  if (taxableBase) {
    const lineSubtotal = r2(base);
    const taxAmount = r2((lineSubtotal * taxRate) / 100);
    return { lineSubtotal, taxAmount, lineGross: r2(lineSubtotal + taxAmount) };
  }
  const lineGross = base;
  const lineSubtotal = taxRate > 0 ? r2(base / (1 + taxRate / 100)) : base;
  return { lineGross, lineSubtotal, taxAmount: r2(lineGross - lineSubtotal) };
}

/**
 * Mirror of the server's totals derivation:
 *  pass 1 — per-line item discounts and bases;
 *  pass 2 — allocate the ₹ bill discount across lines paise-exactly,
 *           proportional to bases (largest remainder);
 *  pass 3 — GST per line from the rounded post-discount value.
 */
export function computeCartTotals(lines: DraftLine[], billDiscountStr: string): CartTotals {
  const prepared: Array<{ taxRate: number; basis: number; taxable: boolean; lineIdx: number }> = [];
  let grossItemValue = 0;
  let itemDiscountTotal = 0;

  lines.forEach((l, lineIdx) => {
    const qty = Number(l.quantity) || 0;
    const price = Number(l.unitPrice) || 0;
    if (!l.itemId || qty <= 0 || price <= 0) return;
    const unitDisc = Math.min(Math.max(0, Number(l.unitDiscount) || 0), price);
    const itemDisc = r2(unitDisc * qty);
    grossItemValue += r2(qty * price);
    itemDiscountTotal += itemDisc;
    prepared.push({
      taxRate: Number(l.taxRate) || 0,
      basis: Math.max(0, r2(qty * price - itemDisc)),
      taxable: !!l.taxable,
      lineIdx,
    });
  });

  const basisSum = r2(prepared.reduce((s, p) => s + p.basis, 0));
  const typed = Math.max(0, Number(billDiscountStr) || 0);
  const billDiscount = Math.min(r2(typed), basisSum);

  // Paise-exact largest-remainder allocation, identical to the server's.
  const basePaise = prepared.map(p => Math.max(0, Math.round(p.basis * 100)));
  const weightSum = basePaise.reduce((s, b) => s + b, 0);
  const totalPaise = Math.round(billDiscount * 100);
  let shares = prepared.map(() => 0);
  if (totalPaise > 0 && weightSum > 0) {
    const raw = basePaise.map(b => (totalPaise * b) / weightSum);
    const floors = raw.map(Math.floor);
    let rem = totalPaise - floors.reduce((s, f) => s + f, 0);
    const order = raw
      .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
      .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
    for (const { idx } of order) {
      if (rem <= 0) break;
      if (floors[idx] < basePaise[idx]) { floors[idx] += 1; rem -= 1; }
    }
    shares = floors.map(f => f / 100);
  }

  let subtotal = 0;
  let taxTotal = 0;
  let grandTotal = 0;
  const perLine: (LineComputed | null)[] = lines.map(() => null);
  prepared.forEach((p, k) => {
    // Round BEFORE the tax math — with fractional quantities an unrounded
    // base keeps sub-paisa fractions and drifts off the persisted invoice.
    const adjusted = r2(p.basis - shares[k]);
    const g = lineGst(adjusted, p.taxRate, p.taxable);
    subtotal += g.lineSubtotal;
    taxTotal += g.taxAmount;
    grandTotal += g.lineGross;
    perLine[p.lineIdx] = { basis: p.basis, ...g };
  });

  return {
    grossItemValue: r2(grossItemValue),
    itemDiscountTotal: r2(itemDiscountTotal),
    basisSum,
    billDiscount,
    subtotal: r2(subtotal),
    taxTotal: r2(taxTotal),
    grandTotal: r2(grandTotal),
    perLine,
  };
}

/** Stable idempotency key for the sale submit — one per logical intent,
 * unchanged across the credit-limit / overpayment confirmation retries. */
export function newRequestId(): string {
  const c = (globalThis as any).crypto;
  return c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
