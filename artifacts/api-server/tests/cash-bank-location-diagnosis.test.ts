import test from "node:test";
import assert from "node:assert/strict";
import { cashBankLedgerLocationError, diagnoseCashBankLocation } from "../src/lib/cashBankLedgers.ts";

test("accepts valid multi-location memberships returned in database snake_case", () => {
  const result = diagnoseCashBankLocation(
    { account_type: "cash", location_type: "warehouse", location_id: 4 },
    [
      { location_type: "headoffice", location_id: 0 },
      { location_type: "warehouse", location_id: 2 },
      { location_type: "warehouse", location_id: 3 },
      { location_type: "warehouse", location_id: 4 },
      { location_type: "warehouse", location_id: 5 },
    ],
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.location, { locationType: "warehouse", locationId: 4 });
  }
});

test("still blocks a multi-location account when its scalar owner is not assigned", () => {
  const result = diagnoseCashBankLocation(
    { account_type: "bank", location_type: "warehouse", location_id: 5 },
    [
      { location_type: "headoffice", location_id: 0 },
      { location_type: "warehouse", location_id: 3 },
    ],
  );

  assert.equal(result.ok, false);
});

function statusQueryable(active: boolean) {
  return {
    async query() {
      return {
        rows: [{
          id: 3,
          name: "Operating Bank",
          ledger_id: 91,
          account_type: "bank",
          location_type: "headoffice",
          location_id: 0,
          ledger_is_active: active,
          memberships: [{ location_type: "headoffice", location_id: 0 }],
        }],
      };
    },
  } as any;
}

test("blocks new writes through a disabled managed Cash/Bank ledger", async () => {
  const error = await cashBankLedgerLocationError(statusQueryable(false), [91]);
  assert.match(error ?? "", /Cash\/Bank account "Operating Bank" is disabled/);
});

test("allows new writes through an active managed Cash/Bank ledger", async () => {
  const error = await cashBankLedgerLocationError(statusQueryable(true), [91]);
  assert.equal(error, null);
});