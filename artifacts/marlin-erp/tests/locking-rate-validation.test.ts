import { effectiveSellingRate, getLockingRateIssue } from '../src/lib/lockingRateValidation';

function assert(label: string, value: boolean): void {
  if (!value) throw new Error(`FAIL: ${label}`);
  process.stdout.write(`PASS: ${label}\n`);
}

const discountedExample = effectiveSellingRate(1, 330, 40, 0, 0);
assert('rate 330 less per-unit discount 40 evaluates to 290', discountedExample === 290);
assert('rate above the Locking Rate has no warning', getLockingRateIssue('Mango Slice', 300, 330) === null);
assert('rate exactly at the Locking Rate has no warning', getLockingRateIssue('Mango Slice', 300, 300) === null);
const belowFloor = getLockingRateIssue('Mango Slice', 300, discountedExample);
assert('discounted rate below the Locking Rate is flagged', belowFloor?.effectiveRate === 290);
assert('warning reports shortfall and item identity', belowFloor?.itemName === 'Mango Slice' && belowFloor.difference === 10);

const lines = [
  { name: 'Mango Slice', floor: 300, effective: 290 },
  { name: 'Blueberry', floor: 250, effective: 250 },
  { name: 'Strawberry', floor: 400, effective: 350 },
].map(line => getLockingRateIssue(line.name, line.floor, line.effective)).filter(Boolean);
assert('multiple below-floor items are reported independently', lines.length === 2
  && lines[0]?.itemName === 'Mango Slice' && lines[1]?.itemName === 'Strawberry');

assert('bill and coupon allocations contribute to effective unit rate',
  effectiveSellingRate(2, 330, 40, 10, 5) === 302.5);
