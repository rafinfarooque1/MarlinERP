/**
 * Canonical sale payment modes.
 *
 * The counter offers four ways to be paid:
 *   cash   — notes into the location's own cash box
 *   bank   — money that lands in a company bank account (card swipe, netbanking,
 *            NEFT/IMPS); settled at the counter but clears through the bank
 *   online — a named Online sub-ledger such as Swiggy, Zomato, or Blinkit
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
 * NOTE: this is NOT the create-time allowlist. A brand-new sale may use cash,
 * bank/UPI, or credit — see CREATE_SALE_PAYMENT_MODES below.
 */
export const ONLINE_PAYMENT_MODES = ["online", "swiggy", "zomato", "other_online"] as const;
export type OnlinePaymentMode = (typeof ONLINE_PAYMENT_MODES)[number];

export const SALE_PAYMENT_MODES = ["cash", "bank", "upi", ...ONLINE_PAYMENT_MODES, "credit"] as const;

/**
 * Modes a NEW sale may be created with. Credit is handled by the POS's
 * separate pay-later control; these are the four payment channels.
 */
export const CREATE_SALE_PAYMENT_MODES = ["cash", "upi", "bank", "online"] as const;

/** True when `mode` may be used to CREATE a new POS sale. */
export function isAllowedNewSaleMode(mode: string): boolean {
  // Credit remains accepted for older API clients; the POS exposes it through
  // its separate pay-later control rather than the channel selector.
  return mode === "credit" || (CREATE_SALE_PAYMENT_MODES as readonly string[]).includes(mode);
}

/** Modes that are fully settled the moment the sale is recorded. */
export const SETTLED_PAYMENT_MODES = ["cash", "bank", "upi", "online", "card"] as const;

/** Legacy stored values that mean "bank". */
export const LEGACY_BANK_MODES = ["card", "bank_transfer"] as const;

/** Modes accepted when recording a collection against an existing sale. */
export const COLLECTION_METHODS = [
  "cash", "bank", "upi", ...ONLINE_PAYMENT_MODES, "card", "bank_transfer", "other",
] as const;

/** True when a mode is settled at the counter (i.e. not 'credit'). */
export function isSettledAtSale(mode: string): boolean {
  return (SETTLED_PAYMENT_MODES as readonly string[]).includes(mode)
    || (ONLINE_PAYMENT_MODES as readonly string[]).includes(mode)
    || (LEGACY_BANK_MODES as readonly string[]).includes(mode);
}

/** True when the money clears through a bank rather than the cash box. */
/** 'bank' and the older spellings that mean exactly the same thing. */
export function isBankFamily(mode: string): boolean {
  return mode === "bank" || (LEGACY_BANK_MODES as readonly string[]).includes(mode);
}

/** Online aggregators clear through the electronic clearing ledger. */
export function isOnlinePaymentMode(mode: string): boolean {
  return (ONLINE_PAYMENT_MODES as readonly string[]).includes(mode);
}

/**
 * The mode an EDIT should actually store.
 *
 * A new sale may use cash, bank/UPI, or credit, but an existing sale can also
 * be reassigned to any current mode during an edit. 'card' and 'bank_transfer'
 * are historical spellings of 'bank' and every client displays all three as
 * "Bank", so a canonical Bank selection against one of those stored values
 * keeps the STORED spelling because reconciliation rows point at it.
 *
 * Returns the mode to persist, or ok:false when this is a real attempt to move
 * a sale into a mode it may not have.
 */
export function resolveEditedSaleMode(
  submitted: string,
  stored: string,
): { ok: true; mode: string } | { ok: false } {
  if (submitted === stored) return { ok: true, mode: stored };
  if (isBankFamily(submitted) && isBankFamily(stored)) return { ok: true, mode: stored };
  if ((SALE_PAYMENT_MODES as readonly string[]).includes(submitted)) {
    return { ok: true, mode: submitted };
  }
  return { ok: false };
}

export function clearsThroughBank(mode: string): boolean {
  return mode === "bank" || mode === "upi"
    || isOnlinePaymentMode(mode)
    || (LEGACY_BANK_MODES as readonly string[]).includes(mode);
}

/** Human label for any stored mode, mapping legacy values onto the new names. */
export function paymentModeLabel(mode: string | null | undefined): string {
  switch ((mode ?? "").toLowerCase()) {
    case "cash": return "Cash";
    case "upi": return "UPI";
    case "online": return "Online";
    case "swiggy": return "Online";
    case "zomato": return "Online";
    case "other_online": return "Online";
    case "bank":
    case "card":
    case "bank_transfer": return "Bank";
    case "credit": return "Credit";
    case "advance": return "Advance";
    case "other": return "Other";
    default: return mode ? mode.replace(/_/g, " ").toUpperCase() : "";
  }
}
