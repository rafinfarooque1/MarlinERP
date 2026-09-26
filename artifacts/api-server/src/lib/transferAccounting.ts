/**
 * Stable chart codes for the taxable-value legs of an inter-branch transfer.
 *
 * The GST output/input heads remain separate from the inter-branch payable.
 * These two ledgers carry only the taxable stock value:
 *   dispatch: Cr Transfer-Out
 *   receipt:  Dr Transfer-In
 *
 * A complete transfer therefore has no net P&L effect, while each location's
 * books still show the purchase-like inward cost and the matching outward
 * offset.
 */
export const TRANSFER_IN_LEDGER_CODE = "STD-TRF-IN";
export const TRANSFER_OUT_LEDGER_CODE = "STD-TRF-OUT";

export interface TransferLocationIdentity {
  locationType: string;
  locationId: number;
}

export type TransferPairPostingTarget = "pair" | "clearing";

export function transferLocationCodePart(location: TransferLocationIdentity): string {
  const type = String(location.locationType).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${type}-${Number(location.locationId ?? 0)}`;
}

export function canonicalTransferLocationPair(
  fromLocation: TransferLocationIdentity,
  toLocation: TransferLocationIdentity,
): { first: TransferLocationIdentity; second: TransferLocationIdentity; isForward: boolean } {
  const isForward = transferLocationCodePart(fromLocation) <= transferLocationCodePart(toLocation);
  return {
    first: isForward ? fromLocation : toLocation,
    second: isForward ? toLocation : fromLocation,
    isForward,
  };
}

/** Stable system code for one undirected warehouse/branch pair. */
export function interBranchTransferLedgerCode(
  fromLocation: TransferLocationIdentity,
  toLocation: TransferLocationIdentity,
): string {
  const pair = canonicalTransferLocationPair(fromLocation, toLocation);
  return `STD-BRANCH-NET-${transferLocationCodePart(pair.first)}-${transferLocationCodePart(pair.second)}`;
}

/** Old directed codes are retained only to migrate existing ledger balances. */
export function legacyInterBranchTransferLedgerCode(
  side: "receivable" | "payable",
  fromLocation: TransferLocationIdentity,
  toLocation: TransferLocationIdentity,
): string {
  const sideCode = side === "receivable" ? "DR" : "CR";
  return `STD-BRANCH-${sideCode}-${transferLocationCodePart(fromLocation)}-${transferLocationCodePart(toLocation)}`;
}

/**
 * Use both sides of the balanced transfer documents, but assign only one side
 * to the pair ledger. The opposite side goes to the shared liability clearing
 * ledger, leaving the pair ledger with the net bilateral position.
 */
export function transferPairPostingTargets(
  fromLocation: TransferLocationIdentity,
  toLocation: TransferLocationIdentity,
): { dispatch: TransferPairPostingTarget; receive: TransferPairPostingTarget } {
  return canonicalTransferLocationPair(fromLocation, toLocation).isForward
    ? { dispatch: "clearing", receive: "pair" }
    : { dispatch: "pair", receive: "clearing" };
}
