/**
 * Per-bill settlement of purchases, for surfaces that must show a payment
 * status against a vendor bill (the GST purchase register).
 *
 * Purchases carry no amount_paid: vendor money moves through the party ledger
 * (payments, debit notes, plain journals). The FIFO derivation here mirrors
 * the payables ageing report EXACTLY — the settled pool per vendor is
 * "billed − ledger balance" from the authoritative posting stream, so a bill
 * this module calls paid is the same bill the ageing stops ageing. Asset
 * purchases join the FIFO walk (they consume the same pool, oldest-first)
 * even though callers only read stock-purchase rows.
 *
 * Payment MODES are attribution, not accounting: settlement chunks (payment
 * vouchers by date, then debit notes, then a synthetic "Journal" remainder
 * when the ledger settled more than those documents show) are consumed in
 * order as the pool allocates, so each bill reports the modes of the money
 * that actually reached it under FIFO.
 */
import { pool } from "@workspace/db";
import { paymentModeLabel } from "./paymentModes";
import { currentBalanceIndex } from "./ledgerBalances";

/** A queryable database handle (pg pool or PoolClient), per lib/importVouchers.ts. */
type Q = { query: Function };

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;

export interface BillSettlement {
  paid: number;
  due: number;
  status: "paid" | "partially_paid" | "unpaid";
  /** Distinct mode labels, explicit allocations first, then FIFO order. */
  modes: string[];
  /** The bill's document number (asset purchases have none). */
  invoiceNumber: string | null;
}

/** Human summary per the GST-register convention. */
export function settlementModeSummary(s: BillSettlement): string {
  if (s.status === "paid") return s.modes.length ? s.modes.join(" + ") : "Paid";
  if (s.status === "partially_paid") return [...s.modes, "Credit"].join(" + ");
  return "Credit";
}

/**
 * Settlement per purchases.id (asset purchases participate but are not emitted).
 *
 * `vendorIds` bounds the walk to those vendors. This is loss-free: the FIFO
 * pool, chunks and bill ordering are all per-vendor, so restricting the vendor
 * set never changes any included vendor's allocation. Callers with a filtered
 * result set should pass the vendors that actually appear in it — each such
 * vendor's FULL bill history still participates, as required.
 */
export async function purchaseSettlementIndex(vendorIds?: number[], q: Q = pool): Promise<Map<number, BillSettlement>> {
  if (vendorIds && vendorIds.length === 0) return new Map();
  const vend = vendorIds ? [...new Set(vendorIds.filter(Number.isFinite))] : null;
  const vendBillCond = vend ? ` AND p.vendor_id = ANY($1::int[])` : "";
  const vendParams = vend ? [vend] : [];

  // Bills in the exact order the payables ageing settles them.
  const { rows: [assetTbl] } = await (q as any).query(
    `SELECT to_regclass('public.asset_purchases') IS NOT NULL AS ok`,
  ) as { rows: Array<{ ok: boolean }> };
  const assetSql = assetTbl?.ok
    ? `UNION ALL
       SELECT 'asset_purchase'::text AS source, ap.id, ap.purchase_date, ap.vendor_id,
              (ap.quantity * ap.acquisition_cost)::numeric AS total,
              NULL::text AS invoice_number
         FROM asset_purchases ap
        WHERE ap.vendor_id IS NOT NULL AND (ap.quantity * ap.acquisition_cost) > 0.004
        ${vend ? "AND ap.vendor_id = ANY($1::int[])" : ""}`
    : "";
  const { rows: bills } = await q.query(
    `SELECT * FROM (
       SELECT 'purchase'::text AS source, p.id, p.purchase_date, p.vendor_id,
              -- What the vendor is owed for the bill: goods PLUS other purchase
              -- charges (freight, hamali…) — both credit the vendor in the books,
              -- so the FIFO walk must count them or settled bills read as open.
              (p.total_amount::numeric + COALESCE((
                 SELECT SUM((e->>'amount')::numeric)
                   FROM jsonb_array_elements(COALESCE(p.other_charges, '[]'::jsonb)) e
                  WHERE (e->>'amount') ~ '^[0-9.]+$'
               ), 0)) AS total, p.invoice_number
         FROM purchases p
        WHERE TRUE${vendBillCond}
       ${assetSql}
     ) bills
     ORDER BY vendor_id, purchase_date ASC, source ASC, id ASC`,
    vendParams,
  );

  // Explicit settlements: bill-targeted payment allocations and vendor-advance
  // applications settle THEIR bill first — they are pinned money, never part
  // of the FIFO pool. Both reduce the vendor's ledger balance (payment Dr and
  // the Dr VEND/Cr VADV contra respectively), so both are carved OUT of the
  // derived pool below before the oldest-first walk.
  const explicitAllocCond = vend ? ` AND pu.vendor_id = ANY($1::int[])` : "";
  const { rows: explicitPayRows } = await q.query(
    `WITH RECURSIVE cashfam AS (
       SELECT id FROM account_ledgers WHERE code = 'STD-CASH'
       UNION ALL
       SELECT l.id FROM account_ledgers l JOIN cashfam c ON l.parent_id = c.id
     )
     SELECT a.purchase_id, a.payment_id, a.amount::numeric AS amount, pu.vendor_id,
            COALESCE(NULLIF(p.payment_mode, ''),
                     CASE WHEN p.paid_from_ledger_id IN (SELECT id FROM cashfam) THEN 'cash' ELSE 'bank' END
            ) AS mode
       FROM payment_bill_allocations a
       JOIN payments p ON p.id = a.payment_id
       JOIN purchases pu ON pu.id = a.purchase_id
      WHERE TRUE${explicitAllocCond}`,
    vendParams,
  );
  const advAppCond = vend ? ` WHERE a.vendor_id = ANY($1::int[])` : "";
  const { rows: advAppRows } = await q.query(
    `SELECT a.purchase_id, a.vendor_id, a.amount::numeric AS amount
       FROM purchase_advance_applications a${advAppCond}`,
    vendParams,
  );

  type ExplicitBill = { amount: number; labels: string[] };
  const explicitByBill = new Map<number, ExplicitBill>();
  const explicitByPayment = new Map<number, number>();
  const explicitByVendor = new Map<number, number>();
  const addExplicit = (billId: number, vendorId: number, amount: number, label: string) => {
    let e = explicitByBill.get(billId);
    if (!e) { e = { amount: 0, labels: [] }; explicitByBill.set(billId, e); }
    e.amount = r2(e.amount + amount);
    if (!e.labels.includes(label)) e.labels.push(label);
    explicitByVendor.set(vendorId, r2((explicitByVendor.get(vendorId) ?? 0) + amount));
  };
  for (const a of explicitPayRows) {
    addExplicit(Number(a.purchase_id), Number(a.vendor_id), Number(a.amount), paymentModeLabel(a.mode));
    explicitByPayment.set(Number(a.payment_id), r2((explicitByPayment.get(Number(a.payment_id)) ?? 0) + Number(a.amount)));
  }
  for (const a of advAppRows) {
    addExplicit(Number(a.purchase_id), Number(a.vendor_id), Number(a.amount), "Advance");
  }

  // Mode chunks: payment vouchers into VEND ledgers, classified by their own
  // stored mode when present, else by the funding ledger's family (Cash
  // subtree vs everything else = Bank).
  const vendChunkCond = vend ? ` AND SUBSTRING(lt.code FROM 6)::int = ANY($1::int[])` : "";
  const { rows: payChunks } = await q.query(
    `WITH RECURSIVE cashfam AS (
       SELECT id FROM account_ledgers WHERE code = 'STD-CASH'
       UNION ALL
       SELECT l.id FROM account_ledgers l JOIN cashfam c ON l.parent_id = c.id
     )
     SELECT p.id AS payment_id, SUBSTRING(lt.code FROM 6)::int AS vendor_id,
            p.payment_date, p.amount::numeric AS amount,
            COALESCE(p.advance_amount, 0)::numeric AS advance_amount,
            COALESCE(NULLIF(p.payment_mode, ''),
                     CASE WHEN p.paid_from_ledger_id IN (SELECT id FROM cashfam) THEN 'cash' ELSE 'bank' END
            ) AS mode
       FROM payments p
       JOIN account_ledgers lt ON lt.id = p.paid_to_ledger_id
      WHERE lt.code LIKE 'VEND-%'${vendChunkCond}
      ORDER BY p.payment_date ASC, p.id ASC`,
    vendParams,
  );
  const { rows: dnChunks } = await q.query(
    `SELECT SUBSTRING(lt.code FROM 6)::int AS vendor_id,
            v.voucher_date AS payment_date, v.total_amount::numeric AS amount
       FROM journal_vouchers v
       JOIN account_ledgers lt ON lt.id = v.party_ledger_id
      WHERE v.voucher_type = 'debit_note' AND lt.code LIKE 'VEND-%'${vendChunkCond}
      ORDER BY v.voucher_date ASC, v.id ASC`,
    vendParams,
  );

  type Chunk = { amount: number; label: string };
  const chunksByVendor = new Map<number, Chunk[]>();
  const pushChunk = (vendorId: number, amount: number, label: string) => {
    if (!Number.isFinite(vendorId) || amount <= EPS) return;
    let list = chunksByVendor.get(vendorId);
    if (!list) { list = []; chunksByVendor.set(vendorId, list); }
    list.push({ amount: r2(amount), label });
  };
  for (const c of payChunks) {
    // Net out what this voucher pinned elsewhere: its advance slice never
    // touched the vendor ledger (it debited the advance asset), and its
    // explicit bill allocations already settled their bills above.
    const free = r2(Number(c.amount) - Number(c.advance_amount) - (explicitByPayment.get(Number(c.payment_id)) ?? 0));
    pushChunk(Number(c.vendor_id), free, paymentModeLabel(c.mode));
  }
  for (const c of dnChunks) pushChunk(Number(c.vendor_id), Number(c.amount), "Debit Note");

  // The authoritative settled pool per vendor: billed − ledger balance.
  const balIdx = await currentBalanceIndex({ q });
  const ledgerByVendor = balIdx.partyBalances("vendor");

  const billedByVendor = new Map<number, number>();
  for (const b of bills) {
    const v = Number(b.vendor_id);
    billedByVendor.set(v, r2((billedByVendor.get(v) ?? 0) + Number(b.total)));
  }

  const out = new Map<number, BillSettlement>();
  let currentVendor = -1;
  let pool_ = 0;
  let chunks: Chunk[] = [];
  let chunkIdx = 0;
  let chunkLeft = 0;

  for (const b of bills) {
    const v = Number(b.vendor_id);
    if (v !== currentVendor) {
      currentVendor = v;
      const billed = billedByVendor.get(v) ?? 0;
      const ledgerBal = ledgerByVendor.get(v)?.balance ?? 0;
      // The pool derived from the ledger includes the explicitly-pinned money
      // (bill allocations and advance contras both reduced the balance); carve
      // it out so the FIFO walk only distributes the genuinely unpinned rest.
      pool_ = Math.max(0, r2(billed - ledgerBal - (explicitByVendor.get(v) ?? 0)));
      chunks = [...(chunksByVendor.get(v) ?? [])];
      // The ledger can have settled more than payments + debit notes document
      // (plain journals, contras). That remainder is real money — label it.
      const chunkSum = r2(chunks.reduce((s, c) => s + c.amount, 0));
      if (pool_ > chunkSum + EPS) chunks.push({ amount: r2(pool_ - chunkSum), label: "Journal" });
      chunkIdx = 0;
      chunkLeft = chunks.length ? chunks[0].amount : 0;
    }
    const total = r2(Number(b.total));
    // Explicit money settles its own bill first; FIFO fills the remainder.
    const ex = b.source === "purchase" ? explicitByBill.get(Number(b.id)) : undefined;
    const explicit = Math.min(r2(ex?.amount ?? 0), total);
    const capacity = r2(total - explicit);
    const alloc = r2(Math.min(pool_, capacity));
    pool_ = r2(pool_ - alloc);

    const modes: string[] = [...(ex?.labels ?? [])];
    let need = alloc;
    while (need > EPS && chunkIdx < chunks.length) {
      const take = Math.min(need, chunkLeft);
      if (take > EPS && !modes.includes(chunks[chunkIdx].label)) modes.push(chunks[chunkIdx].label);
      need = r2(need - take);
      chunkLeft = r2(chunkLeft - take);
      if (chunkLeft <= EPS) {
        chunkIdx += 1;
        chunkLeft = chunkIdx < chunks.length ? chunks[chunkIdx].amount : 0;
      }
    }

    if (b.source === "purchase") {
      const paid = r2(explicit + alloc);
      const due = r2(total - paid);
      out.set(Number(b.id), {
        paid,
        due,
        status: due <= EPS ? "paid" : paid > EPS ? "partially_paid" : "unpaid",
        modes,
        invoiceNumber: b.invoice_number ?? null,
      });
    }
  }
  return out;
}
