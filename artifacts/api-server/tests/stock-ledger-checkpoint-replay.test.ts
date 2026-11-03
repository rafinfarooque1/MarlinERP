import assert from "node:assert/strict";
import test from "node:test";
import { prepareTransferCheckpointReplay, type LedgerEntry } from "../src/lib/stockLedger.ts";

const transfer: LedgerEntry = {
  txnType: "transfer_in",
  materialType: "item",
  refId: 90,
  itemName: "Frozen item",
  unit: "kg",
  branchType: "warehouse",
  branchId: 5,
  branchName: "Warehouse 5",
  qtyChange: 37.5,
  unitCost: 274,
  snapshotUnitCost: 274,
  docType: "stock_transfer",
  docId: 90,
  txnDate: "2026-11-02",
};

function replayDb({
  laterQty = 3132.5,
  currentQty = 3170,
  movement = -37.5,
  cost = 274,
}: {
  laterQty?: number;
  currentQty?: number;
  movement?: number;
  cost?: number;
} = {}) {
  return {
    async query(sql: string) {
      if (sql.includes("as_of_date >= $5::date")) {
        return { rows: [{ as_of_date: "2026-11-04", quantity: laterQty, unit_cost: cost, value: laterQty * cost }] };
      }
      if (sql.includes("as_of_date < $5::date")) {
        return { rows: [{ as_of_date: "2026-11-01", quantity: 3170, unit_cost: 274, value: 868580 }] };
      }
      if (sql.includes("FROM stock_ledger")) {
        return { rows: [{ txn_date: "2026-11-04", quantity_delta: movement }] };
      }
      if (sql.includes("FROM stock_entries")) return { rows: [{ quantity: currentQty }] };
      throw new Error(`Unexpected SQL in replay test: ${sql}`);
    },
  };
}

test("replays a receipt through a later sale checkpoint without rewriting history", async () => {
  const plans = await prepareTransferCheckpointReplay(replayDb(), [transfer]);
  const plan = [...plans.values()][0];

  assert.ok(plan);
  assert.deepEqual(plan.snapshots, [
    { date: "2026-11-02", quantity: 3207.5, value: 878855 },
    { date: "2026-11-04", quantity: 3170, value: 868580 },
  ]);
});

test("refuses replay when the intervening ledger does not reconcile", async () => {
  await assert.rejects(
    prepareTransferCheckpointReplay(replayDb({ movement: -20 }), [transfer]),
    (error: any) => error.code === "STOCK_CHECKPOINT_REPLAY_UNSAFE",
  );
});

test("refuses replay when a later checkpoint uses a different valuation cost", async () => {
  await assert.rejects(
    prepareTransferCheckpointReplay(replayDb({ cost: 275 }), [transfer]),
    (error: any) => error.code === "STOCK_CHECKPOINT_REPLAY_UNSAFE",
  );
});
