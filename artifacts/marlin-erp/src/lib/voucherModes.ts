/**
 * Payment-mode metadata for manual Receipt / Payment vouchers.
 *
 * These labels are DESCRIPTIVE only — the accounting posting is driven
 * entirely by the ledgers chosen on the voucher, never by this field. The
 * value list mirrors the server's MANUAL_VOUCHER_MODES; anything else is
 * rejected with a 400.
 */
export const VOUCHER_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank', label: 'Bank' },
  { value: 'card', label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'neft', label: 'NEFT' },
  { value: 'rtgs', label: 'RTGS' },
];

const LABELS: Record<string, string> = Object.fromEntries(
  VOUCHER_MODE_OPTIONS.map(o => [o.value, o.label]),
);

/** Human label for a stored mode; unknown/legacy values render as-is. */
export function voucherModeLabel(mode: string | null | undefined): string {
  if (!mode) return '';
  return LABELS[mode] ?? mode;
}
