import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "@workspace/db";
import { stockValuation } from "../src/lib/valuation";
import { buildDerivedPostings } from "../src/routes/journal";

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
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  return /[\n\r,"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const keyOf = (kind: string, id: number, branch: string, location: number) =>
  `${kind}:${id}:${branch}:${location}`;

async function main() {
  const basePath = resolve(process.cwd(), "../../generated-artifacts/august-31-stock-evidence-exceptions.csv");
  const outPath = resolve(process.cwd(), "../../generated-artifacts/inventory-exception-register.csv");
  const batchPath = resolve(process.cwd(), "../../generated-artifacts/backdated-batch-allocation-audit.csv");
  const glPath = resolve(process.cwd(), "../../generated-artifacts/inventory-gl-reconciliation.csv");
  const parsed = parseCsv(await readFile(basePath, "utf8"));
  const headers = parsed.shift();
  if (!headers) throw new Error("August 31 exception source is empty.");
  const col = Object.fromEntries(headers.map((name, i) => [name, i]));
  const baseRows = parsed.map((row) => Object.fromEntries(headers.map((name, i) => [name, row[i] ?? ""])));
  if (baseRows.length !== 209) throw new Error(`Expected 209 August 31 product/location rows; found ${baseRows.length}.`);

  const valuation = await stockValuation(pool, { asOf: "2026-09-30", includeInTransit: true });
  if (valuation.issues.length !== 111) throw new Error(`Expected 111 September 30 valuation issues; found ${valuation.issues.length}.`);
  const baseByKey = new Map(baseRows.map((r: any) => [
    keyOf(r.material_type, Number(r.ref_id), r.branch_type, Number(r.branch_id)), r,
  ]));
  const valuedByKey = new Map<string, any>();
  for (const row of valuation.rows) {
    const key = keyOf(row.materialType, row.refId, row.branchType, row.branchId);
    const prior = valuedByKey.get(key) ?? { quantity: 0, value: 0, unitCost: row.unitCost };
    prior.quantity += row.quantity;
    prior.value += row.value;
    if (row.quantity > 0) prior.unitCost = row.unitCost;
    valuedByKey.set(key, prior);
  }

  const transferIds = [...new Set(valuation.issues.map((i) => Number(i.message.match(/Transfer (\d+)/)?.[1])).filter(Number.isFinite))];
  const transfers = transferIds.length ? (await pool.query(`
    SELECT t.id,t.transfer_date::text,t.from_type,t.from_id,t.to_type,t.to_id,t.status,
           t.received_date::text,t.receive_voucher_id,t.approved_by,t.approved_at::text,
           t.line_items,t.received_line_items,
           r.released_at::text reservation_released_at,r.status reservation_status
      FROM stock_transfers t
      LEFT JOIN stock_reservations r ON r.doc_type='stock_transfer' AND r.doc_id=t.id
       AND r.kind='in_transit'
     WHERE t.id=ANY($1::int[])
     ORDER BY t.id
  `, [transferIds])).rows : [];
  const transferById = new Map(transfers.map((t: any) => [Number(t.id), t]));

  const outHeaders = [
    "record_type","as_of_date","exception_code","material_type","ref_id","product_name","unit",
    "branch_type","branch_id","location_name","quantity","quantity_basis","historical_unit_cost",
    "valuation","valuation_status","affected_report","verified_facts","candidate_reconstruction",
    "unresolved_assumptions","missing_evidence","specific_document_or_approval","source_references",
  ];
  const output = [outHeaders.map(csvCell).join(",")];
  for (const r of baseRows as any[]) {
    const quantity = r.aug31_on_hand_excluding_unreceived_transfer_qty || r.aug31_ledger_closing_qty || "0";
    const quantityNumber = Number(quantity);
    const isConflict = String(r.quantity_evidence_status).startsWith("CONFLICT");
    const isLimited = String(r.quantity_evidence_status).startsWith("LIMITED");
    const key = keyOf(r.material_type, Number(r.ref_id), r.branch_type, Number(r.branch_id));
    const candidate = key === "item:2:warehouse:2"
      ? "Candidate only: 30 units of PUR-20260828-00464 × ₹170 = ₹5,100; old counted lot depleted. See candidate lot CSV; not approved."
      : key === "item:34:warehouse:2"
        ? "Candidate only: 15 × ₹300 + 73 × ₹350 + 10 × ₹280 = ₹32,850. See candidate lot CSV; not approved."
        : "None approved; ledger rewind is not a physical count or cost approval.";
    output.push([
      "AUG31_PRODUCT_LOCATION","2026-08-31","AUG31_EVIDENCE_REVIEW",r.material_type,r.ref_id,r.product_name,r.unit,
      r.branch_type,r.branch_id,r.location_name,quantity,
      isConflict ? "ledger quantity; disputed receipt excluded" : "ledger rewind; not an approved physical count",
      quantityNumber > 0 ? "UNVERIFIED — no exact-date cost checkpoint" : "N/A — ledger-derived quantity is zero",
      quantityNumber > 0 ? "NOT ESTABLISHED — historical unit cost is unsupported" : "₹0 arithmetic on ledger-derived zero quantity; not an independent valuation",
      quantityNumber > 0 ? "UNVERIFIED" : "Zero-quantity line; no historical cost needed if zero is independently confirmed",
      "Aug 31 Stock Valuation; Sept 1 opening stock; September P&L opening stock; Balance Sheet inventory",
      r.quantity_reconciles === "t" ? "Current stock quantity agrees with the complete stock-ledger net." : "Quantity ledger reconciliation requires review.",
      candidate,
      isConflict ? "Receipt timing and ownership at cutoff are unresolved." : "No approved Aug 31 physical quantity/cost schedule; historical lot residuals may be incomplete or backfilled.",
      r.missing_evidence_to_clear,
      isConflict
        ? "Approved Aug 31 count; transfer dispatch proof; signed destination GRN/receipt with actual date/time, destination, accepted quantities and batch IDs; source invoices/lot costs; accountant approval."
        : "Signed Aug 31 count sheet by product/location; transaction-complete movement reconciliation; dated purchase invoices and lot-residual cost schedule; authorized accountant approval.",
      r.recorded_source_documents,
    ].map(csvCell).join(","));
  }

  for (const issue of valuation.issues) {
    const key = keyOf(issue.materialType, issue.refId, issue.branchType, issue.branchId);
    const base: any = baseByKey.get(key);
    const transferId = Number(issue.message.match(/Transfer (\d+)/)?.[1]);
    const transfer: any = transferById.get(transferId);
    const isTransfer = issue.code === "TRANSFER_RECEIPT_DATE_CONFLICT";
    const accepted = valuedByKey.get(key);
    const itemName = base?.product_name ?? valuation.rows.find((v) =>
      v.materialType === issue.materialType && v.refId === issue.refId)?.itemName ?? `${issue.materialType} #${issue.refId}`;
    const unit = base?.unit ?? valuation.rows.find((v) =>
      v.materialType === issue.materialType && v.refId === issue.refId)?.unit ?? "";
    const location = base?.location_name ?? `${issue.branchType}:${issue.branchId}`;
    const missing = isTransfer
      ? `Transfer ${transferId}: actual receipt date/time, accepted quantity, destination and destination batch/cost are not evidenced by the transfer-in posting alone.`
      : "Exact September 30 product/location cost checkpoint or approved historical cost schedule tied to source purchase invoices and residual quantities.";
    const required = isTransfer
      ? `Transfer ${transferId} dispatch note and source reservation; signed receiving GRN/delivery acceptance with actual timestamp and destination; batch receipt records with quantities and source unit costs; authorized accountant cutoff approval.`
      : "Approved Sept 30 inventory count/stock-close schedule plus dated lot/purchase cost support and authorized accountant approval.";
    output.push([
      "SEP30_VALUATION_ISSUE","2026-09-30",issue.code,issue.materialType,issue.refId,itemName,unit,
      issue.branchType,issue.branchId,location,issue.quantity ?? accepted?.quantity ?? "",
      isTransfer ? "disputed destination receipt quantity; excluded from destination on-hand" : "ledger rewind quantity; cost checkpoint missing",
      "UNVERIFIED — no exact-date historical cost", isTransfer
        ? "Excluded from destination valuation; not a proved loss or zero value"
        : "Not determinable; excluded from partial valuation",
      isTransfer ? "TRANSFER CUTOFF DISPUTED" : "MISSING COST CHECKPOINT",
      "Sept 30 Inventory Valuation; September P&L closing stock; Balance Sheet inventory",
      `Valuation engine flags ${issue.code}; ${issue.message}`,
      "None approved.",
      issue.message,
      missing,required,
      isTransfer ? `stock transfer ${transferId}; ${transfer?.transfer_date ?? "transfer date unavailable"}; received_date=${transfer?.received_date ?? "blank"}; reservation_released_at=${transfer?.reservation_released_at ?? "missing"}` : "No exact Sept 30 stock_cost_snapshots record with reconciling quantity.",
    ].map(csvCell).join(","));
  }
  await writeFile(outPath, `${output.join("\n")}\n`);

  const { rows: batchRows } = await pool.query(`
    WITH allocations AS (
      SELECT s.id sale_id,s.invoice_number,s.sale_date::date sale_date,s.created_at sale_created_at,
             s.location_type,s.location_id,(x.value->>'itemId')::int item_id,
             b.value->>'batchNumber' batch_number,(b.value->>'quantity')::numeric allocated_qty,
             (b.value->>'unitCost')::numeric allocated_unit_cost
        FROM sales s
        CROSS JOIN LATERAL jsonb_array_elements(s.line_items) x(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(x.value->'batchBreakdown','[]'::jsonb)) b(value)
    )
    SELECT DISTINCT a.sale_id,a.invoice_number,a.sale_date::text,a.sale_created_at::text,
           a.location_type,a.location_id,a.item_id,COALESCE(i.name,'') product_name,
           a.batch_number,p.id purchase_id,p.invoice_number purchase_invoice,
           p.purchase_date::text purchase_date,a.allocated_qty,a.allocated_unit_cost,
           ROUND(a.allocated_qty*a.allocated_unit_cost,2) assigned_cost_exposure,
           CASE WHEN a.sale_created_at::date>a.sale_date THEN 'BACKFILLED_AFTER_BUSINESS_DATE'
                ELSE 'CREATED_BEFORE_SOURCE_PURCHASE_DATE' END chronology_class
      FROM allocations a
      JOIN stock_batches sb ON sb.batch_number=a.batch_number AND sb.item_id=a.item_id
       AND sb.material_type='item' AND sb.branch_type=a.location_type
       AND sb.branch_id=a.location_id AND sb.source='purchase'
      JOIN purchases p ON p.id=sb.source_id
      LEFT JOIN items i ON i.id=a.item_id
     WHERE a.sale_date<p.purchase_date
     ORDER BY 3,1,7,9
  `);
  const batchHeaders = [
    "sale_id","sale_invoice","sale_business_date","sale_created_at","location_type","location_id",
    "item_id","product_name","batch_number","purchase_id","purchase_invoice","purchase_date",
    "allocated_qty","recorded_unit_cost","assigned_cost_exposure_not_proven_cogs","chronology_class",
  ];
  const batchCsv = [batchHeaders, ...batchRows.map((r: any) => [
    r.sale_id,r.invoice_number,r.sale_date,r.sale_created_at,r.location_type,r.location_id,r.item_id,
    r.product_name,r.batch_number,r.purchase_id,r.purchase_invoice,r.purchase_date,r.allocated_qty,
    r.allocated_unit_cost,r.assigned_cost_exposure,r.chronology_class,
  ])].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  await writeFile(batchPath, batchCsv);

  const postings = await buildDerivedPostings({ toDate: "2026-09-30", q: pool });
  const accounts = (await pool.query(`
    SELECT id,code,name FROM account_ledgers
     WHERE id IN (50,51,81) ORDER BY id
  `)).rows;
  const glHeaders = ["ledger_id","account_code","account_name","posting_count_through_2026_09_30","debits","credits","net_debit"];
  const glCsv = [glHeaders, ...accounts.map((account: any) => {
    const rows = postings.filter((p: any) => Number(p.ledgerId) === Number(account.id));
    const debit = rows.reduce((sum: number, p: any) => sum + Number(p.debit ?? 0), 0);
    const credit = rows.reduce((sum: number, p: any) => sum + Number(p.credit ?? 0), 0);
    return [account.id,account.code,account.name,rows.length,debit.toFixed(2),credit.toFixed(2),(debit-credit).toFixed(2)];
  })].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  await writeFile(glPath, glCsv);

  const batchStats = {
    allocationRows: batchRows.length,
    distinctSales: new Set(batchRows.map((r: any) => Number(r.sale_id))).size,
    distinctProducts: new Set(batchRows.map((r: any) => Number(r.item_id))).size,
    distinctLocations: new Set(batchRows.map((r: any) => `${r.location_type}:${r.location_id}`)).size,
    quantity: batchRows.reduce((sum: number, r: any) => sum + Number(r.allocated_qty), 0),
    assignedCostExposure: batchRows.reduce((sum: number, r: any) => sum + Number(r.assigned_cost_exposure), 0),
  };
  console.log(JSON.stringify({
    registerPath: outPath, august31Rows: baseRows.length, septemberIssues: valuation.issues.length,
    registerRows: output.length - 1, septemberIssueCodes: valuation.issues.reduce((a: any, i) => (a[i.code]=(a[i.code]??0)+1,a), {}),
    septemberPartialValue: valuation.grandTotal, septemberAcceptedRows: valuation.rows.length,
    backdatedBatchAuditPath: batchPath, batchStats, inventoryGlPath: glPath,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
