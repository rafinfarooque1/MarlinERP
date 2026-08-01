import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { isIsoDate } from "../lib/dateInput";
import { LEGACY_BANK_MODES } from "../lib/paymentModes";
import { getLocationFilter } from "../lib/requestLocation";

const router = Router();

// A sale's location is `location_type` + `location_id`. `sale_payments.outlet_id`
// is copied from the legacy `sales.outlet_id`, which is null for warehouse sales
// and stale on others (a warehouse sale can still carry an old outlet id), so
// joining payments through it hides every warehouse receipt from reconciliation
// and mislabels some of the ones it does return. Resolve the location from the
// sale itself. Both joins are LEFT so a payment is never dropped for want of a
// location record.
const SALE_LOCATION_JOINS = `
     LEFT JOIN outlets    o ON s.location_type = 'outlet'    AND o.id = s.location_id
     LEFT JOIN warehouses w ON s.location_type = 'warehouse' AND w.id = s.location_id`;
const SALE_LOCATION_NAME = `COALESCE(o.name, w.name)`;

/**
 * Restrict a payment query to the caller's own location. Head office sees every
 * location; anyone bound to one sees only theirs. Scoping on the sale's location
 * rather than on `sale_payments.outlet_id` is what lets warehouse staff see
 * their own receipts at all.
 */
function applyLocationScope(
  req: any,
  params: any[],
  conds: string[],
  filter: { locationType?: string; locationId?: string; outletId?: string },
): void {
  const emp = req.employee as { branchType?: string; branchId?: number } | undefined;
  if (emp && emp.branchType && emp.branchType !== "headoffice" && emp.branchId != null) {
    params.push(emp.branchType); const t = params.length;
    params.push(emp.branchId);   const i = params.length;
    conds.push(`(s.location_type = $${t} AND s.location_id = $${i})`);
    return;
  }
  // `outletId` is the older param name for the same filter, and always an outlet.
  const type = filter.locationType ?? (filter.outletId ? "outlet" : undefined);
  const id = filter.locationId ?? filter.outletId;
  if (!type || !id) {
    // Global location context (headers) — applies only when the page passed
    // no explicit filter of its own. HO matches on type alone.
    const viewLoc = getLocationFilter(req);
    if (viewLoc) {
      params.push(viewLoc.locationType); const t = params.length;
      if (viewLoc.locationType === "headoffice") {
        conds.push(`s.location_type = $${t}`);
      } else {
        params.push(viewLoc.locationId); const i = params.length;
        conds.push(`(s.location_type = $${t} AND s.location_id = $${i})`);
      }
    }
    return;
  }
  params.push(type); const t = params.length;
  params.push(Number(id)); const i = params.length;
  conds.push(`(s.location_type = $${t} AND s.location_id = $${i})`);
}

// ── GET /reconciliation/bank-ledgers ─────────────────────────────────────────
// Returns all active ledgers under STD-BANK hierarchy (for destination dropdown)
// Serves Reconciliation, Cash Balance (accounts + sales) pages.
router.get("/reconciliation/bank-ledgers", requireModuleView(["page:/accounts/reconciliation", "page:/accounts/cash-in-outlet"]), async (_req, res): Promise<void> => {
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

// ── POST /reconciliation/bank-accounts ───────────────────────────────────────
// A bank account is the one balance-sheet leaf with no master record of its own,
// so retiring hand-made ledgers left it with no way to exist — and a batch cannot
// be settled without a destination account, which would strand reconciliation
// entirely on a fresh install. Provisioning the account creates its ledger, which
// is the same rule every other ledger in the chart now follows.
router.post(
  "/reconciliation/bank-accounts",
  requireModuleAction("page:/accounts/reconciliation", "add"),
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    /** Trimmed text, or `undefined` when the value is the wrong type or too long. */
    const readText = (key: string, max: number): string | undefined => {
      const raw = body[key];
      if (raw === undefined || raw === null) return "";
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim();
      return trimmed.length > max ? undefined : trimmed;
    };

    const name = readText("name", 120);
    const bankName = readText("bankName", 120);
    const accountNumber = readText("accountNumber", 64);
    const ifscCode = readText("ifscCode", 32);
    const branch = readText("branch", 120);

    if ([name, bankName, accountNumber, ifscCode, branch].some((v) => v === undefined)) {
      res.status(400).json({ error: "Bank account details must be text within the allowed length." });
      return;
    }
    if (!name) { res.status(400).json({ error: "Give the bank account a name." }); return; }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Check-then-insert has to be one writer at a time or two clicks race past
      // the duplicate check and leave two ledgers with the same name.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('reconciliation:bank-account:create'))");

      const { rows: [bankRoot] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-BANK' LIMIT 1`,
      );
      if (!bankRoot) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "The standard Bank group is missing from the chart of accounts." });
        return;
      }

      const { rows: [dupe] } = await client.query(
        `SELECT id FROM account_ledgers WHERE parent_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [bankRoot.id, name],
      );
      if (dupe) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: `A bank account named "${name}" already exists.` });
        return;
      }

      const bankDetails = {
        bankName: bankName ?? "",
        accountNumber: accountNumber ?? "",
        ifscCode: ifscCode ?? "",
        branch: branch ?? "",
      };
      const { rows: [created] } = await client.query(
        `INSERT INTO account_ledgers (name, type, parent_id, section, is_system_group, is_group, bank_details)
         VALUES ($1, 'asset', $2, NULL, false, false, $3::jsonb)
         RETURNING id, name, bank_details`,
        [name, bankRoot.id, JSON.stringify(bankDetails)],
      );
      await client.query("COMMIT");

      logActivity({
        action: "CREATE", module: "reconciliation", entityType: "bank_account", entityId: created.id,
        description: `Bank account ${name}`,
        metadata: { after: { name, ...bankDetails } },
      }).catch(() => {});

      res.status(201).json({
        id: created.id,
        name: created.name,
        code: null,
        bankDetails: created.bank_details ?? null,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
);

// ── GET /reconciliation/pending ───────────────────────────────────────────────
// Lists all pending electronic sale_payments
router.get("/reconciliation/pending", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const { outletId, locationType, locationId, method, fromDate, toDate, search } =
    req.query as Record<string, string | undefined>;

  const params: any[] = ["pending"];
  const conds: string[] = ["sp.reconciliation_status = $1"];

  applyLocationScope(req, params, conds, { locationType, locationId, outletId });
  // 'bank' also matches the legacy 'card' / 'bank_transfer' values, which mean
  // the same thing and are never rewritten in place.
  if (method) {
    const matches = method === 'bank' ? ['bank', ...LEGACY_BANK_MODES] : [method];
    params.push(matches); conds.push(`sp.method = ANY($${params.length}::text[])`);
  }
  if (fromDate) { params.push(fromDate);           conds.push(`sp.payment_date >= $${params.length}`); }
  if (toDate)   { params.push(toDate);             conds.push(`sp.payment_date <= $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const where = conds.join(" AND ");
  const { rows } = await pool.query(
    `SELECT sp.id, sp.sale_id, sp.payment_date, sp.method, sp.amount::numeric AS amount,
            sp.reference_number, sp.notes, sp.reconciliation_status,
            sp.created_at,
            s.invoice_number, s.location_type, s.location_id::int AS location_id,
            ${SALE_LOCATION_NAME} AS location_name,
            c.name AS customer_name
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     ${SALE_LOCATION_JOINS}
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
    locationType: r.location_type,
    locationId: r.location_id,
    createdAt: r.created_at,
    invoiceNumber: r.invoice_number,
    locationName: r.location_name ?? "—",
    customerName: r.customer_name ?? null,
  })));
});

// ── GET /reconciliation/batches ───────────────────────────────────────────────
router.get("/reconciliation/batches", requireModuleView("page:/accounts/reconciliation"), async (_req, res): Promise<void> => {
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
router.get("/reconciliation/batches/:id", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
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
            ${SALE_LOCATION_NAME} AS location_name,
            c.name AS customer_name
     FROM reconciliation_batch_items rbi
     JOIN sale_payments sp ON sp.id = rbi.sale_payment_id
     JOIN sales s ON s.id = sp.sale_id
     ${SALE_LOCATION_JOINS}
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
      locationName: i.location_name ?? "—",
      customerName: i.customer_name ?? null,
    })),
  });
});

// ── POST /reconciliation/batches ──────────────────────────────────────────────
router.post("/reconciliation/batches", requireModuleAction("page:/accounts/reconciliation", "add"), async (req, res): Promise<void> => {
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
  if (!isIsoDate(settlementDate)) { res.status(400).json({ error: "settlementDate must be a real calendar date in YYYY-MM-DD form" }); return; }
  if (!destinationBankLedgerId) { res.status(400).json({ error: "destinationBankLedgerId is required" }); return; }

  const parsedCharges = Number(charges ?? 0);
  if (parsedCharges < 0) { res.status(400).json({ error: "charges cannot be negative" }); return; }

  const createdBy = (req as any).employee?.username ?? "system";

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

    // 6. Generate batch reference — COUNT(*) is a duplicate-key bug (deleting a
    //    row makes the next insert reuse a number, and concurrent inserts collide).
    //    Serialize allocation with a per-year advisory lock (held to COMMIT) and
    //    derive the next sequence from MAX(existing suffix)+1 INSIDE the txn —
    //    the check-then-insert guard pattern used elsewhere in this codebase.
    const year = new Date().getFullYear();
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('reconciliation-batch-ref'), $1)`, [year]);
    const { rows: [maxRow] } = await client.query(
      `SELECT COALESCE(MAX((regexp_replace(batch_reference, '^RECON-\\d+-', ''))::int), 0) AS max_seq
       FROM reconciliation_batches
       WHERE batch_reference ~ ('^RECON-' || $1 || '-\\d+$')`,
      [String(year)]
    );
    const seq = Number(maxRow.max_seq) + 1;
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
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'settlement')`,
      [recVoucher, settlementDate, clearingLedger.id, destinationBankLedgerId, netAmount,
        `Bank settlement ${batchReference} — ${payments.length} payments`]
    );

    // Dr Charges expense (if any) — payment: paid_from=clearing, paid_to=charges ledger
    if (parsedCharges > 0 && chargesLedger) {
      const payVoucher = await nextVoucherNumber(client, 'payment', settlementDate);
      await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'settlement')`,
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

// ── GET /reconciliation/reconciled ────────────────────────────────────────────
// Lists reconciled + matched sale_payments so a user can prove (Match) an entry
// against a specific ledger posting/voucher, or reverse a match (Un-match).
// The matched_* audit columns are startup-migration columns INVISIBLE to
// Drizzle, so they are read here with raw SQL via `pool`.
router.get("/reconciliation/reconciled", requireModuleView("page:/accounts/reconciliation"), async (req, res): Promise<void> => {
  const { outletId, locationType, locationId, method, status, fromDate, toDate, search } =
    req.query as Record<string, string | undefined>;

  const params: any[] = [];
  const conds: string[] = [];

  // Only the two post-pending states are relevant here.
  if (status === 'reconciled' || status === 'matched') {
    params.push(status); conds.push(`sp.reconciliation_status = $${params.length}`);
  } else {
    params.push(['reconciled', 'matched']); conds.push(`sp.reconciliation_status = ANY($${params.length}::text[])`);
  }

  applyLocationScope(req, params, conds, { locationType, locationId, outletId });
  if (method) {
    const matches = method === 'bank' ? ['bank', ...LEGACY_BANK_MODES] : [method];
    params.push(matches); conds.push(`sp.method = ANY($${params.length}::text[])`);
  }
  if (fromDate) { params.push(fromDate); conds.push(`sp.payment_date >= $${params.length}`); }
  if (toDate)   { params.push(toDate);   conds.push(`sp.payment_date <= $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const where = conds.join(" AND ");
  const { rows } = await pool.query(
    `SELECT sp.id, sp.sale_id, sp.payment_date, sp.method, sp.amount::numeric AS amount,
            sp.reference_number, sp.notes, sp.reconciliation_status,
            sp.created_at, sp.matched_reference, sp.matched_by, sp.matched_at,
            s.invoice_number, s.location_type, s.location_id::int AS location_id,
            ${SALE_LOCATION_NAME} AS location_name,
            c.name AS customer_name
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     ${SALE_LOCATION_JOINS}
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
    matchedReference: r.matched_reference ?? null,
    matchedBy: r.matched_by ?? null,
    matchedAt: r.matched_at ?? null,
    invoiceNumber: r.invoice_number,
    locationName: r.location_name ?? "—",
    customerName: r.customer_name ?? null,
  })));
});

// ── POST /reconciliation/:id/match ────────────────────────────────────────────
// Transition Reconciled -> Matched. Ties the entry to a specific ledger
// posting / voucher reference so it can be PROVEN. Records who matched it and
// when. Only a Reconciled entry may become Matched — any other current state
// is rejected with 409 stating the state it is actually in.
// matched_* are startup-migration columns invisible to Drizzle → write via `pool`.
router.post("/reconciliation/:id/match", requireModuleAction("page:/accounts/reconciliation", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }

  const matchedReference = String((req.body as any)?.matchedReference ?? "").trim();
  if (!matchedReference) {
    res.status(400).json({ error: "matchedReference is required — the voucher / ledger posting this entry proves against" });
    return;
  }

  const matchedBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [payment] } = await client.query(
      `SELECT id, reconciliation_status FROM sale_payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!payment) { await client.query("ROLLBACK"); res.status(404).json({ error: "Payment not found" }); return; }

    if (payment.reconciliation_status !== 'reconciled') {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Only a Reconciled entry may be Matched. This entry is currently "${payment.reconciliation_status ?? 'pending'}".`,
      });
      return;
    }

    await client.query(
      `UPDATE sale_payments
       SET reconciliation_status = 'matched',
           matched_reference = $2,
           matched_by = $3,
           matched_at = now()
       WHERE id = $1`,
      [id, matchedReference, matchedBy]
    );

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE", module: "reconciliation", entityType: "sale_payment", entityId: id,
      description: `Matched payment #${id} to ${matchedReference}`,
      metadata: { after: { reconciliationStatus: 'matched', matchedReference, matchedBy } },
    }).catch(() => {});

    res.json({ id, reconciliationStatus: 'matched', matchedReference, matchedBy });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Match error:", err);
    res.status(500).json({ error: err.message ?? "Failed to match payment" });
  } finally {
    client.release();
  }
});

// ── POST /reconciliation/:id/unmatch ──────────────────────────────────────────
// Reverse a match: Matched -> Reconciled, clearing the stored reference and
// audit stamps. Only a Matched entry may be un-matched; anything else is 409.
router.post("/reconciliation/:id/unmatch", requireModuleAction("page:/accounts/reconciliation", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [payment] } = await client.query(
      `SELECT id, reconciliation_status FROM sale_payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!payment) { await client.query("ROLLBACK"); res.status(404).json({ error: "Payment not found" }); return; }

    if (payment.reconciliation_status !== 'matched') {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Only a Matched entry may be un-matched. This entry is currently "${payment.reconciliation_status ?? 'pending'}".`,
      });
      return;
    }

    await client.query(
      `UPDATE sale_payments
       SET reconciliation_status = 'reconciled',
           matched_reference = NULL,
           matched_by = NULL,
           matched_at = NULL
       WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE", module: "reconciliation", entityType: "sale_payment", entityId: id,
      description: `Un-matched payment #${id} (reverted to reconciled)`,
      metadata: { after: { reconciliationStatus: 'reconciled' } },
    }).catch(() => {});

    res.json({ id, reconciliationStatus: 'reconciled', matchedReference: null });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Un-match error:", err);
    res.status(500).json({ error: err.message ?? "Failed to un-match payment" });
  } finally {
    client.release();
  }
});

export default router;
