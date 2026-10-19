import test from "node:test";
import assert from "node:assert/strict";
import { cashBankLedgerLocationError, diagnoseCashBankLocation, parseCashBankLocations } from "../src/lib/cashBankLedgers.ts";

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

test("Bank availability ignores legacy location memberships", () => {
  const result = diagnoseCashBankLocation(
    { account_type: "bank", location_type: "warehouse", location_id: 5 },
    [
      { location_type: "headoffice", location_id: 0 },
      { location_type: "warehouse", location_id: 3 },
    ],
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.location, { locationType: "headoffice", locationId: 0 });
  }
});

test("new Bank and Online accounts need no location assignments", () => {
  assert.deepEqual(parseCashBankLocations({}, "bank"), { ok: true, locations: [] });
  assert.deepEqual(parseCashBankLocations({}, "online"), { ok: true, locations: [] });
  assert.deepEqual(parseCashBankLocations({ locations: [] }, "online"), { ok: true, locations: [] });
});

test("Cash accounts remain location-assigned", () => {
  assert.equal(parseCashBankLocations({}, "cash").ok, false);
  assert.deepEqual(
    parseCashBankLocations({ locations: [{ locationType: "warehouse", locationId: 7 }] }, "cash"),
    { ok: true, locations: [{ locationType: "warehouse", locationId: 7 }] },
  );
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