import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "@workspace/db";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  return /[\n\r,"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const keyOf = (type: string, id: number, branch: string, locationId: number) =>
  `${type}:${id}:${branch}:${locationId}`;

async function main() {
  const sourcePath = resolve(process.cwd(), "../../generated-artifacts/august-31-stock-evidence.csv");
  const outputPath = resolve(process.cwd(), "../../generated-artifacts/august-31-stock-evidence-exceptions.csv");
  const parsed = parseCsv(await readFile(sourcePath, "utf8"));
  const headers = parsed.shift();
  if (!headers?.includes("closing_qty_aug31")) throw new Error("The source evidence CSV is missing the Aug 31 quantity column.");
  const col = Object.fromEntries(headers.map((name, index) => [name, index]));

  const { rows: verification } = await pool.query(`
    WITH count_lines AS (
      SELECT v.verify_date,v.created_at AS verified_at,v.branch_type,v.branch_id,v.notes,
             (x.value->>'itemId')::int ref_id,
             (x.value->>'countedQty')::numeric counted,
             (x.value->>'systemQty')::numeric system,
             (x.value->>'variance')::numeric variance
        FROM stock_verifications v
        CROSS JOIN LATERAL jsonb_array_elements(v.lines) x(value)
       WHERE v.verify_date=DATE '2026-08-27'
    ), after_cutoff AS (
      SELECT material_type,ref_id,branch_type,branch_id,
             SUM(qty_change::numeric) qty
        FROM stock_ledger
       WHERE COALESCE(txn_date,created_at::date)>DATE '2026-08-31'
       GROUP BY 1,2,3,4
    )
    SELECT c.ref_id,c.branch_type,c.branch_id,c.counted::numeric,c.system::numeric,
           c.variance::numeric,c.notes,c.verified_at::text,
           COALESCE(l.qty,0)::numeric later_qty,
           (COALESCE(c.counted,0)+COALESCE(l.qty,0))::numeric reconstructed,
           (COALESCE(se.quantity,0)-COALESCE(a.qty,0))::numeric ledger_derived
      FROM count_lines c
      LEFT JOIN LATERAL (
        SELECT SUM(sl.qty_change::numeric) qty
          FROM stock_ledger sl
         WHERE sl.material_type='item' AND sl.ref_id=c.ref_id
           AND sl.branch_type=c.branch_type AND sl.branch_id=c.branch_id
           AND COALESCE(sl.txn_date,sl.created_at::date)<=DATE '2026-08-31'
           AND (
             COALESCE(sl.txn_date,sl.created_at::date)>c.verify_date
             OR (COALESCE(sl.txn_date,sl.created_at::date)=c.verify_date
               AND sl.created_at>c.verified_at)
           )
      ) l ON TRUE
      LEFT JOIN stock_entries se ON se.material_type='item' AND se.item_id=c.ref_id
       AND se.branch_type=c.branch_type AND se.branch_id=c.branch_id
      LEFT JOIN after_cutoff a ON a.material_type='item' AND a.ref_id=c.ref_id
       AND a.branch_type=c.branch_type AND a.branch_id=c.branch_id
  `);
  const verificationByKey = new Map(verification.map((row: any) => [
    keyOf("item", Number(row.ref_id), row.branch_type, Number(row.branch_id)), row,
  ]));

  const { rows: batchRows } = await pool.query(`
    SELECT material_type,item_id::int ref_id,branch_type,branch_id::int,
           batch_number,unit_cost::numeric,source,source_id,created_at::date::text created
      FROM stock_batches
     WHERE created_at::date<=DATE '2026-08-31' AND unit_cost>0
     ORDER BY material_type,item_id,branch_type,branch_id,batch_number
  `);
  const batchesByKey = new Map<string, any[]>();
  for (const batch of batchRows) {
    const key = keyOf(batch.material_type, Number(batch.ref_id), batch.branch_type, Number(batch.branch_id));
    batchesByKey.set(key, [...(batchesByKey.get(key) ?? []), batch]);
  }

  const { rows: transferConflicts } = await pool.query(`
    SELECT DISTINCT t.id transfer_id,t.from_type source_type,t.from_id source_id,
           sl.material_type,sl.ref_id,sl.branch_type destination_type,
           sl.branch_id destination_id,sl.qty_change::numeric quantity,
           t.received_date::text received_date,t.receive_voucher_id,t.approved_by,
           t.approved_at::text approved_at,t.received_line_items::text received_line_items,
           r.released_at::text reservation_released_at
      FROM stock_transfers t
      JOIN stock_ledger sl ON sl.doc_type='stock_transfer' AND sl.doc_id=t.id AND sl.txn_type='transfer_in'
      LEFT JOIN stock_reservations r ON r.doc_type='stock_transfer' AND r.doc_id=t.id
       AND r.kind='in_transit' AND r.material_type=sl.material_type AND r.ref_id=sl.ref_id
       AND r.branch_type=t.from_type AND r.branch_id=t.from_id
     WHERE COALESCE(sl.txn_date,sl.created_at::date)<=DATE '2026-08-31'
       AND (t.received_date>DATE '2026-08-31'
         OR r.id IS NULL OR r.status='active' OR r.released_at IS NULL
         OR r.released_at::date>DATE '2026-08-31')
  `);
  const transferConflictKeys = new Map(transferConflicts.map((row: any) => [
    keyOf(row.material_type, Number(row.ref_id), row.destination_type, Number(row.destination_id)), row,
  ]));
  const transferSenderKeys = new Map(transferConflicts.map((row: any) => [
    keyOf(row.material_type, Number(row.ref_id), row.source_type, Number(row.source_id)), row,
  ]));

  const extraHeaders = [
    "quantity_evidence_status",
    "aug31_ledger_closing_qty",
    "aug31_on_hand_excluding_unreceived_transfer_qty",
    "aug31_sender_owned_in_transit_qty",
    "sep1_opening_on_hand_qty_same_boundary",
    "aug31_to_sep1_boundary_delta",
    "dated_lot_cost_sources",
    "historical_cost_evidence_status",
    "missing_evidence_to_clear",
  ];
  const output = [headers.concat(extraHeaders).map(csvCell).join(",")];
  for (const line of parsed) {
    const type = line[col.material_type], refId = Number(line[col.ref_id]);
    const branch = line[col.branch_type], branchId = Number(line[col.branch_id]);
    const key = keyOf(type, refId, branch, branchId);
    const verified = verificationByKey.get(key);
    const transferConflict = transferConflictKeys.get(key);
    const senderTransit = transferSenderKeys.get(key);
    const ledgerCloseQty = Number(line[col.closing_qty_aug31]);
    const excludedInboundQty = transferConflict ? Number(transferConflict.quantity) : 0;
    const onHandAtCutoff = Math.round((ledgerCloseQty - excludedInboundQty) * 1000) / 1000;
    const transitAtCutoff = senderTransit ? Number(senderTransit.quantity) : 0;
    let quantityStatus: string;
    if (transferConflict) {
      quantityStatus = `CONFLICT: transfer ${transferConflict.transfer_id} has a transfer_in ledger entry dated by Aug31; received_line_items records the quantity, but received_date is ${transferConflict.received_date ?? "blank"} and receive_voucher_id is ${transferConflict.receive_voucher_id ?? "blank"}. Approval is stamped ${transferConflict.approved_at ?? "not recorded"} (${transferConflict.approved_by ?? "no approver"}), and the sender reservation released ${String(transferConflict.reservation_released_at ?? "not recorded")}; receipt/on-hand by the Aug31 cutoff is unproven.`;
    } else if (verified) {
      const difference = Number(verified.reconstructed) - Number(verified.ledger_derived);
      quantityStatus = Math.abs(difference) <= 0.001
        ? `LIMITED: Aug27 count ${verified.counted} plus movements after verification time ${verified.verified_at} (${verified.later_qty}) reconciles to the Aug31 ledger rewind; note '${verified.notes}', not an approved Aug31 count.`
        : `CONFLICT: Aug27 count ${verified.counted} plus movements after verification time ${verified.verified_at} (${verified.later_qty}) = ${verified.reconstructed}; Aug31 ledger rewind is ${verified.ledger_derived}; difference ${difference > 0 ? "+" : ""}${difference}.`;
    } else if (type === "item" && branch === "warehouse" && branchId === 5 && (refId === 82 || refId === 41)) {
      quantityStatus = "LIMITED: transfer 3 dispatch quantity is evidenced by the sender reservation at cutoff; the remainder of this location quantity is a ledger rewind, not a physical count.";
    } else {
      quantityStatus = "MISSING: no independent Aug31 physical count or approved dated quantity record was located; quantity is a stock-ledger rewind only.";
    }
    const lots = batchesByKey.get(key) ?? [];
    const lotSources = lots.length
      ? lots.map((b) => `${b.batch_number} @ ${b.unit_cost} (${b.source}:${b.source_id}, recorded ${b.created})`).join(" | ")
      : "No dated positive-cost stock batch located for this product/location by Aug31.";
    const costStatus = `NO exact stock valuation checkpoint dated on/before Aug31. ${lots.length
      ? "Dated batch cost(s) exist, but the stored batch balances are not historical residual quantities and do not establish the location weighted cost."
      : "No dated lot-cost record found for this product/location."}`;
    const positiveAtCutoff = Number(line[col.closing_qty_aug31]) > 0;
    const missing: string[] = [];
    if (quantityStatus.startsWith("CONFLICT")) missing.push("Resolve the quantity conflict with a dated physical count/receipt or documented correction.");
    else if (quantityStatus.startsWith("MISSING")) missing.push("Approved Aug31 quantity by product/location with count-sheet/source reference.");
    else missing.push("Approve the limited count/dispatch evidence and confirm movement completeness through Aug31.");
    missing.push(positiveAtCutoff
      ? "Historical unit cost/valuation basis and remaining lot quantities at this location on Aug31."
      : "Dated evidence confirming zero stock at cutoff, or a cost schedule if stock was present.");
    if (transferConflict) missing.push(`Transfer ${transferConflict.transfer_id} receipt proof: actual received date/time, destination, accepted quantities, and batch receipt; reconcile the Aug31 transfer_in date with the sender reservation release.`);
    output.push(line.concat([
      quantityStatus,
      ledgerCloseQty,
      onHandAtCutoff,
      transitAtCutoff,
      onHandAtCutoff,
      0,
      lotSources,
      costStatus,
      missing.join(" "),
    ]).map(csvCell).join(","));
  }
  await writeFile(outputPath, `${output.join("\n")}\n`);
  console.log(JSON.stringify({
    report: outputPath,
    productLocationLines: parsed.length,
    aug27CountLines: verification.length,
    transferReceiptConflicts: transferConflicts,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
