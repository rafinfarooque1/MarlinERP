import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseCashBankLocation } from "../src/lib/cashBankLedgers.ts";

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