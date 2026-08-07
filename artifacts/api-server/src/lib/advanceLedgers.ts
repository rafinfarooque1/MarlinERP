import { pool } from "@workspace/db";
import { resolveChartParentId } from "./chartGroups";

/**
 * Party advances — bill-wise settlement.
 *
 * CUSTOMER side (business decision, Aug 2026 — final): there is NO separate
 * customer-advance ledger. Every customer has exactly ONE ledger,
 * CUST-<id> under Sundry Debtors, and an advance is simply a CREDIT
 * (negative) balance on it. "Available advance" = max(0, −net) of that
 * ledger.
 *
 * VENDOR side is unchanged: money paid beyond a vendor's bills parks in
 *
 *   VADV-<vendorId>  "…— Advance"  asset, under Vendor Advances (SYS-CURA)
 *
 * The VADV code deliberately does NOT extend the VEND- prefix: several
 * queries parse a party id straight out of party codes with
 * `SUBSTRING(code FROM 6)::int` / `code LIKE 'VEND-%'`, and a VEND-ADV-7 row
 * would make every one of them throw or mis-parse.
 *
 * Availability is LEDGER-AUTHORITATIVE: it is a ledger balance in the derived
 * posting stream, not a hand-summed pair of columns — so a manual journal
 * touching the ledger moves the figure the same way a receipt does.
 */

export type AdvanceKind = "customer" | "vendor";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> };

export const VENDOR_ADVANCE_CONTAINER = "STD-GRP-VEND-ADV";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ledger a party's advance lives on. For a customer that is their ONE
 * Sundry Debtor ledger (advance = credit balance); for a vendor it is the
 * dedicated VADV- asset ledger.
 */
export function advanceLedgerCode(kind: AdvanceKind, partyId: number): string {
  return kind === "customer" ? `CUST-${partyId}` : `VADV-${partyId}`;
}

/**
 * Parse a party ledger code (CUST-<id> / VEND-<id>) into its party. Returns
 * null for anything else — including the advance ledgers themselves.
 */
export function parsePartyLedgerCode(
  code: string | null | undefined,
): { kind: AdvanceKind; partyId: number } | null {
  if (!code) return null;
  let m = /^CUST-(\d+)$/.exec(code);
  if (m) return { kind: "customer", partyId: Number(m[1]) };
  m = /^VEND-(\d+)$/.exec(code);
  if (m) return { kind: "vendor", partyId: Number(m[1]) };
  return null;
}

/**
 * Get-or-create the advance ledger for a party. Safe to call inside a
 * transaction (pass the tx client) — the container lookup goes through the
 * shared pool (idempotent either way), the ledger insert rides the caller's
 * transaction. Concurrency-safe via ON CONFLICT + re-select, the same pattern
 * every other system-ledger provisioner uses.
 *
 * Customers never get a second ledger: their advance IS the credit side of
 * their own CUST- ledger, which is provisioned with the customer itself, so
 * for customers this only resolves (and refuses to invent a misparented row).
 */
export async function ensureAdvanceLedger(
  q: Queryable,
  kind: AdvanceKind,
  partyId: number,
  partyName: string,
): Promise<number> {
  const code = advanceLedgerCode(kind, partyId);
  const { rows: [existing] } = await q.query(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  if (existing) return Number(existing.id);
  if (kind === "customer") {
    // CUST- ledgers are created with the customer (and healed by the boot
    // sweep); a missing one is a data problem this helper must not paper over.
    throw new Error(`Customer ${partyId} (${partyName}) has no CUST-${partyId} ledger to hold their advance`);
  }

  const parentId = await resolveChartParentId(pool, VENDOR_ADVANCE_CONTAINER);
  const type = "asset";
  const name = `${partyName} — Advance`;
  const description = "Money paid to the vendor beyond their bills, adjustable against future purchases";

  const { rows: [created] } = await q.query(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, $2, $3, 'balance_sheet', $4, false, false, $5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, type, code, parentId, description],
  );
  if (created) return Number(created.id);
  const { rows: [retry] } = await q.query(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  if (!retry) throw new Error(`Failed to provision advance ledger ${code}`);
  return Number(retry.id);
}

export interface AdvancePosition {
  ledgerId: number | null;
  /** What can still be adjusted against new bills. Never negative. */
  available: number;
}

/**
 * The party's usable advance, from the books. A customer's advance is the
 * CREDIT (negative) balance of their single Sundry Debtor ledger — the net of
 * everything: bills, receipts, credit notes, journals. Vendor advances live on
 * the dedicated VADV asset ledger (debit balance = available). Reads only
 * COMMITTED data — callers that consume an advance must serialize on the
 * party's advisory lock (see takeAdvanceLock) so two writers cannot both read
 * the same balance.
 */
export async function advanceAvailable(
  kind: AdvanceKind,
  partyId: number,
): Promise<AdvancePosition> {
  const code = advanceLedgerCode(kind, partyId);
  const { rows: [ledger] } = await pool.query(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  if (!ledger) return { ledgerId: null, available: 0 };
  const ledgerId = Number(ledger.id);
  // Dynamic import: ledgerBalances → routes/journal would close an import
  // cycle if pulled in at module load (same reason currentBalanceIndex does it).
  const { currentBalanceIndex } = await import("./ledgerBalances");
  const idx = await currentBalanceIndex();
  const net = idx.net(ledgerId); // raw Dr − Cr
  const available = kind === "customer" ? r2(Math.max(0, -net)) : r2(Math.max(0, net));
  return { ledgerId, available };
}

/**
 * Bulk form of advanceAvailable for list endpoints: partyId → usable advance,
 * from the SAME balance index the caller already holds. Parties with zero
 * available are simply absent from the map. This exists so list endpoints
 * never invent their own advance definition. For customers the source is the
 * credit side of their own CUST- ledger; for vendors the VADV- ledger.
 */
export async function advanceBalanceMap(
  kind: AdvanceKind,
  idx: { net(ledgerId: number): number },
): Promise<Map<number, number>> {
  const prefix = kind === "customer" ? "CUST-" : "VADV-";
  const { rows } = await pool.query<{ id: number; code: string }>(
    `SELECT id, code FROM account_ledgers WHERE code LIKE $1`, [`${prefix}%`],
  );
  const map = new Map<number, number>();
  for (const r of rows) {
    const m = /^(?:CUST|VADV)-(\d+)$/.exec(String(r.code));
    if (!m) continue;
    const net = idx.net(Number(r.id)); // raw Dr − Cr
    const available = kind === "customer" ? r2(Math.max(0, -net)) : r2(Math.max(0, net));
    if (available > 0.004) map.set(Number(m[1]), available);
  }
  return map;
}

/**
 * Advisory-lock key that serializes everything which CONSUMES a party's
 * advance (sale creation, purchase creation, allocation-receipt deletion).
 * Creation of an advance only ever adds, so it does not need the lock.
 */
export const ADVANCE_LOCK_NS = { customer: "customer-advance", vendor: "vendor-advance" } as const;

export async function takeAdvanceLock(q: Queryable, kind: AdvanceKind, partyId: number): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [ADVANCE_LOCK_NS[kind], partyId]);
}

// ── Slice-level consumption attribution ─────────────────────────────────────
// `advance_consumptions` records WHICH parking voucher funded each adjustment,
// FIFO oldest-voucher-first, at the moment a sale/purchase consumes an advance.
// The rows are the reference the delete guards check: a parking voucher is
// deletable only while NOTHING points at it — an aggregate balance check would
// wave the delete through whenever a second, unrelated advance happened to
// cover the shortfall, silently rewriting which money settled which bill.

/**
 * Attribute `amount` of a fresh consumption to the vouchers that parked the
 * party's advance. MUST run inside the caller's transaction, under the party's
 * advance lock, in the same txn that wrote the consumption itself (the
 * sale_payments 'advance' row or the purchase_advance_applications row).
 * A remainder not covered by any voucher slice (money parked via a manual
 * journal) is recorded with a NULL source so the total always reconciles.
 */
export async function attributeAdvanceConsumption(
  q: Queryable,
  kind: AdvanceKind,
  partyId: number,
  consumer: { saleId?: number; purchaseId?: number },
  amount: number,
): Promise<void> {
  let left = r2(amount);
  if (left <= 0.004) return;
  const saleId = consumer.saleId ?? null;
  const purchaseId = consumer.purchaseId ?? null;

  // Parking vouchers oldest-first with how much of each slice is still free.
  const { rows: sources } = kind === "customer"
    ? await q.query(
        `SELECT r.id, r.advance_amount::numeric AS parked,
                COALESCE((SELECT SUM(ac.amount)::numeric FROM advance_consumptions ac
                           WHERE ac.source_receipt_id = r.id), 0) AS used
           FROM receipts r
           JOIN account_ledgers al ON al.id = r.received_from_ledger_id
          WHERE al.code = $1 AND r.advance_amount > 0.004
          ORDER BY r.receipt_date ASC, r.id ASC`,
        [`CUST-${partyId}`],
      )
    : await q.query(
        `SELECT p.id, p.advance_amount::numeric AS parked,
                COALESCE((SELECT SUM(ac.amount)::numeric FROM advance_consumptions ac
                           WHERE ac.source_payment_id = p.id), 0) AS used
           FROM payments p
           JOIN account_ledgers al ON al.id = p.paid_to_ledger_id
          WHERE al.code = $1 AND p.advance_amount > 0.004
          ORDER BY p.payment_date ASC, p.id ASC`,
        [`VEND-${partyId}`],
      );

  for (const s of sources) {
    if (left <= 0.004) break;
    const free = r2(Number(s.parked) - Number(s.used));
    if (free <= 0.004) continue;
    const take = r2(Math.min(free, left));
    await q.query(
      `INSERT INTO advance_consumptions
         (party_kind, party_id, source_receipt_id, source_payment_id, consumer_sale_id, consumer_purchase_id, amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [kind, partyId,
       kind === "customer" ? s.id : null,
       kind === "vendor" ? s.id : null,
       saleId, purchaseId, take],
    );
    left = r2(left - take);
  }
  if (left > 0.004) {
    // Funded by a manual journal (or a pre-attribution voucher): keep the
    // total honest with an unattributed row.
    await q.query(
      `INSERT INTO advance_consumptions
         (party_kind, party_id, source_receipt_id, source_payment_id, consumer_sale_id, consumer_purchase_id, amount)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5)`,
      [kind, partyId, saleId, purchaseId, left],
    );
  }
}

/** Total consumption attributed to a parking voucher — the precise delete guard. */
export async function voucherAdvanceConsumed(
  q: Queryable,
  source: "receipt" | "payment",
  voucherId: number,
): Promise<number> {
  const col = source === "receipt" ? "source_receipt_id" : "source_payment_id";
  const { rows: [r] } = await q.query(
    `SELECT COALESCE(SUM(amount)::numeric, 0) AS used FROM advance_consumptions WHERE ${col} = $1`,
    [voucherId],
  );
  return r2(Number(r?.used ?? 0));
}

/**
 * Free the slices a consumer had taken — call inside the transaction that
 * cancels the sale or deletes the purchase, so the parking vouchers become
 * deletable again in the same atomic step.
 */
export async function releaseAdvanceConsumption(
  q: Queryable,
  consumer: { saleId?: number; purchaseId?: number },
): Promise<void> {
  if (consumer.saleId) {
    await q.query(`DELETE FROM advance_consumptions WHERE consumer_sale_id = $1`, [consumer.saleId]);
  }
  if (consumer.purchaseId) {
    await q.query(`DELETE FROM advance_consumptions WHERE consumer_purchase_id = $1`, [consumer.purchaseId]);
  }
}
