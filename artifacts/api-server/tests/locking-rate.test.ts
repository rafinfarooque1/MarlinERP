/**
 * Run: cd artifacts/api-server && pnpm exec tsx tests/locking-rate.test.ts
 */
import { checkLockingRate } from "../src/routes/sales";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function poolFor(lockingRate: number | null, taxRate = 0) {
  return {
    query: async () => ({
      rows: [{ id: 1, name: "Test SKU", locking_rate: lockingRate, tax_rate: taxRate }],
    }),
  };
}

const line = (overrides: Record<string, unknown> = {}) => ({
  itemId: 1,
  itemName: "Test SKU",
  quantity: 1,
  unitPrice: 330,
  discount: 0,
  priceMode: "inclusive",
  taxRate: 0,
  lineGross: 330,
  ...overrides,
});

async function run() {
  const absent = await checkLockingRate(poolFor(null), [line()], 0, false, false);
  assert("blank Locking Rate imposes no restriction", absent.ok);

  const equal = await checkLockingRate(poolFor(300), [line({ discount: 30, lineGross: 300 })], 0, false, false);
  assert("effective price equal to Locking Rate is allowed", equal.ok);

  const below = await checkLockingRate(poolFor(300), [line({ discount: 31, lineGross: 299 })], 0, false, false);
  assert("employee is blocked below Locking Rate", !below.ok && below.code === "LOCKING_RATE_BELOW_MINIMUM");

  const billDiscount = await checkLockingRate(poolFor(300), [line({ discount: 31 })], 0, false, false);
  assert("pre-tax bill discount is included in the floor calculation", !billDiscount.ok);

  const couponEqual = await checkLockingRate(poolFor(300), [line()], 30, false, false);
  assert("post-tax coupon is allocated to the item's effective price", couponEqual.ok);

  const couponBelow = await checkLockingRate(poolFor(300), [line()], 30.01, false, false);
  assert("coupon taking price below Locking Rate is blocked", !couponBelow.ok);

  const exclusive = await checkLockingRate(
    poolFor(290.5, 5),
    [line({ unitPrice: 300, priceMode: "exclusive", taxRate: 5, lineGross: 315 })],
    10,
    false,
    false,
  );
  assert("exclusive-GST coupon is converted to the pre-tax rate", !exclusive.ok);

  const noConsent = await checkLockingRate(poolFor(300), [line({ discount: 31 })], 0, true, false);
  assert("administrator override requires explicit confirmation",
    !noConsent.ok && noConsent.code === "LOCKING_RATE_OVERRIDE_CONFIRMATION_REQUIRED");

  const approved = await checkLockingRate(poolFor(300), [line({ discount: 31 })], 0, true, true);
  assert("confirmed Level-1 override is accepted", approved.ok && approved.overrides.length === 1);
  assert("override audit detail records effective and locked rates",
    approved.ok && approved.overrides[0].lockingRate === 300 && approved.overrides[0].effectiveRate === 299);

  const noFloorStillFailsForEmployee = await checkLockingRate(poolFor(300), [line({ discount: 31 })], 0, false, true);
  assert("client confirmation flag cannot authorize an employee", !noFloorStillFailsForEmployee.ok);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void run();
