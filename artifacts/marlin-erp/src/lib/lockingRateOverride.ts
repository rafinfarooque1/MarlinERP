/** The override control is available only to Level-1 admins with a locked item in the sale. */
export function canShowLockingRateOverride(isLevelOneAdmin: boolean, hasConfiguredLockingRate: boolean): boolean {
  return isLevelOneAdmin && hasConfiguredLockingRate;
}
