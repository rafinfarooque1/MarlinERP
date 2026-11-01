export interface LockingRateIssue {
  itemName: string;
  lockingRate: number;
  effectiveRate: number;
  difference: number;
}

/** Effective per-unit consideration after all allocated discounts, rounded like the API. */
export function effectiveSellingRate(
  quantity: number,
  saleRate: number,
  itemDiscount: number,
  billDiscountShare: number,
  couponPriceAdjustment: number,
): number {
  if (!(quantity > 0)) return saleRate;
  const totalDiscount = itemDiscount + billDiscountShare + couponPriceAdjustment;
  return Math.round(((quantity * saleRate - totalDiscount) / quantity) * 100) / 100;
}

/** Keep the UI threshold aligned with the server's paise tolerance. */
export function getLockingRateIssue(
  itemName: string,
  lockingRate: number | null | undefined,
  effectiveRate: number,
): LockingRateIssue | null {
  const floor = Number(lockingRate);
  if (lockingRate == null || !Number.isFinite(floor) || floor <= 0
      || !Number.isFinite(effectiveRate) || effectiveRate + 0.004 >= floor) {
    return null;
  }
  return {
    itemName,
    lockingRate: floor,
    effectiveRate,
    difference: Math.round((floor - effectiveRate) * 100) / 100,
  };
}
