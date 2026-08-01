/**
 * Returns true for ledgers that are auto-provisioned and module-owned, and so
 * must never appear in MANUAL voucher account pickers:
 *
 *  · Payroll (SAL-EMP-*, SAL-PAY-*, ADV-EMP-*) — salary payable and advances
 *    are discharged from the Payroll screen (which lets you choose the paying
 *    till/bank). Posting to them from a manual voucher would leave payroll's
 *    dues figure unaware of the payment and invite a double payment.
 *  · GST accounts (GST-*) — written only by the tax engine.
 *  · Inter-branch transfer ledgers (STD-BRANCH-*) and internal SYS-* nodes.
 *
 * Shared by the Payment, Receipt and Vouchers pages so the rule cannot drift
 * between screens.
 */
export function isSystemLedger(code?: string | null): boolean {
  if (!code) return false;
  const c = code.toUpperCase();
  return (
    c.startsWith('SYS-') ||
    c.startsWith('SAL-EMP-') ||
    c.startsWith('SAL-PAY-') ||
    c.startsWith('ADV-EMP-') ||
    c.startsWith('GST-') ||
    c.startsWith('STD-BRANCH-')
  );
}
