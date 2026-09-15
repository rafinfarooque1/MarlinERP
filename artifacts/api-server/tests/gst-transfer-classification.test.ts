/**
 * Deterministic GST transfer classification matrix.
 *
 * Run: cd artifacts/api-server && pnpm exec tsx tests/gst-transfer-classification.test.ts
 */
import { classifyTransfer, type LocationGst } from "../src/lib/gstTransfer";

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

const location = (gstin: string | null, state: string, stateCode: string): LocationGst => ({
  gstin,
  state,
  stateCode,
  name: "fixture",
  locationType: "warehouse",
  locationId: 1,
  salesLedgerId: null,
  purchaseLedgerId: null,
});

const sameRegistration = classifyTransfer(
  location("29ZZGST0001Z5", "Karnataka", "29"),
  location("29ZZGST0001Z5", "Karnataka", "29"),
);
assert(
  "same registered GSTIN is internal and untaxed",
  sameRegistration.transferType === "internal" &&
    sameRegistration.taxType === "none" &&
    sameRegistration.isInterstate === false,
  JSON.stringify(sameRegistration),
);

const sameStateDifferentRegistration = classifyTransfer(
  location("29ZZGST0001Z5", "Karnataka", "29"),
  location("29ZZGST0002Z5", "Karnataka", "29"),
);
assert(
  "different GSTINs in one state use CGST+SGST",
  sameStateDifferentRegistration.transferType === "intrastate" &&
    sameStateDifferentRegistration.taxType === "cgst_sgst" &&
    sameStateDifferentRegistration.isInterstate === false,
  JSON.stringify(sameStateDifferentRegistration),
);

const differentState = classifyTransfer(
  location("29ZZGST0001Z5", "Karnataka", "29"),
  location("32ZZGST0003Z5", "Kerala", "32"),
);
assert(
  "different-state GSTINs use IGST",
  differentState.transferType === "interstate" &&
    differentState.taxType === "igst" &&
    differentState.isInterstate === true,
  JSON.stringify(differentState),
);

const missingRegistration = classifyTransfer(
  location(null, "Karnataka", "29"),
  location("29ZZGST0002Z5", "Karnataka", "29"),
);
assert(
  "a missing GSTIN falls back to internal challan",
  missingRegistration.transferType === "internal" &&
    missingRegistration.taxType === "none" &&
    missingRegistration.isInterstate === false,
  JSON.stringify(missingRegistration),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);