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

/**
 * Compute GST totals for transfer lines.
 * Item GST rates are resolved from the DB; materials default to 0%.
 */
export async function computeTransferGst(
  db: PoolLike,
  lines: Array<{ itemId: number; quantity: number; costPrice: number }>,
  taxType: TaxType,
): Promise<GstTotals> {
  if (!lines.length || taxType === 'none') {
    return { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, totalGst: 0, totalWithGst: 0 };
  }

  const ids = [...new Set(lines.map(l => l.itemId))];
  const rateMap = new Map<number, number>();
  if (ids.length > 0) {
    const { rows } = await db.query(
      `SELECT id, COALESCE(gst_rate, 0)::numeric AS gst_rate FROM items WHERE id = ANY($1::int[])`,
      [ids],
    );
    for (const r of rows) rateMap.set(Number(r.id), Number(r.gst_rate));
  }

  let taxableValue = 0, cgst = 0, sgst = 0, igst = 0;
  for (const l of lines) {
    const lineVal = r2(Number(l.quantity) * Number(l.costPrice));
    const rate    = rateMap.get(l.itemId) ?? 0;
    taxableValue  = r2(taxableValue + lineVal);
    if (taxType === 'igst') {
      igst = r2(igst + r2(lineVal * rate / 100));
    } else if (taxType === 'cgst_sgst') {
      cgst = r2(cgst + r2(lineVal * rate / 2 / 100));
      sgst = r2(sgst + r2(lineVal * rate / 2 / 100));
    }
  }

  const totalGst = r2(cgst + sgst + igst);
  return { taxableValue, cgst, sgst, igst, totalGst, totalWithGst: r2(taxableValue + totalGst) };
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
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by)
     VALUES ('branch_transfer_sale', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
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
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by)
     VALUES ('branch_transfer_purchase', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
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
