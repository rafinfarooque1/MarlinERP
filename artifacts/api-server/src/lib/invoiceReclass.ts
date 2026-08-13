/**
 * B2C → B2B invoice reclassification.
 *
 * When a customer who previously had NO GST number is given one, every
 * eligible B2C invoice of that customer must move to the B2B series: it gets
 * the next B2B serial for its own location scope + financial year, its
 * party_gstin is stamped (freezing the classification the reports read), and
 * the B2C serials it vacated are compacted so the B2C series stays gap-free.
 *
 * Month locking is absolute: invoices in a locked month are never touched —
 * neither converted nor renumbered — and the compaction floor sits at the
 * highest serial pinned by a locked-month (or cancelled) invoice, so open
 * gaps below a pin are left alone by design.
 *
 * Locking order (deadlock-safe against concurrent sale creation, which takes
 * the counter row first and never holds sale-row locks while waiting):
 *   1. the B2C counter row of the scope+FY group,
 *   2. every SB2C sale row of that group (FOR UPDATE, serial order),
 *   3. B2B serials drawn via the same nextScopedSerial upsert sales use.
 *
 * Everything runs in ONE transaction: either the customer's whole history
 * converts and compacts, or nothing moved.
 */
import { pool } from "@workspace/db";
import { logActivity } from "./audit";
import {
  SALES_SERIES,
  nextScopedSerial,
  getSalesNumberFormat,
  formatSalesInvoiceNumber,
  salesCounterFyLabel,
  acquireSalesScopeLockShared,
  type SalesNumberFormat,
} from "./voucherNumber";
import { ymOfDate, isMonthLocked, monthLabel } from "./periodLock";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type ReclassChange = {
  saleId: number;
  oldNumber: string;
  newNumber: string;
  saleDate: string;
  kind: "converted" | "resequenced";
};

export type ReclassResult = {
  converted: ReclassChange[];
  resequenced: ReclassChange[];
  /** Invoices left untouched because their month is locked. */
  skippedLockedMonths: string[];
  /** Legacy rows with no stamped number identity — never touched. */
  skippedLegacy: number;
};

const iso = (d: unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

/**
 * Rename the sale's paper trail (trail receipts, quotation link, payment
 * notes) from the old invoice number to the new one. When the old number is
 * ambiguous across location scopes, the receipt rename is additionally bound
 * to the sale's stored location so another scope's receipt is never touched.
 */
export async function renameTrail(
  tx: Q,
  sale: { id: number; location_type: string | null; location_id: number | null; outlet_id: number | null },
  oldNumber: string,
  newNumber: string,
): Promise<{ receipts: number; quotations: number }> {
  // Invoice-number STRINGS repeat across location scopes, and receipts can
  // exist that no live sale accounts for (orphans from deleted sales, legacy
  // imports). The location predicate is therefore UNCONDITIONAL — a
  // "currently unique among sales" check says nothing about receipts.
  const { rowCount: receipts } = await tx.query(
    `UPDATE receipts
        SET voucher_number = $1,
            narration = replace(COALESCE(narration, ''), $2, $1)
      WHERE voucher_number = $2 AND source = 'sale'
        AND location_type = $3 AND location_id = $4`,
    [newNumber, oldNumber,
     sale.location_type ?? "outlet", sale.location_id ?? sale.outlet_id],
  );
  let quotations = 0;
  const { rows: [quotReg] } = await tx.query(`SELECT to_regclass('public.quotations') AS reg`);
  if (quotReg?.reg != null) {
    // Sale-bound only. Never fall back to a bare number match — the same
    // printed number can belong to another location's quotation.
    const { rowCount: qc } = await tx.query(
      `UPDATE quotations SET converted_invoice_number = $1
        WHERE converted_invoice_number = $2 AND converted_sale_id = $3`,
      [newNumber, oldNumber, sale.id],
    ).catch(() => ({ rowCount: 0 } as any)); /* pre-converted_sale_id schema: skip rather than guess */
    quotations = qc ?? 0;
  }
  await tx.query(
    `UPDATE sale_payments SET notes = replace(notes, $2, $1)
      WHERE sale_id = $3 AND notes LIKE '%' || $2 || '%'`,
    [newNumber, oldNumber, sale.id],
  );
  return { receipts: receipts ?? 0, quotations };
}

/**
 * Convert a customer's open-month B2C invoices to B2B and compact the B2C
 * serials they vacated. Call AFTER the customer's GSTIN has been validated;
 * this function does not modify the customers table.
 */
export async function convertCustomerB2CToB2B(opts: {
  customerId: number;
  gstin: string;
  actor: string;
  /**
   * When true, the customer's gst_number column is written INSIDE this same
   * transaction — so a conversion failure leaves neither a GSTIN on file nor
   * a renumbered invoice. The caller must then NOT write gst_number itself.
   */
  applyGstin?: boolean;
}): Promise<ReclassResult> {
  const { customerId, gstin, actor, applyGstin } = opts;
  const result: ReclassResult = {
    converted: [], resequenced: [], skippedLockedMonths: [], skippedLegacy: 0,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (applyGstin) {
      await client.query(
        `UPDATE customers SET gst_number = $1 WHERE id = $2`,
        [gstin, customerId],
      );
    }

    // The customer's B2C bills. Cancelled invoices keep their numbers (a void
    // document is still a numbered document) and transfer twins are not
    // customer bills at all.
    const { rows: candidates } = await client.query<any>(
      `SELECT id, invoice_number, number_scope, invoice_fy, invoice_serial,
              sale_date, cancelled_at, location_type, location_id, outlet_id
         FROM sales
        WHERE customer_id = $1 AND invoice_series = 'SB2C'
          AND branch_transfer_id IS NULL
        ORDER BY number_scope, invoice_fy, invoice_serial
        FOR UPDATE`,
      [customerId],
    );

    const lockedYms = new Set<string>();
    const eligible: any[] = [];
    for (const s of candidates) {
      if (!s.number_scope || !s.invoice_fy || s.invoice_serial == null) {
        result.skippedLegacy++; continue;
      }
      if (s.cancelled_at) continue;
      const ym = ymOfDate(s.sale_date);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        lockedYms.add(monthLabel(ym.year, ym.month));
        continue;
      }
      eligible.push(s);
    }
    result.skippedLockedMonths = [...lockedYms];

    if (eligible.length === 0) {
      await client.query("COMMIT");
      return result;
    }

    // Group by location scope + FY — each group has its own counters.
    const groups = new Map<string, any[]>();
    for (const s of eligible) {
      const key = `${s.number_scope}|${s.invoice_fy}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }

    for (const [key, groupSales] of groups) {
      const [scope, fy] = key.split("|");

      // Shared scope lock BEFORE any sale-row or counter lock — concurrent
      // with normal allocation, mutually exclusive with the admin renumber
      // migration (which takes the exclusive side before ITS row locks), so
      // the two can never deadlock over counters vs sale rows.
      await acquireSalesScopeLockShared(client, scope);

      // The scope's printed format + counter keying. A renumbered scope
      // (admin migration) prints short-FY unpadded numbers and runs ONE
      // continuous counter keyed 'ALL' across financial years — reclass must
      // draw and format through the same rules or the two producers fork.
      const fmt: SalesNumberFormat = await getSalesNumberFormat(client, scope);
      const counterFy = salesCounterFyLabel(fmt, fy);

      // 1. Take the group's B2C counter row lock first (creates it at 0 if it
      //    never drew) — same lock sale creation takes, so ordering is safe.
      const b2cKey = `${SALES_SERIES.b2c.counter}@${scope}`;
      await client.query(
        `INSERT INTO voucher_sequences (voucher_type, fy_label, last_number)
         VALUES ($1, $2, 0)
         ON CONFLICT (voucher_type, fy_label)
         DO UPDATE SET last_number = voucher_sequences.last_number
         RETURNING last_number`,
        [b2cKey, counterFy],
      );

      // 2. Lock EVERY B2C row of the scope+FY — compaction moves rows that
      //    belong to other customers too.
      const { rows: allB2C } = await client.query<any>(
        `SELECT id, invoice_number, invoice_serial, sale_date, cancelled_at,
                location_type, location_id, outlet_id
           FROM sales
          WHERE number_scope = $1 AND invoice_fy = $2 AND invoice_series = 'SB2C'
          ORDER BY invoice_serial
          FOR UPDATE`,
        [scope, fy],
      );

      // 3. Convert this customer's eligible bills to the B2B series.
      const convertedIds = new Set<number>();
      for (const s of groupSales) {
        const serial = await nextScopedSerial(client, SALES_SERIES.b2b.counter, scope, counterFy);
        const newNumber = formatSalesInvoiceNumber("b2b", fy, serial, fmt);
        const oldNumber = String(s.invoice_number);
        await client.query(
          `UPDATE sales
              SET invoice_number = $1, invoice_series = 'SB2B',
                  invoice_serial = $2, party_gstin = $3
            WHERE id = $4`,
          [newNumber, serial, gstin, s.id],
        );
        await renameTrail(client, s, oldNumber, newNumber);
        convertedIds.add(Number(s.id));
        result.converted.push({
          saleId: Number(s.id), oldNumber, newNumber,
          saleDate: iso(s.sale_date), kind: "converted",
        });
      }

      // 4. Compact the B2C serials — but ONLY the gaps this conversion just
      //    opened. The floor starts one below the smallest converted serial:
      //    everything beneath it predates the conversion and keeps its number
      //    (a pre-existing historical gap is not this operation's to "fix" —
      //    renumbering unrelated old invoices as a side effect would be far
      //    more destructive than the gap). Pins raise the floor further:
      //    locked-month invoices, cancelled invoices, and rows missing a
      //    serial never move, so nothing beneath the highest pin moves either.
      const remaining = allB2C.filter((r) => !convertedIds.has(Number(r.id)));
      const minConverted = Math.min(
        ...groupSales.map((s) => Number(s.invoice_serial)),
      );
      let floor = minConverted - 1;
      const movable: any[] = [];
      for (const r of remaining) {
        const serial = r.invoice_serial == null ? null : Number(r.invoice_serial);
        const ym = ymOfDate(r.sale_date);
        const pinned = serial == null || r.cancelled_at != null ||
          (ym != null && await isMonthLocked(client, ym.year, ym.month));
        if (pinned) { if (serial != null && serial > floor) floor = serial; }
        else movable.push({ ...r, serial });
      }
      let next = floor;
      for (const r of movable.filter((m) => m.serial > floor).sort((a, b) => a.serial - b.serial)) {
        next += 1;
        if (next === r.serial) continue;
        const oldNumber = String(r.invoice_number);
        const newNumber = formatSalesInvoiceNumber("b2c", fy, next, fmt);
        await client.query(
          `UPDATE sales SET invoice_number = $1, invoice_serial = $2 WHERE id = $3`,
          [newNumber, next, r.id],
        );
        await renameTrail(client, r, oldNumber, newNumber);
        result.resequenced.push({
          saleId: Number(r.id), oldNumber, newNumber,
          saleDate: iso(r.sale_date), kind: "resequenced",
        });
      }
      // Movable rows at or below the floor keep their serials; `next` may end
      // below them only when nothing moved — never move the counter UP here.
      let maxInUse = Math.max(
        next,
        ...movable.filter((m) => m.serial <= floor).map((m) => m.serial),
        floor,
      );

      // A CONTINUOUS counter is shared across every FY of the scope, but this
      // group only locked and inspected ONE FY's rows — walking the counter
      // back to this group's max could hand out serials another FY already
      // uses. Floor the walk-back at the scope-wide max serial actually in use.
      if (fmt.continuous) {
        const { rows: [mx] } = await client.query(
          `SELECT COALESCE(MAX(invoice_serial), 0) AS mx
             FROM sales
            WHERE number_scope = $1 AND invoice_series = 'SB2C'`,
          [scope],
        );
        maxInUse = Math.max(maxInUse, Number(mx?.mx ?? 0));
      }

      // 5. Walk the B2C counter back to the highest serial still in use —
      //    otherwise the numbers just vacated become permanent tail gaps.
      //    Safe ONLY because this transaction holds the counter row lock and
      //    every row of the scope+FY. Never moved forward past its own value.
      await client.query(
        `UPDATE voucher_sequences
            SET last_number = $3
          WHERE voucher_type = $1 AND fy_label = $2 AND last_number > $3`,
        [b2cKey, counterFy, maxInUse],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Audit trail — after commit so a log hiccup can't undo the conversion.
  for (const c of [...result.converted, ...result.resequenced]) {
    logActivity({
      action: "UPDATE", module: "sales", entityType: "sale", entityId: c.saleId,
      description: c.kind === "converted"
        ? `Invoice ${c.oldNumber} reclassified B2C → B2B as ${c.newNumber} (customer GSTIN added)`
        : `Invoice ${c.oldNumber} renumbered to ${c.newNumber} (B2C series compacted)`,
      user: actor,
      metadata: {
        reason: c.kind === "converted" ? "customer_gstin_added" : "b2c_series_compaction",
        customerId, gstin, oldNumber: c.oldNumber, newNumber: c.newNumber,
        oldClassification: c.kind === "converted" ? "B2C" : "B2C",
        newClassification: c.kind === "converted" ? "B2B" : "B2C",
        saleDate: c.saleDate,
      },
    }).catch(() => {});
  }
  return result;
}
