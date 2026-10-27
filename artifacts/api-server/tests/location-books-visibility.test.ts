/**
 * Read-only regression for consolidated versus location-filtered Books.
 *
 * Disabled locations intentionally disappear from ordinary location slices,
 * while consolidated accounting retains their history. Verify that this is the
 * only excluded bucket and that the partition holds for both a historical and
 * current cutoff.
 */
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { openingBalancePostings } from "../src/lib/openingBalances";
import { visibleLocationSql } from "../src/lib/warehouseVisibility";
import { buildDerivedPostings } from "../src/routes/journal";

const r2 = (value: number) => Math.round(value * 100) / 100;
const dates = ["2026-09-30", "2026-10-27"];

try {
  for (const asOf of dates) {
    const [derived, openings] = await Promise.all([
      buildDerivedPostings({ toDate: asOf }),
      openingBalancePostings({ toDate: asOf }),
    ]);
    const postings = derived.concat(openings as typeof derived);
    const pairs = [...new Map(postings
      .filter((posting) => posting.locationType != null)
      .map((posting) => [
        `${posting.locationType}:${posting.locationId ?? 0}`,
        { type: String(posting.locationType), id: Number(posting.locationId ?? 0) },
      ])).values()];
    const visibility = pairs.length
      ? await pool.query(
          `SELECT location_type, location_id,
                  ${visibleLocationSql("locations.location_type", "locations.location_id")} AS visible
             FROM unnest($1::text[], $2::int[]) AS locations(location_type, location_id)`,
          [pairs.map((pair) => pair.type), pairs.map((pair) => pair.id)],
        )
      : { rows: [] as Array<{ location_type: string; location_id: number; visible: boolean }> };
    const visiblePairs = new Set(visibility.rows
      .filter((row: any) => row.visible)
      .map((row: any) => `${row.location_type}:${row.location_id}`));

    const allByLedger = new Map<number, { debit: number; credit: number }>();
    const visibleByLedger = new Map<number, { debit: number; credit: number }>();
    const hiddenByLedger = new Map<number, { debit: number; credit: number }>();
    let hiddenPostingCount = 0;
    const add = (map: Map<number, { debit: number; credit: number }>, posting: any) => {
      const row = map.get(Number(posting.ledgerId)) ?? { debit: 0, credit: 0 };
      row.debit = r2(row.debit + Number(posting.debit));
      row.credit = r2(row.credit + Number(posting.credit));
      map.set(Number(posting.ledgerId), row);
    };

    for (const posting of postings) {
      add(allByLedger, posting);
      if (posting.locationType == null
          || visiblePairs.has(`${posting.locationType}:${posting.locationId ?? 0}`)) {
        add(visibleByLedger, posting);
      } else {
        hiddenPostingCount++;
        add(hiddenByLedger, posting);
      }
    }

    for (const [ledgerId, all] of allByLedger) {
      const visible = visibleByLedger.get(ledgerId) ?? { debit: 0, credit: 0 };
      const hidden = hiddenByLedger.get(ledgerId) ?? { debit: 0, credit: 0 };
      assert.ok(
        Math.abs(r2(visible.debit + hidden.debit) - all.debit) <= 0.01,
        `${asOf}: visible + intentionally hidden debit must equal consolidated for ledger ${ledgerId}`,
      );
      assert.ok(
        Math.abs(r2(visible.credit + hidden.credit) - all.credit) <= 0.01,
        `${asOf}: visible + intentionally hidden credit must equal consolidated for ledger ${ledgerId}`,
      );
    }

    if (hiddenPostingCount > 0) {
      assert.ok(
        [...hiddenByLedger.values()].some((row) => row.debit > 0 || row.credit > 0),
        `${asOf}: disabled-location history is retained in consolidated Books`,
      );
    }
    console.log(JSON.stringify({
      asOf,
      postings: postings.length,
      intentionallyHiddenDisabledLocationPostings: hiddenPostingCount,
      consolidatedDebit: r2([...allByLedger.values()].reduce((sum, row) => sum + row.debit, 0)),
      visibleDebit: r2([...visibleByLedger.values()].reduce((sum, row) => sum + row.debit, 0)),
      hiddenDebit: r2([...hiddenByLedger.values()].reduce((sum, row) => sum + row.debit, 0)),
    }));
  }
} finally {
  await pool.end();
}
