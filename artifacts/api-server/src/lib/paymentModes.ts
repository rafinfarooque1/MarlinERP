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

/**
 * Every mode a sale row may legitimately hold. Kept as the FULL canonical list
 * so historical bank/upi/card/bank_transfer sales still read, print, post and
 * (when their mode is left unchanged) edit exactly as before.
 *
 * NOTE: this is NOT the create-time allowlist. A brand-new sale may only be
 * cash or credit — see CREATE_SALE_PAYMENT_MODES / isAllowedNewSaleMode below.
 */
export const SALE_PAYMENT_MODES = ["cash", "bank", "upi", "credit"] as const;

/**
 * Modes a NEW sale may be created with. If the customer is not paying cash on
 * the spot the invoice is raised on Credit and the money is collected later
 * through invoice/customer payment collection (which still accepts bank/upi —
 * see COLLECTION_METHODS). Bank and UPI are deliberately excluded here.
 */
export const CREATE_SALE_PAYMENT_MODES = ["cash", "credit"] as const;

/** True when `mode` may be used to CREATE a new sale (cash or credit only). */
export function isAllowedNewSaleMode(mode: string): boolean {
  return (CREATE_SALE_PAYMENT_MODES as readonly string[]).includes(mode);
}

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
/** 'bank' and the older spellings that mean exactly the same thing. */
export function isBankFamily(mode: string): boolean {
  return mode === "bank" || (LEGACY_BANK_MODES as readonly string[]).includes(mode);
}

/**
 * The mode an EDIT should actually store.
 *
 * A sale may only be created as cash or credit, and an edit must never turn a
 * sale INTO bank/upi. But 'card' and 'bank_transfer' are historical spellings
 * of 'bank' and every client displays all three as "Bank", so a client that
 * submits 'bank' while editing a stored 'card' sale is not changing anything —
 * rejecting it would make ordinary edits of old invoices impossible. Treat that
 * as unchanged and keep the STORED spelling: reconciliation rows already point
 * at it, so it must never be rewritten.
 *
 * Returns the mode to persist, or ok:false when this is a real attempt to move
 * a sale into a mode it may not have.
 */
export function resolveEditedSaleMode(
  submitted: string,
  stored: string,
): { ok: true; mode: string } | { ok: false } {
  if (isAllowedNewSaleMode(submitted)) return { ok: true, mode: submitted };
  if (submitted === stored) return { ok: true, mode: stored };
  if (isBankFamily(submitted) && isBankFamily(stored)) return { ok: true, mode: stored };
  return { ok: false };
}

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
    case "advance": return "Advance";
    case "other": return "Other";
    default: return mode ? mode.replace(/_/g, " ").toUpperCase() : "";
  }
}
