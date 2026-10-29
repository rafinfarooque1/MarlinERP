import { canShowLockingRateOverride } from '../src/lib/lockingRateOverride';

function assert(label: string, result: boolean): void {
  if (!result) throw new Error(`FAIL: ${label}`);
  process.stdout.write(`PASS: ${label}\n`);
}

assert('ordinary employee never sees the override checkbox', !canShowLockingRateOverride(false, true));
assert('unauthorized manager never sees the override checkbox', !canShowLockingRateOverride(false, true));
assert('Level-1 admin sees it when sale contains a locked item', canShowLockingRateOverride(true, true));
assert('Level-1 admin does not see it without a locked item', !canShowLockingRateOverride(true, false));
