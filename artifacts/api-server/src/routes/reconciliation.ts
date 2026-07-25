import { Router } from "express";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { nextVoucherNumber } from "../lib/voucherNumber";

const router = Router();

// ── GET /reconciliation/bank-ledgers ─────────────────────────────────────────
// Returns all active ledgers under STD-BANK hierarchy (for destination dropdown)
router.get("/reconciliation/bank-ledgers", async (_req, res): Promise<void> => {
  const { rows: allLedgers } = await pool.query(`SELECT id, name, parent_id, code, bank_details FROM account_ledgers ORDER BY id`);
  const bankRoot = allLedgers.find((r: any) => r.code === "STD-BANK");
  if (!bankRoot) { res.json([]); return; }

  const ids = new Set<number>([bankRoot.id]);
  for (let i = 0; i < 5; i++) {
    for (const r of allLedgers) {
      if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
    }
  }

  // Return only leaf ledgers (non-group), excluding the root itself
  const bankLedgers = allLedgers
    .filter((r: any) => ids.has(r.id) && r.id !== bankRoot.id && !allLedgers.some((c: any) => c.parent_id === r.id))
    .map((r: any) => ({
      id: r.id,
      name: r.name,
      code: r.code ?? null,
      bankDetails: r.bank_details ?? null,
    }));

  res.json(bankLedgers);
});

// ── GET /reconciliation/pending ───────────────────────────────────────────────
// Lists all pending electronic sale_payments
router.get("/reconciliation/pending", async (req, res): Promise<void> => {
  const { outletId, method, fromDate, toDate, search } = req.query as Record<string, string | undefined>;

  const params: any[] = ["pending"];
  const conds: string[] = ["sp.reconciliation_status = $1"];

  if (outletId) { params.push(Number(outletId)); conds.push(`sp.outlet_id = $${params.length}`); }
  if (method)   { params.push(method);            conds.push(`sp.method = $${params.length}`); }
  if (fromDate) { params.push(fromDate);           conds.push(`sp.payment_date >= $${params.length}`); }
  if (toDate)   { params.push(toDate);             conds.push(`sp.payment_date <= $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const where = conds.join(" AND ");
  const { rows } = await pool.query(
    `SELECT sp.id, sp.sale_id, sp.payment_date, sp.method, sp.amount::numeric AS amount,
            sp.reference_number, sp.notes, sp.reconciliation_status, sp.outlet_id,
            sp.created_at,
            s.invoice_number,
            o.name AS outlet_name,
            c.name AS customer_name
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     JOIN outlets o ON o.id = sp.outlet_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${where}
     ORDER BY sp.payment_date DESC, sp.id DESC`,
    params
  );

  res.json(rows.map((r: any) => ({
    id: r.id,
    saleId: r.sale_id,
    paymentDate: r.payment_date,
    method: r.method,
    amount: Number(r.amount),
    referenceNumber: r.reference_number,
    notes: r.notes,
    reconciliationStatus: r.reconciliation_status,
    outletId: r.outlet_id,
    createdAt: r.created_at,
    invoiceNumber: r.invoice_number,
    outletName: r.outlet_name,
    customerName: r.customer_name ?? null,
  })));
});

// ── GET /reconciliation/batches ───────────────────────────────────────────────
router.get("/reconciliation/batches", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT rb.*,
            rb.gross_amount::numeric AS gross_amount,
            rb.charges::numeric AS charges,
            rb.net_amount::numeric AS net_amount,
            al.name AS bank_ledger_name,
            COUNT(rbi.id)::int AS item_count
     FROM reconciliation_batches rb
     LEFT JOIN account_ledgers al ON al.id = rb.destination_bank_ledger_id
     LEFT JOIN reconciliation_batch_items rbi ON rbi.batch_id = rb.id
     GROUP BY rb.id, al.name
     ORDER BY rb.created_at DESC`
  );

  res.json(rows.map((r: any) => ({
    id: r.id,
    batchReference: r.batch_reference,
    settlementDate: r.settlement_date,
    grossAmount: Number(r.gross_amount),
    charges: Number(r.charges),
    netAmount: Number(r.net_amount),
    destinationBankLedgerId: r.destination_bank_ledger_id,
    bankLedgerName: r.bank_ledger_name ?? "",
    externalReference: r.external_reference,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    status: r.status,
    itemCount: r.item_count,
  })));
});

// ── GET /reconciliation/batches/:id ──────────────────────────────────────────
router.get("/reconciliation/batches/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid batch id" }); return; }

  const { rows: [batch] } = await pool.query(
    `SELECT rb.*,
            rb.gross_amount::numeric AS gross_amount,
            rb.charges::numeric AS charges,
            rb.net_amount::numeric AS net_amount,
            al.name AS bank_ledger_name
     FROM reconciliation_batches rb
     LEFT JOIN account_ledgers al ON al.id = rb.destination_bank_ledger_id
     WHERE rb.id = $1`,
    [id]
  );
  if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }

  const { rows: items } = await pool.query(
    `SELECT rbi.id, rbi.sale_payment_id, rbi.amount::numeric AS amount,
            sp.method, sp.payment_date, sp.reference_number,
            s.invoice_number, s.id AS sale_id,
            o.name AS outlet_name,
            c.name AS customer_name
     FROM reconciliation_batch_items rbi
     JOIN sale_payments sp ON sp.id = rbi.sale_payment_id
     JOIN sales s ON s.id = sp.sale_id
     JOIN outlets o ON o.id = sp.outlet_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE rbi.batch_id = $1
     ORDER BY sp.payment_date`,
    [id]
  );

  res.json({
    id: batch.id,
    batchReference: batch.batch_reference,
    settlementDate: batch.settlement_date,
    grossAmount: Number(batch.gross_amount),
    charges: Number(batch.charges),
    netAmount: Number(batch.net_amount),
    destinationBankLedgerId: batch.destination_bank_ledger_id,
    bankLedgerName: batch.bank_ledger_name ?? "",
    externalReference: batch.external_reference,
    notes: batch.notes,
    createdBy: batch.created_by,
    createdAt: batch.created_at,
    status: batch.status,
    items: items.map((i: any) => ({
      id: i.id,
      salePaymentId: i.sale_payment_id,
      amount: Number(i.amount),
      method: i.method,
      paymentDate: i.payment_date,
      referenceNumber: i.reference_number,
      invoiceNumber: i.invoice_number,
      saleId: i.sale_id,
      outletName: i.outlet_name,
      customerName: i.customer_name ?? null,
    })),
  });
});

// ── POST /reconciliation/batches ──────────────────────────────────────────────
router.post("/reconciliation/batches", async (req, res): Promise<void> => {
  const {
    salePaymentIds, charges, settlementDate,
    destinationBankLedgerId, externalReference, notes,
  } = req.body as {
    salePaymentIds: number[];
    charges: number;
    settlementDate: string;
    destinationBankLedgerId: number;
    externalReference?: string;
    notes?: string;
  };

  if (!Array.isArray(salePaymentIds) || salePaymentIds.length === 0) {
    res.status(400).json({ error: "salePaymentIds must be a non-empty array" }); return;
  }
  if (!settlementDate) { res.status(400).json({ error: "settlementDate is required" }); return; }
  if (!destinationBankLedgerId) { res.status(400).json({ error: "destinationBankLedgerId is required" }); return; }

  const parsedCharges = Number(charges ?? 0);
  if (parsedCharges < 0) { res.status(400).json({ error: "charges cannot be negative" }); return; }

  const createdBy = (req as any).user?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Verify all payments exist, are pending, and lock them
    const { rows: payments } = await client.query(
      `SELECT id, amount::numeric AS amount, reconciliation_status, sale_id
       FROM sale_payments WHERE id = ANY($1) FOR UPDATE`,
      [salePaymentIds]
    );

    if (payments.length !== salePaymentIds.length) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "One or more payment IDs not found" }); return;
    }

    const nonPending = payments.filter((p: any) => p.reconciliation_status !== "pending");
    if (nonPending.length > 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Payments ${nonPending.map((p: any) => p.id).join(", ")} are not pending reconciliation` }); return;
    }

    // 2. Compute gross
    const grossAmount = payments.reduce((s: number, p: any) => s + Number(p.amount), 0);
    const netAmount   = grossAmount - parsedCharges;

    if (netAmount <= 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Net amount (₹${netAmount.toFixed(2)}) must be positive. Reduce charges.` }); return;
    }
    if (parsedCharges >= grossAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Charges cannot be greater than or equal to gross amount" }); return;
    }

    // 3. Verify destination bank ledger is under STD-BANK
    const { rows: allLedgers } = await client.query(`SELECT id, parent_id, code FROM account_ledgers`);
    const bankRoot = allLedgers.find((l: any) => l.code === "STD-BANK");
    if (!bankRoot) { await client.query("ROLLBACK"); res.status(500).json({ error: "STD-BANK ledger not found" }); return; }

    const bankIds = new Set<number>([bankRoot.id]);
    for (let i = 0; i < 5; i++) {
      for (const l of allLedgers) {
        if (l.parent_id && bankIds.has(l.parent_id)) bankIds.add(l.id);
      }
    }
    if (!bankIds.has(Number(destinationBankLedgerId))) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Destination ledger must be a bank account under the Bank ledger group" }); return;
    }

    // 4. Get STD-ELEC-CLR ledger
    const { rows: [clearingLedger] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
    );
    if (!clearingLedger) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Electronic clearing ledger not configured" }); return;
    }

    // 5. Get STD-PROC-CHG ledger (for charges)
    const { rows: [chargesLedger] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = 'STD-PROC-CHG'`
    );
    if (!chargesLedger && parsedCharges > 0) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Processor charges ledger not configured" }); return;
    }

    // 6. Generate batch reference
    const year = new Date().getFullYear();
    const { rows: [cntRow] } = await client.query(`SELECT COUNT(*) FROM reconciliation_batches WHERE batch_reference LIKE $1`, [`RECON-${year}-%`]);
    const seq = Number(cntRow.count) + 1;
    const batchReference = `RECON-${year}-${String(seq).padStart(4, "0")}`;

    // 7. Create reconciliation batch
    const { rows: [batch] } = await client.query(
      `INSERT INTO reconciliation_batches (batch_reference, settlement_date, gross_amount, charges, net_amount, destination_bank_ledger_id, external_reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [batchReference, settlementDate, grossAmount, parsedCharges, netAmount, destinationBankLedgerId, externalReference ?? null, notes ?? null, createdBy]
    );

    // 8. Create batch items and mark payments reconciled
    for (const p of payments) {
      await client.query(
        `INSERT INTO reconciliation_batch_items (batch_id, sale_payment_id, amount) VALUES ($1, $2, $3)`,
        [batch.id, p.id, Number(p.amount)]
      );
      await client.query(
        `UPDATE sale_payments SET reconciliation_status = 'reconciled' WHERE id = $1`,
        [p.id]
      );
    }

    // 9. Post accounting entries
    // Dr Bank (net) — receipt: received_from=clearing, received_in=bank
    const recVoucher = await nextVoucherNumber(client, 'receipt', settlementDate);
    await client.query(
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [recVoucher, settlementDate, clearingLedger.id, destinationBankLedgerId, netAmount,
        `Bank settlement ${batchReference} — ${payments.length} payments`]
    );

    // Dr Charges expense (if any) — payment: paid_from=clearing, paid_to=charges ledger
    if (parsedCharges > 0 && chargesLedger) {
      const payVoucher = await nextVoucherNumber(client, 'payment', settlementDate);
      await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [payVoucher, settlementDate, clearingLedger.id, chargesLedger.id, parsedCharges,
          `Processor charges for ${batchReference}`]
      );
    }

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "reconciliation", entityType: "reconciliation_batch", entityId: batch.id,
      description: `Reconciliation batch ${batchReference} — ${payments.length} payments, net ₹${netAmount}`,
      metadata: { after: { batchReference, grossAmount, charges: parsedCharges, netAmount, itemCount: payments.length } },
    }).catch(() => {});

    res.status(201).json({
      id: batch.id,
      batchReference,
      settlementDate,
      grossAmount,
      charges: parsedCharges,
      netAmount,
      destinationBankLedgerId,
      itemCount: payments.length,
      status: "active",
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Reconciliation error:", err);
    res.status(500).json({ error: err.message ?? "Failed to create reconciliation batch" });
  } finally {
    client.release();
  }
});

export default router;
