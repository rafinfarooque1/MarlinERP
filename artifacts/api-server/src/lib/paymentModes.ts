/**
 * Canonical sale payment modes.
 *
 * The counter offers four ways to be paid:
 *   cash   — notes into the location's own cash box
 *   bank   — money that lands in a company bank account (card swipe, netbanking,
 *            NEFT/IMPS); settled at the counter but clears through the bank
 *   upi    — same as bank in accounting terms, kept separate because operators
 *            reconcile UPI collections against the UPI ID on the invoice
 *   credit — pay later; the only mode that creates a receivable and the only one
 *            subject to credit-limit control
 *
 * Historical rows carry 'card' and 'bank_transfer' from before this list was
 * settled. They mean exactly what 'bank' means now, so they are still accepted
 * on read/edit and are DISPLAYED as "Bank" — the stored value is never rewritten,
 * because reconciliation records already reference it.
 */

/** Modes a new sale may be created with. */
export const SALE_PAYMENT_MODES = ["cash", "bank", "upi", "credit"] as const;

/** Modes that are fully settled the moment the sale is recorded. */
export const SETTLED_PAYMENT_MODES = ["cash", "bank", "upi", "card"] as const;

/** Legacy stored values that mean "bank". */
export const LEGACY_BANK_MODES = ["card", "bank_transfer"] as const;

/** Modes accepted when recording a collection against an existing sale. */
export const COLLECTION_METHODS = [
  "cash", "bank", "upi", "card", "bank_transfer", "other",
] as const;

/** True when a mode is settled at the counter (i.e. not 'credit'). */
export function isSettledAtSale(mode: string): boolean {
  return (SETTLED_PAYMENT_MODES as readonly string[]).includes(mode)
    || (LEGACY_BANK_MODES as readonly string[]).includes(mode);
}

/** True when the money clears through a bank rather than the cash box. */
export function clearsThroughBank(mode: string): boolean {
  return mode === "bank" || mode === "upi"
    || (LEGACY_BANK_MODES as readonly string[]).includes(mode);
}

/** Human label for any stored mode, mapping legacy values onto the new names. */
export function paymentModeLabel(mode: string | null | undefined): string {
  switch ((mode ?? "").toLowerCase()) {
    case "cash": return "Cash";
    case "upi": return "UPI";
    case "bank":
    case "card":
    case "bank_transfer": return "Bank";
    case "credit": return "Credit";
    case "other": return "Other";
    default: return mode ? mode.replace(/_/g, " ").toUpperCase() : "";
  }
}
