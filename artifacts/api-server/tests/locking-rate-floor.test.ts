import { checkSaleLockingRates } from "../src/routes/sales";
import { itemCreateError } from "../src/lib/itemCreate";
import { isLevelOneAdmin } from "../src/lib/adminGate";

const items = [
  { id: 1, name: "Locked item", mrp: "400.00", locking_rate: "350.00" },
  { id: 2, name: "Legacy item", mrp: "200.00", locking_rate: null },
];
const fakePool = {
  async query(_sql: string, _params?: unknown[]) {
    return { rows: items };
  },
};
function assert(label: string, value: boolean): void {
  if (!value) throw new Error(`FAIL: ${label}`);
  process.stdout.write(`PASS: ${label}\n`);
}

async function run(): Promise<void> {
  assert("item master rejects a negative locking rate",
    itemCreateError({ name: "A", unit: "EA", mrp: 400, lockingRate: -1 }) !== null);
  assert("item master rejects locking rate above the normal rate",
    itemCreateError({ name: "A", unit: "EA", mrp: 400, lockingRate: 401 }) !== null);
  const okAtFloor = await checkSaleLockingRates(
    fakePool, [{ itemId: 1, quantity: 1, unitPrice: 400 }],
    [{ itemId: 1, quantity: 1, unitPrice: 400, discount: 50, lineSubtotal: 350, taxAmount: 0 }],
    0,
  );
  assert("item and bill discounts may reduce the effective rate exactly to the floor", okAtFloor.ok);

  const belowByCoupon = await checkSaleLockingRates(
    fakePool, [{ itemId: 1, quantity: 1, unitPrice: 400 }],
    [{ itemId: 1, quantity: 1, unitPrice: 400, discount: 49, lineSubtotal: 334.29, taxAmount: 16.71 }],
    2,
  );
  assert("post-tax coupon shares are included in the effective floor", !belowByCoupon.ok);

  const exclusiveAtFloor = await checkSaleLockingRates(
    fakePool, [{ itemId: 1, quantity: 1, unitPrice: 400 }],
    [{ itemId: 1, quantity: 1, unitPrice: 400, discount: 0, lineSubtotal: 400, taxAmount: 20, priceMode: "exclusive" }],
    52.5,
  );
  assert("exclusive-price coupons convert back to the taxable-rate basis", exclusiveAtFloor.ok);

  const employeeAttempt = await checkSaleLockingRates(
    fakePool, [{ itemId: 1, quantity: 1, unitPrice: 340 }],
    [{ itemId: 1, quantity: 1, unitPrice: 340, discount: 0, lineSubtotal: 340, taxAmount: 0 }],
    0, undefined, false,
  );
  assert("an employee request cannot bypass the floor", !employeeAttempt.ok);

  const adminAttempt = await checkSaleLockingRates(
    fakePool, [{ itemId: 1, quantity: 1, unitPrice: 340 }],
    [{ itemId: 1, quantity: 1, unitPrice: 340, discount: 0, lineSubtotal: 340, taxAmount: 0 }],
    0, undefined, true,
  );
  assert("an authorized admin override records the item and final price",
    adminAttempt.ok && adminAttempt.overrides[0]?.itemId === 1 && adminAttempt.overrides[0]?.finalPrice === 340);
  assert("the server admin gate fails closed for an unknown hierarchy",
    !(await isLevelOneAdmin({ hierarchyId: -999999 })));

  const legacyItem = await checkSaleLockingRates(
    fakePool, [{ itemId: 2, quantity: 1, unitPrice: 199 }],
    [{ itemId: 2, quantity: 1, unitPrice: 199, discount: 0, lineSubtotal: 199, taxAmount: 0 }],
    0,
  );
  assert("items without a locking rate keep the existing MRP floor", !legacyItem.ok);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
