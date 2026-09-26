/**
 * Payment-mode names and labels for the counter.
 *
 * The counter takes money through Cash, Bank, named Online modes and Credit.
 * 'bank' covers
 * every payment that lands in a company bank account — card swipe, netbanking,
 * NEFT/IMPS — and is settled the moment the sale is recorded, exactly like cash.
 * Only Credit creates a receivable.
 *
 * Older invoices are stored as 'card' or 'bank_transfer'. Those values mean
 * what 'bank' means now, so they are DISPLAYED as "Bank" and never rewritten:
 * reconciliation records already point at the stored value. Mirrors
 * api-server/src/lib/paymentModes.ts.
 */

export const ONLINE_PAYMENT_MODES = ['online', 'swiggy', 'zomato', 'other_online'] as const;
export type OnlinePaymentMode = (typeof ONLINE_PAYMENT_MODES)[number];

export const SALE_PAYMENT_MODES = ['cash', 'bank', 'upi', ...ONLINE_PAYMENT_MODES, 'credit'] as const;
export type SalePaymentMode = (typeof SALE_PAYMENT_MODES)[number];

/**
 * Modes a NEW sale may be created with. The selected Cash & Bank account
 * derives the stored bank/upi method for the combined Bank / UPI choice.
 */
export const CREATE_SALE_PAYMENT_MODES = ['cash', 'upi', 'bank', 'online'] as const;

/** Modes a collection against an existing bill can be recorded in. */
export const COLLECTION_METHODS = ['cash', 'bank', 'upi', ...ONLINE_PAYMENT_MODES] as const;

/** Stored values that predate the 'bank' name. */
export const LEGACY_BANK_MODES = ['card', 'bank_transfer'] as const;

/**
 * Every value a sale's payment mode may already hold in the database: the four
 * current names plus the legacy spellings. An edit form must carry these
 * verbatim — collapsing a stored 'card' onto 'bank' and submitting that would
 * rewrite a value the reconciliation rows point at, and the API reads it as an
 * attempt to change the sale's mode and refuses the edit outright.
 */
export const STORED_SALE_MODES = ['cash', 'bank', 'upi', ...ONLINE_PAYMENT_MODES, 'credit', 'card', 'bank_transfer'] as const;
export type StoredSaleMode = (typeof STORED_SALE_MODES)[number];

/** The value an edit form should hold: the stored one, left exactly as it is. */
export function storedSaleMode(mode: string | null | undefined): StoredSaleMode {
  const m = (mode ?? '').toLowerCase();
  return (STORED_SALE_MODES as readonly string[]).includes(m) ? (m as StoredSaleMode) : 'cash';
}

/** Human label for any stored mode, mapping legacy values onto the new names. */
export function paymentModeLabel(mode: string | null | undefined): string {
  switch ((mode ?? '').toLowerCase()) {
    case 'cash': return 'Cash';
    case 'upi': return 'UPI';
    case 'online':
    case 'swiggy':
    case 'zomato':
    case 'other_online': return 'Online';
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
  { value: 'swiggy', label: '🛵 Swiggy' },
  { value: 'zomato', label: '🍽️ Zomato' },
  { value: 'other_online', label: '🌐 Other Online' },
  { value: 'credit', label: '🕒 Credit (pay later)' },
];

/**
 * Modes offered when RECORDING a new sale. Bank and UPI share one counter
 * choice; editing a historical bank/upi sale reuses the full picker above.
 */
export const CREATE_PAYMENT_MODE_OPTIONS: ReadonlyArray<{ value: SalePaymentMode; label: string }> = [
  { value: 'cash', label: '💵 Cash' },
  { value: 'upi', label: '📱 UPI' },
  { value: 'bank', label: '🏦 Bank' },
  { value: 'online', label: '🌐 Online' },
];

/**
 * The mode an existing sale should show in an edit form. Legacy 'card' and
 * 'bank_transfer' rows collapse onto 'bank'; anything unrecognised falls back
 * to cash so the form always has a valid selection.
 */
export function editableSaleMode(mode: string | null | undefined): SalePaymentMode {
  const m = (mode ?? '').toLowerCase();
  if ((LEGACY_BANK_MODES as readonly string[]).includes(m)) return 'bank';
  return (SALE_PAYMENT_MODES as readonly string[]).includes(m) ? (m as SalePaymentMode) : 'cash';
}

/** True when the mode is settled at the counter (everything except credit). */
export function isSettledAtSale(mode: string | null | undefined): boolean {
  return editableSaleMode(mode) !== 'credit';
}
