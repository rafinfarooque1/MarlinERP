/**
 * Payment-mode names and labels for the counter.
 *
 * The counter takes money four ways: Cash, Bank, UPI and Credit. 'bank' covers
 * every payment that lands in a company bank account — card swipe, netbanking,
 * NEFT/IMPS — and is settled the moment the sale is recorded, exactly like cash.
 * Only Credit creates a receivable.
 *
 * Older invoices are stored as 'card' or 'bank_transfer'. Those values mean
 * what 'bank' means now, so they are DISPLAYED as "Bank" and never rewritten:
 * reconciliation records already point at the stored value. Mirrors
 * api-server/src/lib/paymentModes.ts.
 */

export const SALE_PAYMENT_MODES = ['cash', 'bank', 'upi', 'credit'] as const;
export type SalePaymentMode = (typeof SALE_PAYMENT_MODES)[number];

/** Modes a collection against an existing bill can be recorded in. */
export const COLLECTION_METHODS = ['cash', 'bank', 'upi'] as const;

/** Stored values that predate the 'bank' name. */
const LEGACY_BANK_MODES = ['card', 'bank_transfer'];

/** Human label for any stored mode, mapping legacy values onto the new names. */
export function paymentModeLabel(mode: string | null | undefined): string {
  switch ((mode ?? '').toLowerCase()) {
    case 'cash': return 'Cash';
    case 'upi': return 'UPI';
    case 'bank':
    case 'card':
    case 'bank_transfer': return 'Bank';
    case 'credit': return 'Credit';
    case 'other': return 'Other';
    default: return mode ? mode.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  }
}

/** Emoji + label for pickers, so the POS reads at a glance. */
export const PAYMENT_MODE_OPTIONS: ReadonlyArray<{ value: SalePaymentMode; label: string }> = [
  { value: 'cash', label: '💵 Cash' },
  { value: 'bank', label: '🏦 Bank (card / netbanking / transfer)' },
  { value: 'upi', label: '📱 UPI' },
  { value: 'credit', label: '🕒 Credit (pay later)' },
];

/**
 * The mode an existing sale should show in an edit form. Legacy 'card' and
 * 'bank_transfer' rows collapse onto 'bank'; anything unrecognised falls back
 * to cash so the form always has a valid selection.
 */
export function editableSaleMode(mode: string | null | undefined): SalePaymentMode {
  const m = (mode ?? '').toLowerCase();
  if (LEGACY_BANK_MODES.includes(m)) return 'bank';
  return (SALE_PAYMENT_MODES as readonly string[]).includes(m) ? (m as SalePaymentMode) : 'cash';
}

/** True when the mode is settled at the counter (everything except credit). */
export function isSettledAtSale(mode: string | null | undefined): boolean {
  return editableSaleMode(mode) !== 'credit';
}
