import type { PgPool } from "@workspace/db";
import { validateOtherCharges } from "../lib/otherCharges";

/**
 * One-time backend data correction of imported purchase bill 5052 (the bill
 * the owner refers to as "Purchase Bill #0038" — its id in the production
 * database), requested by the owner on 2026-08-07.
 *
 * The legacy import recorded the paper bill's "Packing & Transport ₹1,260"
 * charge as a bogus product line: YELLOW JACKFRUIT, 1 × ₹1,200 + ₹60 IGST
 * = ₹1,260. The corrected bill keeps only the two real lines (Strawberry
 * and Blueberry Cultivated) and records the ₹1,260 as a proper Other Charge
 * on the "Packing & Transport - purchase" expense ledger:
 *
 *   goods: 9,450.00 + 11,520.00 = 20,970.00 · GST 1,048.50
 *   goods total 22,018.50 → rounded 22,019.00 (round-off +0.50)
 *   payable 22,019.00 + 1,260.00 charge = 23,279.00 — EXACTLY what was paid,
 *   so the vendor stays fully settled and the settled floor holds as equality.
 *
 * Display-only by design: the bogus unit was already consumed downstream in
 * BOTH databases (its lot is at quantity 0), so stock history, batches,
 * valuation and the stock ledger are deliberately left untouched — reversing
 * them would require unwinding real sales. The books need no voucher work:
 * they derive from the purchases row, so rewriting the row IS the reversal
 * (the Dr Purchase/Input-GST legs shrink, a Dr charge leg appears, and the
 * vendor Cr stays 23,279.00). GST reports drop the ₹60 input tax — correct,
 * because no goods line carries it any more.
 *
 * Safety gates — ALL must pass inside one transaction or nothing is written:
 *  1. migration_log marker absent (marker written in the same transaction).
 *  2. Exactly ONE bill matches invoice_number '5052' + vendor 22. A bill
 *     already in the corrected shape writes the marker and stops. Missing
 *     bill: marker in non-production (nothing to correct in that database),
 *     loud failure in production.
 *  3. Uncorrected shape pinned in full: exactly 3 lines; the removable line
 *     matches every stored figure of the bogus jackfruit line; the two kept
 *     lines match their net amounts; no other charges; stored totals match.
 *     Anything else throws — no guessing, retry next boot after inspection.
 *  4. The charge ledger is resolved BY NAME (ids could drift between
 *     databases) and re-validated through the same validateOtherCharges()
 *     gate the purchase screens use.
 *  5. Recomputed totals must equal the constants above to the paise, and the
 *     new payable must not undercut what is already settled against the bill.
 */
const GUARD = "purchase_5052_line_correction_v1";

const INVOICE = "5052";
const VENDOR_ID = 22;
const CHARGE_LEDGER_NAME = "Packing & Transport - purchase";
const CHARGE_AMOUNT = 1260.0;

// The bogus line, pinned on every stored figure INCLUDING product identity
// (item 69 = YELLOW JACKFRUIT and HSN 8110 in both databases — verified on
// the production replica on 2026-08-07 before writing this).
const BOGUS = { materialId: 69, hsnCode: "8110", materialType: "item", quantity: 1, unitCost: 1200, gstRate: 5, netAmount: 1200, lineTotal: 1260, taxAmount: 60 };
const BATCH_RE = /^PUR-20260704-\d{5}$/;
// The two real lines, pinned in full (item ids are identical in both
// databases; only the allocator-generated batch numbers differ).
const KEPT = [
  { materialId: 40, quantity: 105, netAmount: 9450, taxAmount: 472.5, lineTotal: 9922.5 },  // STRAWBERRY
  { materialId: 7, quantity: 32, netAmount: 11520, taxAmount: 576, lineTotal: 12096 },      // BLUBERRY CULTIVATED
];

// Expected corrected figures.
const NEW_TAX = 1048.5;
const NEW_TOTAL = 22019.0;
const NEW_ROUND_OFF = 0.5;

const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

function isBogusLine(li: any): boolean {
  return Number(li?.materialId) === BOGUS.materialId
    && String(li?.hsnCode) === BOGUS.hsnCode
    && String(li?.materialType) === BOGUS.materialType
    && near(Number(li?.quantity), BOGUS.quantity)
    && near(Number(li?.unitCost), BOGUS.unitCost)
    && near(Number(li?.gstRate), BOGUS.gstRate)
    && near(Number(li?.netAmount), BOGUS.netAmount)
    && near(Number(li?.lineTotal), BOGUS.lineTotal)
    && near(Number(li?.taxAmount), BOGUS.taxAmount)
    && BATCH_RE.test(String(li?.batchNumber ?? ""));
}

function matchesKept(li: any, k: (typeof KEPT)[number]): boolean {
  return Number(li?.materialId) === k.materialId
    && String(li?.materialType) === "item"
    && near(Number(li?.quantity), k.quantity)
    && near(Number(li?.netAmount), k.netAmount)
    && near(Number(li?.taxAmount), k.taxAmount)
    && near(Number(li?.lineTotal), k.lineTotal);
}

/**
 * True only for the EXACT intended end state: not cancelled, both retained
 * lines matching their full fingerprints, the corrected stored totals to the
 * paise, and exactly one ₹1,260 charge whose ledger id resolves to the named
 * Packing & Transport ledger (checked by the caller, which has a client).
 * Anything looser — e.g. a partial or hand-mangled correction — must NOT
 * mark done: it falls through to the strict uncorrected pinning, which
 * throws loudly instead.
 */
function isCorrectedShape(bill: any, lines: any[], charges: any[], chargeLedgerId: number | null): boolean {
  return !bill.cancelled_at
    && lines.length === 2
    && KEPT.every((k) => lines.some((li) => matchesKept(li, k)))
    && charges.length === 1
    && near(Number(charges[0]?.amount), CHARGE_AMOUNT)
    && chargeLedgerId !== null
    && Number(charges[0]?.ledgerId) === chargeLedgerId
    && near(Number(bill.total_amount), NEW_TOTAL)
    && near(Number(bill.tax_total), NEW_TAX)
    && near(Number(bill.round_off), NEW_ROUND_OFF);
}

export async function correctImportedPurchase5052(pool: PgPool): Promise<string> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return `${GUARD}: already applied`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: bills } = await client.query(
      `SELECT id, line_items, other_charges, total_amount::numeric AS total_amount,
              tax_total::numeric AS tax_total, discount_total::numeric AS discount_total,
              round_off::numeric AS round_off, cancelled_at
         FROM purchases
        WHERE invoice_number = $1 AND vendor_id = $2
        FOR UPDATE`,
      [INVOICE, VENDOR_ID],
    );

    if (bills.length === 0) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(`no purchase bill with invoice ${INVOICE} for vendor ${VENDOR_ID} exists in production — refusing to mark done; investigate before publishing again`);
      }
      await client.query(`INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD]);
      await client.query("COMMIT");
      return `${GUARD}: bill ${INVOICE} not present in this non-production database — marked done, nothing changed`;
    }
    if (bills.length > 1) throw new Error(`${bills.length} bills match invoice ${INVOICE} + vendor ${VENDOR_ID} — ambiguous, nothing changed`);

    const bill = bills[0];
    const lines: any[] = Array.isArray(bill.line_items) ? bill.line_items : [];
    const charges: any[] = Array.isArray(bill.other_charges) ? bill.other_charges : [];

    // ── Charge ledger: by name, through the same gate the screens use ─────
    // Resolved up front because BOTH branches need it: the corrected-shape
    // probe must confirm the stored charge points at this exact ledger, and
    // the apply path posts to it.
    const { rows: ledgers } = await client.query(
      `SELECT id FROM account_ledgers WHERE name = $1`, [CHARGE_LEDGER_NAME],
    );
    if (ledgers.length !== 1) throw new Error(`${ledgers.length} ledgers named "${CHARGE_LEDGER_NAME}" — need exactly one; nothing changed`);
    const chargeLedgerId = Number(ledgers[0].id);

    if (isCorrectedShape(bill, lines, charges, chargeLedgerId)) {
      await client.query(`INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD]);
      await client.query("COMMIT");
      return `${GUARD}: bill ${INVOICE} (id ${bill.id}) already in the exact corrected shape — marked done, nothing changed`;
    }

    // ── Pin the uncorrected shape in full ─────────────────────────────────
    if (bill.cancelled_at) throw new Error(`bill ${INVOICE} (id ${bill.id}) is cancelled — nothing changed`);
    if (lines.length !== 3) throw new Error(`bill ${INVOICE} (id ${bill.id}) has ${lines.length} lines, expected 3 — nothing changed`);
    if (charges.length !== 0) throw new Error(`bill ${INVOICE} (id ${bill.id}) already carries other charges — nothing changed`);
    const bogus = lines.filter(isBogusLine);
    if (bogus.length !== 1) throw new Error(`bill ${INVOICE} (id ${bill.id}): ${bogus.length} lines match the bogus-line fingerprint, expected exactly 1 — nothing changed`);
    const kept = lines.filter((li) => !isBogusLine(li));
    for (const k of KEPT) {
      if (!kept.some((li) => matchesKept(li, k))) {
        throw new Error(`bill ${INVOICE} (id ${bill.id}): kept lines do not match the pinned Strawberry/Blueberry fingerprints — nothing changed`);
      }
    }
    if (!near(Number(bill.total_amount), 23279) || !near(Number(bill.tax_total), 1108.5) || !near(Number(bill.discount_total), 0)) {
      throw new Error(`bill ${INVOICE} (id ${bill.id}): stored totals ${bill.total_amount}/${bill.tax_total}/${bill.discount_total} do not match the pinned uncorrected figures — nothing changed`);
    }

    // ── Recompute the corrected figures from the kept lines ───────────────
    const rawTotal = r2(kept.reduce((s, li) => s + Number(li?.lineTotal ?? 0), 0));
    const newTax = r2(kept.reduce((s, li) => s + Number(li?.taxAmount ?? 0), 0));
    const newTotal = Math.round(rawTotal);
    const newRoundOff = r2(newTotal - rawTotal);
    if (!near(newTax, NEW_TAX) || !near(newTotal, NEW_TOTAL) || !near(newRoundOff, NEW_ROUND_OFF)) {
      throw new Error(`recomputed figures ${newTotal}/${newTax}/${newRoundOff} differ from the expected ${NEW_TOTAL}/${NEW_TAX}/${NEW_ROUND_OFF} — nothing changed`);
    }

    const verdict = await validateOtherCharges(client, [{ ledgerId: chargeLedgerId, amount: CHARGE_AMOUNT }]);
    if ("error" in verdict) throw new Error(`charge ledger rejected: ${verdict.error} — nothing changed`);

    // ── Settled floor: the corrected payable must cover recorded money ────
    const { rows: [settled] } = await client.query(
      `SELECT COALESCE((SELECT SUM(amount)::numeric FROM payment_bill_allocations WHERE purchase_id = $1), 0)
            + COALESCE((SELECT SUM(amount)::numeric FROM purchase_advance_applications WHERE purchase_id = $1), 0) AS paid`,
      [bill.id],
    );
    const paid = Number(settled?.paid ?? 0);
    const newPayable = r2(newTotal + verdict.total);
    if (newPayable + 0.005 < paid) {
      throw new Error(`corrected payable ₹${newPayable} would undercut ₹${paid} already settled — nothing changed`);
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    await client.query(
      `UPDATE purchases
          SET line_items = $2::jsonb, other_charges = $3::jsonb,
              total_amount = $4, tax_total = $5, round_off = $6
        WHERE id = $1`,
      [bill.id, JSON.stringify(kept), JSON.stringify(verdict.charges), newTotal.toFixed(2), newTax.toFixed(2), newRoundOff.toFixed(2)],
    );

    const removed = bogus[0];
    await client.query(
      `INSERT INTO activity_log (type, description, "user", action, module, entity_type, entity_id, metadata)
       VALUES ('UPDATE', $1, 'system', 'UPDATE', 'purchases', 'purchase', $2, $3::jsonb)`,
      [
        `Backend data correction for imported Purchase Bill #0038 (invoice ${INVOICE}): removed erroneous YELLOW JACKFRUIT line (1 × ₹1,200 + ₹60 GST) that was actually the bill's Packing & Transport charge, and recorded ₹1,260.00 as an Other Charge on "${CHARGE_LEDGER_NAME}" instead. Totals: ₹23,279.00 → ₹${newTotal.toFixed(2)} goods + ₹1,260.00 charge (payable unchanged at ₹23,279.00). Stock history left untouched — the batch was already consumed.`,
        bill.id,
        JSON.stringify({
          reason: "Backend data correction for imported Purchase Bill #0038.",
          removedLine: removed,
          before: { totalAmount: Number(bill.total_amount), taxTotal: Number(bill.tax_total), roundOff: Number(bill.round_off), otherCharges: [] },
          after: { totalAmount: newTotal, taxTotal: newTax, roundOff: newRoundOff, otherCharges: verdict.charges },
          payable: newPayable,
          settledAgainstBill: paid,
        }),
      ],
    );

    await client.query(`INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD]);
    await client.query("COMMIT");
    return `${GUARD}: bill ${INVOICE} (id ${bill.id}) corrected — removed bogus line, added ₹1,260.00 Packing & Transport charge, totals ${bill.total_amount} → ${newTotal.toFixed(2)} (payable unchanged)`;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection-level failure */ }
    throw err;
  } finally {
    client.release();
  }
}
