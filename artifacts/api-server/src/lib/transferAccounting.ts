/**
 * Stable chart codes for the taxable-value legs of an inter-branch transfer.
 *
 * The GST output/input heads and the inter-branch debtor/creditor remain
 * separate. These two ledgers carry only the taxable stock value:
 *   dispatch: Cr Transfer-Out
 *   receipt:  Dr Transfer-In
 *
 * A complete transfer therefore has no net P&L effect, while each location's
 * books still show the purchase-like inward cost and the matching outward
 * offset.
 */
export const TRANSFER_IN_LEDGER_CODE = "STD-TRF-IN";
export const TRANSFER_OUT_LEDGER_CODE = "STD-TRF-OUT";
