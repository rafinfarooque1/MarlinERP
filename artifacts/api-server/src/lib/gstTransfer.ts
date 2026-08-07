/**
 * GST-aware inter-branch transfer logic.
 *
 * The system automatically classifies every stock transfer:
 *   - Same GSTIN          → 'internal'    (no GST, delivery challan only)
 *   - Diff GSTIN, same state → 'intrastate' (CGST + SGST)
 *   - Diff GSTIN, diff state → 'interstate' (IGST)
 *
 * Source GSTIN is read from: company_settings (headoffice), warehouses, outlets.
 * The state code is derived from the stored state name using the official map,
 * or from the first two digits of the GSTIN (per GST registration format).
 */

import { salesCounterScope, parseDocNumberIdentity } from "./voucherNumber";

type PoolLike = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

// ── Indian state → 2-digit numeric state code ─────────────────────────────────
const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03',
  'chandigarh': '04', 'uttarakhand': '05', 'uttaranchal': '05',
  'haryana': '06', 'delhi': '07', 'rajasthan': '08',
  'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
  'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
  'mizoram': '15', 'tripura': '16', 'meghalaya': '17',
  'assam': '18', 'west bengal': '19', 'jharkhand': '20',
  'odisha': '21', 'orissa': '21', 'chhattisgarh': '22',
  'madhya pradesh': '23', 'gujarat': '24',
  'dadra and nagar haveli and daman and diu': '26', 'daman and diu': '26',
  'maharashtra': '27', 'karnataka': '29', 'goa': '30',
  'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33',
  'puducherry': '34', 'andaman and nicobar islands': '35',
  'telangana': '36', 'andhra pradesh': '37', 'ladakh': '38',
};

export function stateCodeFromState(state: string | null | undefined): string {
  if (!state) return '';
  return STATE_CODES[state.toLowerCase().trim()] ?? '';
}

/** Extract state code from the first two chars of a GSTIN (fallback). */
function stateCodeFromGstin(gstin: string | null | undefined): string {
  if (!gstin || gstin.length < 2) return '';
  const code = gstin.slice(0, 2);
  return /^\d{2}$/.test(code) ? code : '';
}

// ── Location GST resolution ───────────────────────────────────────────────────

export interface LocationGst {
  gstin: string | null;
  state: string | null;
  stateCode: string;          // 2-digit
  name: string;
  locationType: string;
  locationId: number;
  salesLedgerId: number | null;
  purchaseLedgerId: number | null;
}

export async function resolveLocationGst(
  db: PoolLike,
  locationType: string,
  locationId: number,
): Promise<LocationGst> {
  if (locationType === 'headoffice') {
    const { rows: [cs] } = await db.query(
      `SELECT company_name, state, gst_number FROM company_settings LIMIT 1`,
    );
    const state = cs?.state ?? null;
    const gstin = cs?.gst_number ?? null;
    return {
      gstin,
      state,
      stateCode: stateCodeFromState(state) || stateCodeFromGstin(gstin),
      name: cs?.company_name ?? 'Head Office',
      locationType, locationId,
      salesLedgerId: null, purchaseLedgerId: null,
    };
  }
  if (locationType === 'warehouse') {
    const { rows: [w] } = await db.query(
      `SELECT name, gst_number, state, state_code, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`,
      [locationId],
    );
    const state = w?.state ?? null;
    const gstin = w?.gst_number ?? null;
    return {
      gstin,
      state,
      stateCode: w?.state_code || stateCodeFromState(state) || stateCodeFromGstin(gstin),
      name: w?.name ?? `Warehouse #${locationId}`,
      locationType, locationId,
      salesLedgerId: w?.sales_ledger_id ?? null,
      purchaseLedgerId: w?.purchase_ledger_id ?? null,
    };
  }
  // outlet
  const { rows: [o] } = await db.query(
    `SELECT name, gstin, state, state_code, sales_ledger_id FROM outlets WHERE id = $1`,
    [locationId],
  );
  const state = o?.state ?? null;
  const gstin = o?.gstin ?? null;
  return {
    gstin,
    state,
    stateCode: o?.state_code || stateCodeFromState(state) || stateCodeFromGstin(gstin),
    name: o?.name ?? `Outlet #${locationId}`,
    locationType, locationId,
    salesLedgerId: o?.sales_ledger_id ?? null,
    purchaseLedgerId: null,
  };
}

// ── Transfer classification ───────────────────────────────────────────────────

export type TransferType = 'internal' | 'intrastate' | 'interstate';
export type TaxType = 'none' | 'cgst_sgst' | 'igst';

export interface TransferClassification {
  transferType: TransferType;
  taxType: TaxType;
  isInterstate: boolean;
}

export function classifyTransfer(from: LocationGst, to: LocationGst): TransferClassification {
  const fromGstin = (from.gstin ?? '').trim().toUpperCase();
  const toGstin   = (to.gstin   ?? '').trim().toUpperCase();

  // If either side has no GSTIN — cannot create a tax invoice → internal
  if (!fromGstin || !toGstin) {
    return { transferType: 'internal', taxType: 'none', isInterstate: false };
  }
  // Same GSTIN → intra-entity, no GST
  if (fromGstin === toGstin) {
    return { transferType: 'internal', taxType: 'none', isInterstate: false };
  }

  // Different GSTIN — compare state codes (GST-registered persons)
  const fromCode = from.stateCode || fromGstin.slice(0, 2);
  const toCode   = to.stateCode   || toGstin.slice(0, 2);

  if (fromCode && toCode && fromCode === toCode) {
    // Same state, different GSTIN → intrastate (CGST + SGST)
    return { transferType: 'intrastate', taxType: 'cgst_sgst', isInterstate: false };
  }
  // Different state → interstate (IGST)
  return { transferType: 'interstate', taxType: 'igst', isInterstate: true };
}

// ── GST computation ───────────────────────────────────────────────────────────

export interface GstTotals {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalGst: number;
  totalWithGst: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A transfer line as stored on stock_transfers.line_items. */
export interface TransferLine {
  itemId: number;
  quantity: number;
  costPrice?: number;
  materialType?: string;
}

/**
 * One priced transfer line, carrying every field the GST reports and the
 * derived postings read. Emitted in both the sales and purchases line-item
 * dialects (`taxRate`/`lineSubtotal` vs `gstRate`/`taxableValue`) because the
 * two tables were built with different field names and both are read directly.
 */
export interface TransferInvoiceLine {
  materialType: string;
  itemId: number;
  materialId: number;
  itemName: string;
  hsnCode: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  discount: number;
  taxRate: number;
  gstRate: number;
  taxType: 'cgst_sgst' | 'igst' | 'none';
  lineSubtotal: number;
  taxableValue: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
  lineTotal: number;
}

const PRODUCT_TABLE: Record<string, string> = {
  item: 'items',
  material: 'materials',
  raw_material: 'raw_materials',
};

/**
 * Price transfer lines for a tax invoice.
 *
 * Tax is EXCLUSIVE here (taxable value = quantity x cost, tax added on top),
 * unlike a customer sale where the MRP already contains the GST. A transfer is
 * billed at cost, so there is no margin to extract tax from.
 *
 * Rates and HSN codes are read per material kind. items/materials/raw_materials
 * share overlapping ids, so the kind has to scope every lookup.
 */
export async function buildTransferInvoiceLines(
  db: PoolLike,
  lines: TransferLine[],
  taxType: TaxType,
): Promise<TransferInvoiceLine[]> {
  const byKind = new Map<string, Set<number>>();
  for (const l of lines) {
    const kind = l.materialType ?? 'item';
    if (!PRODUCT_TABLE[kind]) continue;
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind)!.add(Number(l.itemId));
  }

  type Meta = { name: string; unit: string; hsn: string; rate: number };
  const meta = new Map<string, Meta>();
  for (const [kind, ids] of byKind) {
    const { rows } = await db.query(
      `SELECT id, name, COALESCE(unit,'') AS unit, COALESCE(hsn_code,'') AS hsn_code,
              COALESCE(tax_rate, 0)::numeric AS tax_rate
         FROM ${PRODUCT_TABLE[kind]} WHERE id = ANY($1::int[])`,
      [[...ids]],
    );
    for (const r of rows) {
      meta.set(`${kind}:${Number(r.id)}`, {
        name: String(r.name), unit: String(r.unit),
        hsn: String(r.hsn_code), rate: Number(r.tax_rate),
      });
    }
  }

  return lines.map((l) => {
    const kind = l.materialType ?? 'item';
    const m = meta.get(`${kind}:${Number(l.itemId)}`);
    const qty = r3(Number(l.quantity));
    const cost = r2(Number(l.costPrice ?? 0));
    const taxable = r2(qty * cost);
    const rate = taxType === 'none' ? 0 : (m?.rate ?? 0);
    const taxAmount = r2(taxable * rate / 100);
    // Split so the halves always add back to taxAmount exactly — a naive
    // /2 twice loses a paisa on odd amounts and unbalances the voucher.
    const cgst = taxType === 'cgst_sgst' ? r2(taxAmount / 2) : 0;
    const sgst = taxType === 'cgst_sgst' ? r2(taxAmount - cgst) : 0;
    const igst = taxType === 'igst' ? taxAmount : 0;
    return {
      materialType: kind,
      itemId: Number(l.itemId),
      materialId: Number(l.itemId),
      itemName: m?.name ?? `#${l.itemId}`,
      hsnCode: m?.hsn ?? '',
      unit: m?.unit ?? '',
      quantity: qty,
      unitPrice: cost,
      unitCost: cost,
      discount: 0,
      taxRate: rate,
      gstRate: rate,
      taxType: taxType === 'none' ? 'none' : taxType,
      lineSubtotal: taxable,
      taxableValue: taxable,
      taxableAmount: taxable,
      cgst, sgst, igst,
      taxAmount,
      lineTotal: r2(taxable + taxAmount),
    };
  });
}

/** Sum priced lines into document totals. */
export function totalsFromLines(lines: TransferInvoiceLine[]): GstTotals {
  let taxableValue = 0, cgst = 0, sgst = 0, igst = 0;
  for (const l of lines) {
    taxableValue = r2(taxableValue + l.lineSubtotal);
    cgst = r2(cgst + l.cgst);
    sgst = r2(sgst + l.sgst);
    igst = r2(igst + l.igst);
  }
  const totalGst = r2(cgst + sgst + igst);
  return { taxableValue, cgst, sgst, igst, totalGst, totalWithGst: r2(taxableValue + totalGst) };
}

/**
 * Compute GST totals for transfer lines.
 *
 * Delegates to buildTransferInvoiceLines so the journal-voucher path and the
 * invoice path can never compute a different tax on the same transfer. Note
 * this also means materials and packing materials are now taxed at their own
 * rate; previously only finished-goods lines were, which understated the tax on
 * any cross-GSTIN transfer of materials.
 */
export async function computeTransferGst(
  db: PoolLike,
  lines: TransferLine[],
  taxType: TaxType,
): Promise<GstTotals> {
  if (!lines.length || taxType === 'none') {
    return { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, totalGst: 0, totalWithGst: 0 };
  }
  return totalsFromLines(await buildTransferInvoiceLines(db, lines, taxType));
}

// ── Ledger helpers ────────────────────────────────────────────────────────────

async function ledgerIdByCode(db: PoolLike, code: string): Promise<number | null> {
  const { rows: [r] } = await db.query(`SELECT id FROM account_ledgers WHERE code = $1`, [code]);
  return r?.id ?? null;
}

/** Find or auto-create a standard clearing ledger. */
export async function ensureClearingLedger(
  db: PoolLike,
  code: string,
  name: string,
  type: string,
  section: string,
  parentCode: string | null = null,
): Promise<number | null> {
  const existing = await ledgerIdByCode(db, code);
  if (existing) return existing;
  const parentId = parentCode ? await ledgerIdByCode(db, parentCode) : null;
  try {
    const { rows: [ins] } = await db.query(
      `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
       VALUES ($1,$2,$3,$4,$5,false,$6) RETURNING id`,
      [name, type, code, section, parentId, `Standard clearing ledger — ${name}`],
    );
    return ins?.id ?? null;
  } catch {
    // Concurrent creation race — fetch again
    return ledgerIdByCode(db, code);
  }
}

// ── Dispatch-side JV (source branch books) ───────────────────────────────────

export interface DispatchVoucherArgs {
  client: PoolLike;
  challanNumber: string;
  transferDate: string;
  fromLocation: LocationGst;
  gst: GstTotals;
  taxType: TaxType;
  narration: string;
  createdBy: string | null;
}

/**
 * Inter-branch source-side accounting entry at dispatch time:
 *   Dr  Inter-Branch Receivable   (total with GST)
 *   Cr  Sales                     (taxable value)
 *   Cr  Output GST heads          (CGST/SGST or IGST)
 */
export async function createDispatchVoucher(args: DispatchVoucherArgs): Promise<number | null> {
  const { client, challanNumber, transferDate, fromLocation, gst, taxType, narration, createdBy } = args;
  if (!(gst.taxableValue > 0)) return null;

  const [branchDebtorId, salesId] = await Promise.all([
    ensureClearingLedger(client, 'STD-BRANCH-DEBTOR', 'Inter-Branch Receivable', 'asset', 'balance_sheet'),
    (async () => fromLocation.salesLedgerId ?? ledgerIdByCode(client, 'STD-SALES'))(),
  ]);
  if (!branchDebtorId || !salesId) {
    console.warn('[gst-transfer] Cannot create dispatch JV — clearing or sales ledger missing');
    return null;
  }

  // Accumulate GST credit lines
  let unresolvedGst = 0;
  const gstLines: Array<{ ledgerId: number; debit: number; credit: number }> = [];
  const tryGstHead = async (suffix: string, amt: number) => {
    if (!(amt > 0.004)) return;
    const lid = await ledgerIdByCode(client, `STD-OUT-${suffix}`);
    if (lid) gstLines.push({ ledgerId: lid, debit: 0, credit: r2(amt) });
    else unresolvedGst = r2(unresolvedGst + amt);
  };
  if (taxType === 'igst') {
    await tryGstHead('IGST', gst.igst);
  } else if (taxType === 'cgst_sgst') {
    await tryGstHead('CGST', gst.cgst);
    await tryGstHead('SGST', gst.sgst);
  }

  const lines = [
    { ledgerId: branchDebtorId, debit: gst.totalWithGst, credit: 0 },
    { ledgerId: salesId,        debit: 0, credit: r2(gst.taxableValue + unresolvedGst) },
    ...gstLines,
  ];

  const { rows: [v] } = await client.query(
    `INSERT INTO journal_vouchers
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by,
        origin, source_module)
     VALUES ('branch_transfer_sale', $1, $2, $3, $4, $5, $6, $7, 'system', 'branch_transfer') RETURNING id`,
    [`TRF-${challanNumber}`, transferDate, narration, branchDebtorId,
     'Inter-branch taxable transfer — source side', gst.totalWithGst, createdBy],
  );
  const vid = v?.id;
  if (!vid) return null;

  for (const l of lines) {
    if (!(l.debit > 0.004) && !(l.credit > 0.004)) continue;
    await client.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1,$2,$3,$4)`,
      [vid, l.ledgerId, r2(l.debit), r2(l.credit)],
    );
  }
  return vid;
}

// ── Receive-side JV (destination branch books) ────────────────────────────────


export interface ReceiveVoucherArgs {
  client: PoolLike;
  challanNumber: string;
  transferDate: string;
  toLocation: LocationGst;
  gst: GstTotals;
  taxType: TaxType;
  narration: string;
  createdBy: string | null;
}

/**
 * Inter-branch destination-side accounting entry at approval time:
 *   Dr  Purchases                 (taxable value)
 *   Dr  Input GST heads           (CGST/SGST or IGST)
 *   Cr  Inter-Branch Payable      (total with GST)
 */
export async function createReceiveVoucher(args: ReceiveVoucherArgs): Promise<number | null> {
  const { client, challanNumber, transferDate, toLocation, gst, taxType, narration, createdBy } = args;
  if (!(gst.taxableValue > 0)) return null;

  const [branchCreditorId, purId] = await Promise.all([
    ensureClearingLedger(client, 'STD-BRANCH-CREDITOR', 'Inter-Branch Payable', 'liability', 'balance_sheet'),
    (async () => toLocation.purchaseLedgerId ?? ledgerIdByCode(client, 'STD-PUR'))(),
  ]);
  if (!branchCreditorId || !purId) {
    console.warn('[gst-transfer] Cannot create receive JV — clearing or purchase ledger missing');
    return null;
  }

  let unresolvedGst = 0;
  const gstLines: Array<{ ledgerId: number; debit: number; credit: number }> = [];
  const tryGstHead = async (suffix: string, amt: number) => {
    if (!(amt > 0.004)) return;
    const lid = await ledgerIdByCode(client, `STD-INP-${suffix}`);
    if (lid) gstLines.push({ ledgerId: lid, debit: r2(amt), credit: 0 });
    else unresolvedGst = r2(unresolvedGst + amt);
  };
  if (taxType === 'igst') {
    await tryGstHead('IGST', gst.igst);
  } else if (taxType === 'cgst_sgst') {
    await tryGstHead('CGST', gst.cgst);
    await tryGstHead('SGST', gst.sgst);
  }

  const lines = [
    { ledgerId: purId,            debit: r2(gst.taxableValue + unresolvedGst), credit: 0 },
    ...gstLines,
    { ledgerId: branchCreditorId, debit: 0, credit: gst.totalWithGst },
  ];

  const { rows: [v] } = await client.query(
    `INSERT INTO journal_vouchers
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by,
        origin, source_module)
     VALUES ('branch_transfer_purchase', $1, $2, $3, $4, $5, $6, $7, 'system', 'branch_transfer') RETURNING id`,
    [`TRF-RCV-${challanNumber}`, transferDate, narration, branchCreditorId,
     'Inter-branch taxable transfer — destination side', gst.totalWithGst, createdBy],
  );
  const vid = v?.id;
  if (!vid) return null;

  for (const l of lines) {
    if (!(l.debit > 0.004) && !(l.credit > 0.004)) continue;
    await client.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1,$2,$3,$4)`,
      [vid, l.ledgerId, r2(l.debit), r2(l.credit)],
    );
  }
  return vid;
}

// ═════════════════════════════════════════════════════════════════════════════
// TRANSFER TAX INVOICES
//
// A transfer between two different GSTINs is a taxable supply. The journal
// vouchers above record the accounting, but GSTR-1, GSTR-3B and the HSN summary
// all read the `sales` and `purchases` tables and cannot see journal vouchers —
// so without real invoice rows the supply is invisible to the returns.
//
// These invoices REPLACE the dispatch/receive vouchers for a transfer; they are
// never created alongside them. buildDerivedPostings() recognises a transfer
// invoice by its branch_transfer_id and posts it to the inter-branch clearing
// ledgers instead of Sales/Purchases, so turnover and the P&L stay untouched.
// Creating both would double-count revenue, tax and receivables.
// ═════════════════════════════════════════════════════════════════════════════

/** Master switch. When off, transfers fall back to the journal-voucher path. */
export async function isTransferInvoicingEnabled(db: PoolLike): Promise<boolean> {
  try {
    const { rows: [r] } = await db.query(
      `SELECT COALESCE(gst_transfer_invoicing, TRUE) AS on FROM company_settings ORDER BY id LIMIT 1`,
    );
    return r ? r.on === true : true;
  } catch {
    return false;   // column missing (migration not yet run) → old behaviour
  }
}

/**
 * Next number in the branch-transfer invoice series, e.g. BTR/2025-26/0001.
 *
 * Its own sequence, incremented atomically in the caller's transaction — the
 * same UPDATE ... RETURNING pattern the customer series uses. Never COUNT(*),
 * which repeats a number as soon as one document is deleted. A separate series
 * (not the customer INV one) keeps the customer sales register gap-free.
 */
export async function nextTransferInvoiceNumber(client: PoolLike): Promise<string> {
  const { rows: [r] } = await client.query(
    `UPDATE company_settings
        SET branch_transfer_sequence = COALESCE(branch_transfer_sequence, 0) + 1
      WHERE id = (SELECT id FROM company_settings ORDER BY id LIMIT 1)
      RETURNING COALESCE(branch_transfer_prefix, 'BTR') AS prefix,
                branch_transfer_sequence AS seq,
                COALESCE(financial_year, '') AS fy`,
  );
  // Fail closed. If there is no settings row the UPDATE touches nothing, and
  // returning a default would hand the same statutory number to every transfer
  // — worse than refusing to dispatch. The startup migration seeds the row, so
  // this only fires if something deleted it.
  if (!r || r.seq == null) {
    throw new Error(
      'Cannot issue a transfer invoice number: company settings are missing. ' +
      'Open Company → Settings and save once, then retry the transfer.',
    );
  }
  const seq = Number(r.seq);
  const prefix = String(r.prefix ?? 'BTR');
  const fy = String(r.fy ?? '').trim();
  const padded = String(seq).padStart(4, '0');
  return fy ? `${prefix}/${fy}/${padded}` : `${prefix}/${padded}`;
}

export interface TransferInvoiceArgs {
  client: PoolLike;
  transferId: number;
  invoiceNumber: string;
  transferDate: string;
  fromLocation: LocationGst;
  toLocation: LocationGst;
  lines: TransferInvoiceLine[];
  totals: GstTotals;
  challanNumber: string;
}

/**
 * Sender's outward tax invoice. Written straight to `sales` with
 * branch_transfer_id set, no customer and the receiving branch's details in the
 * party_* columns — GSTR-1 needs a GSTIN to classify the supply as B2B, and
 * auto-creating a customer master for every branch would pollute the masters
 * and the credit-control tables.
 */
export async function createTransferSaleInvoice(args: TransferInvoiceArgs): Promise<number | null> {
  const { client, transferId, invoiceNumber, transferDate, fromLocation, toLocation, lines, totals } = args;
  if (!(totals.taxableValue > 0)) return null;

  // The derived books post this invoice's receivable to STD-BRANCH-DEBTOR —
  // with a silent fallback to Sundry Debtors when that ledger is missing.
  // The voucher path provisioned it, but a business that has ALWAYS invoiced
  // its transfers never ran that path, so every branch receivable quietly
  // inflated Sundry Debtors instead. Provision it here, where the invoice is
  // born.
  await ensureClearingLedger(client, 'STD-BRANCH-DEBTOR', 'Inter-Branch Receivable', 'asset', 'balance_sheet', 'SYS-CURA');

  // BTR numbers come from their own GLOBAL statutory sequence, but the row
  // still carries the same internal number identity as ordinary sales so the
  // per-location unique indexes cover it (a stricter global partial unique on
  // BTR numbers remains in force on top).
  const numberScope = await salesCounterScope(client, {
    type: fromLocation.locationType, id: fromLocation.locationId,
  });
  const ident = parseDocNumberIdentity(invoiceNumber);
  const { rows: [s] } = await client.query(
    `INSERT INTO sales
       (invoice_number, outlet_id, customer_id, sale_date, line_items,
        subtotal, tax_total, discount_total, total_amount,
        payment_mode, payment_status, amount_paid,
        location_type, location_id,
        branch_transfer_id, party_name, party_gstin, party_state,
        number_scope, invoice_series, invoice_fy, invoice_serial)
     VALUES ($1, NULL, NULL, $2, $3, $4, $5, 0, $6, 'credit', 'unpaid', 0, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16)
     RETURNING id`,
    [
      invoiceNumber, transferDate, JSON.stringify(lines),
      totals.taxableValue, totals.totalGst, totals.totalWithGst,
      fromLocation.locationType, fromLocation.locationId,
      transferId, toLocation.name, toLocation.gstin, toLocation.state,
      numberScope, ident?.series ?? null, ident?.fyLabel ?? null, ident?.serial ?? null,
    ],
  );
  return s?.id ?? null;
}

/**
 * Receiver's inward tax invoice, written to `purchases`.
 *
 * Reuses the sender's invoice number on purpose: in a real branch transfer the
 * receiving GSTIN books the supplier's tax invoice under that supplier's
 * number, and GSTR-2A/2B reconciliation matches on it. It is also raised for
 * the DISPATCHED quantities, not the received ones — the document has to mirror
 * the sender's invoice or the input credit will not match the supplier's output
 * tax. A short receipt is a separate shortage claim, not a quieter invoice.
 */
export async function createTransferPurchaseInvoice(args: TransferInvoiceArgs): Promise<number | null> {
  const { client, transferId, invoiceNumber, transferDate, fromLocation, toLocation, lines, totals, challanNumber } = args;
  if (!(totals.taxableValue > 0)) return null;

  // Same trap as the sale side: the derived books credit STD-BRANCH-CREDITOR
  // for this inward invoice, falling back to Sundry Creditors if it is
  // missing. Provision it here so invoice-mode-only businesses get it too.
  await ensureClearingLedger(client, 'STD-BRANCH-CREDITOR', 'Inter-Branch Payable', 'liability', 'balance_sheet', 'SYS-CURL');

  const { rows: [p] } = await client.query(
    `INSERT INTO purchases
       (vendor_id, purchase_date, invoice_number, line_items, total_amount,
        tax_total, discount_total, round_off,
        branch_type, branch_id, location_type, location_id,
        branch_transfer_id, party_name, party_gstin, party_state, notes)
     VALUES (NULL, $1, $2, $3, $4, $5, 0, 0, $6, $7, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      transferDate, invoiceNumber, JSON.stringify(lines), totals.totalWithGst, totals.totalGst,
      toLocation.locationType, toLocation.locationId,
      transferId, fromLocation.name, fromLocation.gstin, fromLocation.state,
      `Inter-branch transfer ${challanNumber} received from ${fromLocation.name}`,
    ],
  );
  return p?.id ?? null;
}

// ── Rejection: credit note ────────────────────────────────────────────────────

export interface TransferCreditNoteArgs {
  client: PoolLike;
  transferId: number;
  saleId: number;
  invoiceNumber: string;
  transferDate: string;
  fromLocation: LocationGst;
  toLocation: LocationGst;
  totals: GstTotals;
  taxType: TaxType;
  challanNumber: string;
  reason: string | null;
  createdBy: string | null;
}

/**
 * Goods rejected after a tax invoice was raised. Two things happen, and both
 * are needed:
 *
 *  1. A credit-note journal voucher reversing the invoice's postings, so the
 *     trial balance stays balanced and the reversal is on the audit trail
 *     under its own voucher number.
 *  2. The sale row is stamped cancelled_at, which is what removes it from
 *     GSTR-1/GSTR-3B.
 *
 * Both are required because credit notes do not yet reduce the GST returns — a
 * credit note alone would leave the tax over-reported. There is no double
 * subtraction: the returns read the sales/purchases tables and never read
 * journal vouchers, and buildDerivedPostings deliberately keeps posting the
 * cancelled invoice so this voucher is what cancels it in the books.
 *
 * Caveat for the user: if the return for that period was already filed, the
 * credit note is the correct instrument and cancelling retroactively changes an
 * already-filed figure. This path only cancels because nothing is filed yet.
 */
export async function createTransferCreditNote(args: TransferCreditNoteArgs): Promise<number | null> {
  const { client, saleId, invoiceNumber, transferDate, fromLocation, toLocation,
          totals, taxType, challanNumber, reason, createdBy } = args;
  if (!(totals.taxableValue > 0)) return null;

  const [branchDebtorId, clearingId] = await Promise.all([
    ensureClearingLedger(client, 'STD-BRANCH-DEBTOR', 'Inter-Branch Receivable', 'asset', 'balance_sheet', 'SYS-CURA'),
    ensureClearingLedger(client, 'STD-BRANCH-TRF', 'Inter-Branch Transfer', 'liability', 'balance_sheet', 'SYS-CURL'),
  ]);
  if (!branchDebtorId || !clearingId) return null;

  // Mirror image of the invoice postings.
  const lines: Array<{ ledgerId: number; debit: number; credit: number }> = [
    { ledgerId: clearingId, debit: totals.taxableValue, credit: 0 },
  ];
  let unresolvedGst = 0;
  const addHead = async (suffix: string, amt: number) => {
    if (!(amt > 0.004)) return;
    const lid = await ledgerIdByCode(client, `STD-OUT-${suffix}`);
    if (lid) lines.push({ ledgerId: lid, debit: r2(amt), credit: 0 });
    else unresolvedGst = r2(unresolvedGst + amt);
  };
  if (taxType === 'igst') await addHead('IGST', totals.igst);
  else if (taxType === 'cgst_sgst') { await addHead('CGST', totals.cgst); await addHead('SGST', totals.sgst); }
  if (unresolvedGst > 0.004) lines[0].debit = r2(lines[0].debit + unresolvedGst);
  lines.push({ ledgerId: branchDebtorId, debit: 0, credit: totals.totalWithGst });

  const { rows: [v] } = await client.query(
    `INSERT INTO journal_vouchers
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by,
        origin, source_module)
     VALUES ('credit_note', $1, $2, $3, $4, $5, $6, $7, 'system', 'branch_transfer') RETURNING id`,
    [`CN-${invoiceNumber}`, transferDate,
     `Credit note against transfer invoice ${invoiceNumber} — ${challanNumber} rejected by ${toLocation.name}`,
     branchDebtorId,
     reason ? `Transfer rejected: ${reason}` : 'Inter-branch transfer rejected by receiver',
     totals.totalWithGst, createdBy],
  );
  const vid = v?.id;
  if (!vid) return null;

  for (const l of lines) {
    if (!(l.debit > 0.004) && !(l.credit > 0.004)) continue;
    await client.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1,$2,$3,$4)`,
      [vid, l.ledgerId, r2(l.debit), r2(l.credit)],
    );
  }

  // Drops the invoice out of GSTR-1/GSTR-3B (see the note above on why this is
  // needed in addition to the credit note).
  await client.query(`UPDATE sales SET cancelled_at = now() WHERE id = $1`, [saleId]);
  void fromLocation;
  return vid;
}
