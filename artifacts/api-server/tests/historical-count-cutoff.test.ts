/**
 * Read-only regressions for same-day stock counts and the Aug 31 transit cutoff.
 * Run with: pnpm --filter @workspace/api-server exec tsx tests/historical-count-cutoff.test.ts
 */
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { stockAsOf } from "../src/lib/books";
import { stockValuation } from "../src/lib/valuation";

try {
  const { rows } = await pool.query(`
    WITH count_lines AS (
      SELECT v.verify_date,v.created_at verified_at,v.branch_type,v.branch_id,
             (x.value->>'itemId')::int ref_id,
             (x.value->>'countedQty')::numeric counted
        FROM stock_verifications v
        CROSS JOIN LATERAL jsonb_array_elements(v.lines) x(value)
       WHERE v.id=1 AND (x.value->>'itemId')::int IN (2,34,40)
    ), post_count AS (
      SELECT c.ref_id,COALESCE(SUM(sl.qty_change::numeric),0) qty,
             BOOL_OR(sl.doc_type='sale' AND sl.doc_id=1287) includes_sale_1287
        FROM count_lines c
        LEFT JOIN stock_ledger sl
          ON sl.material_type='item' AND sl.ref_id=c.ref_id
         AND sl.branch_type=c.branch_type AND sl.branch_id=c.branch_id
         AND COALESCE(sl.txn_date,sl.created_at::date)<=DATE '2026-08-31'
         AND (
           COALESCE(sl.txn_date,sl.created_at::date)>c.verify_date
           OR (COALESCE(sl.txn_date,sl.created_at::date)=c.verify_date
             AND sl.created_at>c.verified_at)
         )
       GROUP BY c.ref_id
    ), after_cutoff AS (
      SELECT material_type,ref_id,branch_type,branch_id,
             SUM(qty_change::numeric) qty
        FROM stock_ledger
       WHERE COALESCE(txn_date,created_at::date)>DATE '2026-08-31'
       GROUP BY 1,2,3,4
    )
    SELECT c.ref_id,c.counted,p.qty post_count_qty,
           c.counted+p.qty reconstructed,
           COALESCE(se.quantity,0)-COALESCE(a.qty,0) ledger_derived,
           p.includes_sale_1287
      FROM count_lines c
      JOIN post_count p USING(ref_id)
      LEFT JOIN stock_entries se
        ON se.material_type='item' AND se.item_id=c.ref_id
       AND se.branch_type=c.branch_type AND se.branch_id=c.branch_id
      LEFT JOIN after_cutoff a
        ON a.material_type='item' AND a.ref_id=c.ref_id
       AND a.branch_type=c.branch_type AND a.branch_id=c.branch_id
     ORDER BY c.ref_id
  `);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(
      Math.abs(Number(row.reconstructed) - Number(row.ledger_derived)) <= 0.001,
      `Item ${row.ref_id} count plus movements after the verification timestamp must match the Aug31 rewind.`,
    );
    assert.equal(row.includes_sale_1287, true, `Item ${row.ref_id} must include sale 1287, posted after the count.`);
  }
  const expected = new Map([[2, 30], [34, 98], [40, 0]]);
  for (const row of rows) assert.equal(Number(row.ledger_derived), expected.get(Number(row.ref_id)));

  const position = await stockAsOf("2026-08-31", null, pool as any);
  assert.equal(position.reliable, false, "Missing exact-date cost checkpoints must remain unverified.");
  assert.equal(position.total, position.inTransit, "Unknown historical on-hand costs must not be filled with current costs.");
  assert.equal(position.inTransit, 32668, "Only the source-costed transfer 3 lots are included in the historical value.");
  assert.equal(position.items.find((item) => item.id === 82)?.stock, 100);
  assert.equal(position.items.find((item) => item.id === 41)?.stock, 50);
  assert.match(position.note ?? "", /current item costs were not substituted/);
  assert.match(position.note ?? "", /excluded from destination on-hand/);

  const cutoffValuation = await stockValuation(pool, { asOf: "2026-08-31", includeInTransit: true });
  assert.equal(cutoffValuation.inTransitValue, 32668);
  assert.equal(
    cutoffValuation.issues.filter((issue) => issue.code === "TRANSFER_RECEIPT_DATE_CONFLICT").length,
    2,
    "Transfer 3 destination rows must not be valued as on-hand at the cutoff.",
  );
  assert.equal(cutoffValuation.reliable, false);

  const septemberClose = await stockValuation(pool, { asOf: "2026-09-30", includeInTransit: true });
  assert.equal(
    septemberClose.issues.filter((issue) => issue.code === "TRANSFER_RECEIPT_DATE_CONFLICT").length,
    5,
    "All transfer receipt/reservation conflicts at the September cutoff must remain visible.",
  );
  assert.equal(septemberClose.reliable, false);

  console.log(JSON.stringify({
    countLines: rows.map((row) => ({
      itemId: Number(row.ref_id),
      postCountMovement: Number(row.post_count_qty),
      reconstructed: Number(row.reconstructed),
      ledgerRewind: Number(row.ledger_derived),
    })),
    august31Stock: {
      total: position.total,
      inTransit: position.inTransit,
      reliable: position.reliable,
      note: position.note,
    },
  }, null, 2));
} finally {
  await pool.end();
}
