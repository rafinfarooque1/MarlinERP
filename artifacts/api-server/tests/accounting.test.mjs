/**
 * Accounting Integration Tests
 * Run: node artifacts/api-server/tests/accounting.test.mjs
 *
 * Verifies the double-entry accounting engine end-to-end against a real
 * database (same DB the API uses — NOT production):
 *
 *  1. Sale creation → derived postings balance (Dr Cash = Cr Sales + Cr Output GST)
 *  2. Purchase receipt → Dr Purchases + Dr Input GST / Cr Vendor (balanced)
 *  3. Payroll approval → Journal Voucher Dr SAL-EMP / Cr SAL-PAY
 *  4. Stock transfer with different GSTINs → Dispatch JV Dr BRANCH-DEBTOR / Cr Sales + Cr GST
 *
 * Design notes:
 *  - Tests compare full-trial-balance totals before/after each operation. This
 *    avoids the pg date-column → JS Date object vs string comparison pitfall that
 *    makes `fromDate` filtering unreliable in buildDerivedPostings.
 *  - Each test creates real rows in the DB and leaves them there (integration
 *    tests are intentionally non-destructive of DB state after the test).
 *  - The test is safe to run against the dev database; it will not corrupt
 *    production because it never touches the production connection.
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';

let authToken = '';
let passed = 0;
let failed = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function apiReq(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const post  = (path, body) => apiReq('POST',   path, body);
const get   = (path)       => apiReq('GET',    path);
const del   = (path)       => apiReq('DELETE', path);
const patch = (path, body) => apiReq('PATCH',  path, body);

const round2 = (n) => Math.round(n * 100) / 100;

/** Snapshot total Dr and total Cr across the full trial balance. */
async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: round2(rows.reduce((s, r) => s + Number(r.debit  ?? 0), 0)),
    totalCr: round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
    balanced: res.data?.balanced ?? true,
    byCode: Object.fromEntries(rows.filter(r => r.code).map(r => [r.code, r])),
    rows,
  };
}

// ── Auth ───────────────────────────────────────────────────────────────────
// The admin account uses DEFAULT_INITIAL_PASSWORD ('marlin1458') set by the
// startup migration. mustChangePassword may be true but the token is still
// valid for all API calls.

console.log('\n[0] Authentication');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken,
  `status=${loginRes.status} body=${JSON.stringify(loginRes.data).slice(0, 120)}`);

if (!authToken) {
  console.error('\nFATAL: Cannot obtain auth token — aborting.');
  console.log(`\n${'─'.repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ── Shared setup — read existing DB entities ───────────────────────────────

const [outletsRes, itemsRes, vendorsRes, warehousesRes] = await Promise.all([
  get('/outlets'),
  get('/items'),
  get('/vendors'),
  get('/warehouses'),
]);

const outlets    = outletsRes.data    ?? [];
const items      = itemsRes.data      ?? [];
const vendors    = vendorsRes.data    ?? [];
const warehouses = warehousesRes.data ?? [];

// Find a taxable item (taxRate > 0) — use warehouse sale since warehouse stock
// is seeded at headoffice→warehouse transfers in normal operation.
const taxableItem = items.find(i => Number(i.taxRate) > 0);
// Karnataka Central Warehouse (id=1) reliably has stock in this dev DB
const warehouse   = warehouses[0];

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Sale creation → derived postings balance (Dr = Cr)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[1] Sale creation → trial balance stays balanced (Dr = Cr)');

if (!warehouse || !taxableItem) {
  console.log(`  (skipped — no warehouse=${!!warehouse} or taxable item=${!!taxableItem})`);
} else {
  const tbBefore = await snapshotTB();
  assert('Trial balance balanced before sale', tbBefore.balanced,
    `totalDr=${tbBefore.totalDr} totalCr=${tbBefore.totalCr}`);

  // Create a warehouse sale (warehouse 1 has stock for taxable items).
  // Price at the item's master MRP (min ₹100): the sale API enforces
  // unitPrice ≥ master MRP. All assertions below scale off the response.
  const unitPrice = Math.max(100, Number(taxableItem.mrp ?? 0));
  const saleRes = await post('/sales', {
    outletId:     warehouse.id,
    locationType: 'warehouse',
    locationId:   warehouse.id,
    saleDate:     new Date().toISOString().slice(0, 10),
    paymentMode:  'cash',
    lineItems: [{
      itemId:    taxableItem.id,
      quantity:  1,
      unitPrice,
      discount:  0,
      taxAmount: 0,
    }],
  });

  assert('Sale created successfully', !saleRes.data?.error,
    JSON.stringify(saleRes.data).slice(0, 200));

  if (!saleRes.data?.error) {
    const sale  = saleRes.data;
    const total = Number(sale.totalAmount);
    const tax   = Number(sale.taxTotal   ?? 0);
    const net   = round2(total - tax);

    assert('Sale total > 0',                total > 0,   `total=${total}`);
    assert('Sale has GST (taxTotal > 0)',   tax   > 0,   `taxTotal=${tax}`);
    assert('Line item has CGST or IGST',
      (sale.lineItems ?? []).some(li => Number(li.cgst ?? 0) > 0 || Number(li.igst ?? 0) > 0),
      `lineItems=${JSON.stringify(sale.lineItems?.slice(0,1))}`);
    assert('Sale is fully paid (cash)',
      Number(sale.amountPaid) >= total - 0.01,
      `amountPaid=${sale.amountPaid} total=${total}`);

    // Trial balance must still balance after the sale
    const tbAfter = await snapshotTB();
    const diff    = Math.abs(round2(tbAfter.totalDr - tbAfter.totalCr));
    assert('Trial balance balanced after sale (|Dr − Cr| < 0.01)', diff < 0.01,
      `totalDr=${tbAfter.totalDr} totalCr=${tbAfter.totalCr} diff=${diff}`);

    // The Dr side must have grown by exactly the sale total (cash debit)
    const drDelta = round2(tbAfter.totalDr - tbBefore.totalDr);
    assert(`Debit side increased by ≈ ₹${total.toFixed(2)} (cash received)`,
      Math.abs(drDelta - total) < 0.05,
      `drBefore=${tbBefore.totalDr} drAfter=${tbAfter.totalDr} delta=${drDelta} expected=${total}`);

    // The Cr side must have grown by exactly the sale total (Sales + GST credit)
    const crDelta = round2(tbAfter.totalCr - tbBefore.totalCr);
    assert(`Credit side increased by ≈ ₹${total.toFixed(2)} (Sales + GST credited)`,
      Math.abs(crDelta - total) < 0.05,
      `crBefore=${tbBefore.totalCr} crAfter=${tbAfter.totalCr} delta=${crDelta} expected=${total}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Purchase receipt → Dr Purchases + Dr Input GST / Cr Vendor payable
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[2] Purchase receipt → Dr Purchases + Dr Input GST / Cr Vendor');

let vendor = vendors[0];
if (!vendor) {
  const vr = await post('/vendors', {
    name: 'Accounting Test Vendor', gstNumber: '29ZZZZT1234A1Z5', state: 'Karnataka',
  });
  if (!vr.data?.error) vendor = vr.data;
}

if (!vendor?.id) {
  console.log('  (skipped — cannot find or create a vendor)');
} else {
  const tbBefore = await snapshotTB();

  // Fixture: any live item works — the line sends its own gstRate/hsn, so the
  // math is fixed regardless of which product carries it. (The old hardcoded
  // material #1 fixture died when the materials master was emptied.)
  const purMasters = (await get('/items')).data ?? [];
  const purMaster  = purMasters[0];

  // Create a purchase with 12% GST (intra-state)
  const purchaseRes = await post('/purchases', {
    vendorId:       vendor.id,
    purchaseDate:   new Date().toISOString().slice(0, 10),
    vendorInvoiceDate: new Date().toISOString().slice(0, 10),
    invoiceNumber:  `ACCTEST-${Date.now()}`,
    // Batch dates are required on every purchase line: frozen stock cannot be
    // expiry-checked without them. The batch number itself is left blank so the
    // server issues one.
    lineItems: [{
      materialType: 'item',
      materialId:   purMaster?.id ?? -1,
      quantity:     5,
      unitCost:     100,
      hsnCode:      '0801',
      discount:     0,
      gstRate:      12,
      taxType:      'intra',
      mfgDate:      '2026-01-01',
      expiryDate:   '2027-01-01',
    }],
  });

  assert('Purchase created successfully', !purchaseRes.data?.error,
    JSON.stringify(purchaseRes.data).slice(0, 200));

  if (!purchaseRes.data?.error) {
    const pur      = purchaseRes.data;
    const total    = Number(pur.totalAmount);
    const taxTotal = Number(pur.taxTotal ?? 0);

    // Expected: 5 × 100 = 500 taxable, 500 × 12% = 60 GST → total = 560
    assert('Purchase total = 560 (5 × ₹100 + 12% GST)', Math.abs(total - 560) < 0.01,
      `total=${total}`);
    assert('Purchase taxTotal = 60',  Math.abs(taxTotal - 60) < 0.01,
      `taxTotal=${taxTotal}`);

    const tbAfter = await snapshotTB();

    // Trial balance must stay balanced
    const diff = Math.abs(round2(tbAfter.totalDr - tbAfter.totalCr));
    assert('Trial balance balanced after purchase (|Dr − Cr| < 0.01)', diff < 0.01,
      `diff=${diff}`);

    // Dr side grew by the full purchase total (Purchases debit + Input GST debit)
    const drDelta = round2(tbAfter.totalDr - tbBefore.totalDr);
    assert(`Debit side increased by ≈ ₹${total.toFixed(2)} (Purchases + Input GST)`,
      Math.abs(drDelta - total) < 0.05,
      `drBefore=${tbBefore.totalDr} drAfter=${tbAfter.totalDr} delta=${drDelta} expected=${total}`);

    // Cr side grew by the full purchase total (vendor payable)
    const crDelta = round2(tbAfter.totalCr - tbBefore.totalCr);
    assert(`Credit side increased by ≈ ₹${total.toFixed(2)} (vendor payable credited)`,
      Math.abs(crDelta - total) < 0.05,
      `crBefore=${tbBefore.totalCr} crAfter=${tbAfter.totalCr} delta=${crDelta} expected=${total}`);

    // Vendor ledger code is VEND-{id} — it should appear with a credit balance
    const vendLedgerCode = `VEND-${vendor.id}`;
    const vendRow = tbAfter.byCode[vendLedgerCode];
    if (vendRow) {
      assert(`Vendor ledger (${vendLedgerCode}) credit ≈ ₹${total.toFixed(2)}`,
        Number(vendRow.credit) >= total - 0.05,
        `credit=${vendRow.credit}`);
    } else {
      // Vendor may be grouped under SYS-CREDITORS
      console.log(`  (vendor ledger ${vendLedgerCode} not in TB — likely grouped; skipping ledger-level check)`);
    }

    // Input GST heads should have debit entries
    const inpCgst = tbAfter.byCode['STD-INP-CGST'];
    const inpSgst = tbAfter.byCode['STD-INP-SGST'];
    // If these ledger codes exist, they should have grown
    if (inpCgst || inpSgst) {
      const cgstBefore = Number(tbBefore.byCode['STD-INP-CGST']?.debit ?? 0);
      const sgstBefore = Number(tbBefore.byCode['STD-INP-SGST']?.debit ?? 0);
      const cgstAfter  = Number(inpCgst?.debit ?? 0);
      const sgstAfter  = Number(inpSgst?.debit ?? 0);
      const inputTaxDelta = round2((cgstAfter - cgstBefore) + (sgstAfter - sgstBefore));
      assert('Input GST ledgers increased by ≈ ₹60 (CGST + SGST)',
        Math.abs(inputTaxDelta - taxTotal) < 0.05,
        `cgstDelta=${cgstAfter - cgstBefore} sgstDelta=${sgstAfter - sgstBefore} expected=${taxTotal}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Payroll approval → Journal Voucher Dr SAL-EMP-* / Cr SAL-PAY-*
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[3] Payroll approval → Dr SAL-EMP / Cr SAL-PAY journal voucher');

const hierarchiesRes = await get('/hr/hierarchies');
const hierarchies    = hierarchiesRes.data ?? [];
const testHierarchy  = hierarchies.find(h => Number(h.level) > 1) ?? hierarchies[0];

if (!testHierarchy?.id) {
  console.log('  (skipped — no employee hierarchy found)');
} else {
  const ts     = Date.now();
  const empRes = await post('/hr/employees', {
    name:        `PayrollTestEmp_${ts}`,
    username:    `paytest_${ts}`,
    hierarchyId: testHierarchy.id,
    branchType:  'headoffice',
    branchId:    1,
    salary:      30000,
    joinDate:    '2019-01-01',
    isActive:    true,
  });

  assert('Test employee created', !empRes.data?.error,
    JSON.stringify(empRes.data).slice(0, 200));

  const empId = empRes.data?.id;

  if (empId) {
    // Generate payroll for month=1, year=2020 (arbitrary past month)
    const genRes = await post('/hr/payroll/generate', {
      employeeId:  empId,
      month:       1,
      year:        2020,
      workingDays: 26,
      presentDays: 26,
    });

    assert('Payroll generated', !genRes.data?.error && genRes.status !== 500,
      `status=${genRes.status} body=${JSON.stringify(genRes.data).slice(0, 200)}`);

    // genRes may return an array (bulk generate) or a single row
    const payrollRows = Array.isArray(genRes.data) ? genRes.data : [genRes.data];
    const payroll     = payrollRows.find(r => r.employeeId === empId || r.employee_id === empId)
                        ?? payrollRows[0];

    assert('Payroll row exists for test employee', !!payroll, `empId=${empId}`);

    if (payroll?.id) {
      const netPay = Number(payroll.netPay ?? payroll.net_pay ?? 0);
      assert('Net pay > 0', netPay > 0, `netPay=${netPay}`);

      // Count JVs before approval
      const jvBefore  = await get('/accounts/journal-vouchers?type=journal');
      const jvsBefore = jvBefore.data ?? [];
      const countBefore = jvsBefore.length;

      // Approve
      const approveRes = await post(`/hr/payroll/${payroll.id}/approve`, {});
      assert('Payroll approved', !approveRes.data?.error,
        JSON.stringify(approveRes.data).slice(0, 200));

      if (!approveRes.data?.error) {
        assert('Status = approved', approveRes.data?.status === 'approved',
          `status=${approveRes.data?.status}`);

        const jvAfter  = await get('/accounts/journal-vouchers?type=journal');
        const jvsAfter = jvAfter.data ?? [];
        assert('A new journal voucher created on approval',
          jvsAfter.length > countBefore,
          `before=${countBefore} after=${jvsAfter.length}`);

        // Find the salary JV for this employee (lines use SAL-EMP-{id} or SAL-PAY-{id})
        const salCode = `SAL-EMP-${empId}`;
        const payCode = `SAL-PAY-${empId}`;

        const salaryJv = jvsAfter.find(v =>
          (v.lines ?? []).some(l => l.ledgerCode === salCode || l.ledgerCode === payCode)
        );

        assert('Salary JV found for test employee', !!salaryJv,
          `looking for ${salCode}/${payCode} in ${jvsAfter.length} JVs`);

        if (salaryJv) {
          const lines = salaryJv.lines ?? [];
          const drLine = lines.find(l => l.ledgerCode === salCode  && Number(l.debit)  > 0);
          const crLine = lines.find(l => l.ledgerCode === payCode  && Number(l.credit) > 0);

          assert(`JV debits  SAL-EMP-${empId} (salary expense)`,  !!drLine,
            `lines=${JSON.stringify(lines.map(l => ({ code: l.ledgerCode, dr: l.debit, cr: l.credit })))}`);
          assert(`JV credits SAL-PAY-${empId} (salary payable)`, !!crLine,
            `lines=${JSON.stringify(lines.map(l => ({ code: l.ledgerCode, dr: l.debit, cr: l.credit })))}`);

          if (drLine && crLine) {
            const jvDr = Number(drLine.debit);
            const jvCr = Number(crLine.credit);
            assert('JV is balanced (Dr = Cr)', Math.abs(jvDr - jvCr) < 0.01,
              `dr=${jvDr} cr=${jvCr}`);
            assert('JV amount = employee net pay', Math.abs(jvDr - netPay) < 0.01,
              `jvDr=${jvDr} netPay=${netPay}`);
          }

          assert('Voucher total_amount = net pay',
            Math.abs(Number(salaryJv.totalAmount) - netPay) < 0.01,
            `voucherTotal=${salaryJv.totalAmount} netPay=${netPay}`);
        }

        // Trial balance must stay balanced after payroll approval
        const tbAfterPay = await snapshotTB();
        const payDiff    = Math.abs(round2(tbAfterPay.totalDr - tbAfterPay.totalCr));
        assert('Trial balance balanced after payroll approval', payDiff < 0.01,
          `diff=${payDiff}`);
      }
    }

    // Note: the test employee is left in the DB — deleting fails when payroll
    // rows exist (FK constraint). This is intentional for integration tests.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Stock transfer with different GSTINs → Dispatch JV Dr BRANCH-DEBTOR / Cr Sales + Cr GST
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[4] Cross-GSTIN stock transfer → Dispatch JV with correct Dr/Cr split');

// Find a pair of locations with different, non-empty GSTINs.
// Accept both intrastate (CGST+SGST) and interstate (IGST) pairs.
const allLocs = [
  ...warehouses.map(w => ({
    id: w.id, name: w.name,
    gstin: w.gstNumber ?? w.gst_number ?? '',
    state: w.state ?? '', type: 'warehouse',
  })),
  ...outlets.map(o => ({
    id: o.id, name: o.name,
    gstin: o.gstin ?? '',
    state: o.state ?? '', type: 'outlet',
  })),
].filter(l => l.gstin && l.gstin.trim());

let srcLoc = null, dstLoc = null;
let expectedTaxType = null;

// Prefer same-state pair (intrastate); fall back to different-state (interstate)
for (const a of allLocs) {
  for (const b of allLocs) {
    if (a === b || a.gstin === b.gstin) continue;
    if (!srcLoc) { srcLoc = a; dstLoc = b; expectedTaxType = 'igst'; } // any pair
    if (a.state.toLowerCase() === b.state.toLowerCase()) {
      srcLoc = a; dstLoc = b; expectedTaxType = 'cgst_sgst';
      break;
    }
  }
  if (expectedTaxType === 'cgst_sgst') break;
}

if (!srcLoc || !dstLoc) {
  console.log('  (skipped — no pair of locations with different GSTINs found in DB)');
  console.log(`  (locations with GSTIN: ${allLocs.map(l => l.name + '/' + l.type).join(', ')})`);
} else if (!taxableItem) {
  console.log('  (skipped — no taxable item found)');
} else {
  console.log(`  Using: ${srcLoc.name} (${srcLoc.type}) → ${dstLoc.name} (${dstLoc.type})`);
  console.log(`  Expected transfer type: ${expectedTaxType === 'cgst_sgst' ? 'intrastate (CGST+SGST)' : 'interstate (IGST)'}`);

  // Count existing JVs
  const jvBefore = await get('/accounts/journal-vouchers');
  const jvCountBefore = (jvBefore.data ?? []).length;

  const tbBefore = await snapshotTB();

  const transferRes = await post('/stock/transfers', {
    fromType:     srcLoc.type,
    fromId:       srcLoc.id,
    toType:       dstLoc.type,
    toId:         dstLoc.id,
    transferDate: new Date().toISOString().slice(0, 10),
    lineItems: [{
      itemId:    taxableItem.id,
      quantity:  1,
      costPrice: 100,
    }],
    notes: 'Accounting integration test transfer',
  });

  assert('Stock transfer created successfully', !transferRes.data?.error,
    JSON.stringify(transferRes.data).slice(0, 300));

  if (!transferRes.data?.error) {
    const createdId     = transferRes.data.id;
    const challanNumber = transferRes.data.challanNumber;

    // The POST response omits accounting fields — fetch the full record
    const detailRes = await get(`/stock/transfers/${createdId}`);
    const transfer  = detailRes.data;

    const tType      = transfer.transferType;
    const txType     = transfer.taxType;
    const gstAmount  = Number(transfer.gstAmount ?? 0);

    assert('Transfer type is taxable (intrastate or interstate)',
      tType === 'intrastate' || tType === 'interstate',
      `transferType=${tType}`);
    assert('Tax type set correctly (cgst_sgst or igst)',
      txType === expectedTaxType,
      `taxType=${txType} expected=${expectedTaxType}`);
    assert('GST amount > 0', gstAmount > 0, `gstAmount=${gstAmount}`);

    // A cross-GSTIN dispatch raises EITHER a transfer tax invoice (the
    // default since transfer invoicing shipped) OR the legacy TRF- journal
    // voucher (module switched off) — never both, or revenue would double.
    const docMode = transfer.documentMode ?? 'voucher';

    if (docMode === 'invoice') {
      const invNo  = transfer.transferInvoiceNumber;
      const saleId = transfer.saleId;
      assert('Invoice mode: transfer invoice number stamped', !!invNo, `transferInvoiceNumber=${invNo}`);
      assert('Invoice mode: linked sale id stamped', !!saleId, `saleId=${saleId}`);

      if (saleId) {
        const saleRes = await get(`/sales/${saleId}`);
        const tSale   = saleRes.data;
        assert('Invoice mode: transfer sale fetchable', !tSale?.error,
          JSON.stringify(tSale).slice(0, 200));
        if (!tSale?.error) {
          const saleTotal = Number(tSale.totalAmount ?? 0);
          const transferValue = Number(transfer.transferValue ?? 0);
          const expectedTotal = round2(transferValue + gstAmount);
          assert(`Invoice mode: sale total = taxable + GST (≈ ₹${expectedTotal.toFixed(2)})`,
            Math.abs(saleTotal - expectedTotal) < 0.05,
            `saleTotal=${saleTotal} expected=${expectedTotal}`);
        }
      }

      // No TRF- JV may exist alongside the invoice
      const jvsAll = (await get('/accounts/journal-vouchers')).data ?? [];
      const dupJv  = jvsAll.find(v => v.voucherNumber === `TRF-${challanNumber}`);
      assert('Invoice mode: no duplicate TRF- voucher raised', !dupJv,
        `found voucher id=${dupJv?.id}`);
    } else {

    // Dispatch JV voucher number is always TRF-{challanNumber}
    const jvsAll   = (await get('/accounts/journal-vouchers')).data ?? [];
    const dispJv   = jvsAll.find(v => v.voucherNumber === `TRF-${challanNumber}`);
    const dispVid  = dispJv?.id;

    assert('Dispatch voucher ID is set on transfer', !!dispVid,
      `dispatch_voucher_id=${dispVid}`);

    // New JV should exist
    const jvAfter = await get('/accounts/journal-vouchers');
    assert('New JV created for the transfer',
      (jvAfter.data ?? []).length > jvCountBefore,
      `before=${jvCountBefore} after=${(jvAfter.data??[]).length}`);

    if (dispVid) {
      const dvRes = await get(`/accounts/journal-vouchers/${dispVid}`);
      assert('Dispatch JV fetchable by ID', !dvRes.data?.error,
        JSON.stringify(dvRes.data).slice(0, 200));

      if (!dvRes.data?.error) {
        const dv    = dvRes.data;
        const lines = dv.lines ?? [];

        // Dr line: STD-BRANCH-DEBTOR (total with GST)
        const drBranchDebtor = lines.find(l => l.ledgerCode === 'STD-BRANCH-DEBTOR' && Number(l.debit) > 0);

        // Cr lines: Sales + Output GST heads
        const crSales  = lines.find(l => Number(l.credit) > 0 && l.ledgerCode !== 'STD-BRANCH-DEBTOR'
          && l.ledgerCode !== 'STD-OUT-CGST' && l.ledgerCode !== 'STD-OUT-SGST' && l.ledgerCode !== 'STD-OUT-IGST');
        const crGstIg  = lines.find(l => l.ledgerCode === 'STD-OUT-IGST'  && Number(l.credit) > 0);
        const crGstCg  = lines.find(l => l.ledgerCode === 'STD-OUT-CGST'  && Number(l.credit) > 0);
        const crGstSg  = lines.find(l => l.ledgerCode === 'STD-OUT-SGST'  && Number(l.credit) > 0);

        const linesSummary = JSON.stringify(
          lines.map(l => ({ code: l.ledgerCode, dr: l.debit, cr: l.credit }))
        );

        assert('Dispatch JV debits STD-BRANCH-DEBTOR', !!drBranchDebtor, `lines=${linesSummary}`);
        assert('Dispatch JV has a Sales credit line', !!crSales, `lines=${linesSummary}`);

        if (expectedTaxType === 'igst') {
          assert('Dispatch JV credits STD-OUT-IGST (interstate)', !!crGstIg, `lines=${linesSummary}`);
        } else {
          assert('Dispatch JV credits STD-OUT-CGST (intrastate)', !!crGstCg, `lines=${linesSummary}`);
          assert('Dispatch JV credits STD-OUT-SGST (intrastate)', !!crGstSg, `lines=${linesSummary}`);
        }

        // JV itself must balance
        const jvTotalDr = round2(lines.reduce((s, l) => s + Number(l.debit  ?? 0), 0));
        const jvTotalCr = round2(lines.reduce((s, l) => s + Number(l.credit ?? 0), 0));
        assert('Dispatch JV is balanced (Dr = Cr)', Math.abs(jvTotalDr - jvTotalCr) < 0.01,
          `totalDr=${jvTotalDr} totalCr=${jvTotalCr}`);

        // BRANCH-DEBTOR debit = taxable value + GST
        if (drBranchDebtor) {
          const transferValue = Number(transfer.transferValue ?? transfer.transfer_value ?? 0);
          const expectedDebit = round2(transferValue + gstAmount);
          assert(`BRANCH-DEBTOR debit = taxable + GST (≈ ₹${expectedDebit.toFixed(2)})`,
            Math.abs(Number(drBranchDebtor.debit) - expectedDebit) < 0.05,
            `actual=${drBranchDebtor.debit} expected=${expectedDebit}`);
        }

        // GST credits must add up to the total GST amount
        const totalGstCr = round2(
          Number(crGstIg?.credit ?? 0) +
          Number(crGstCg?.credit ?? 0) +
          Number(crGstSg?.credit ?? 0)
        );
        assert(`Output GST credits sum = ₹${gstAmount.toFixed(2)}`,
          Math.abs(totalGstCr - gstAmount) < 0.05,
          `actual=${totalGstCr} expected=${gstAmount}`);
      }
    }
    } // end voucher-mode branch

    // Trial balance must remain balanced after transfer
    const tbAfter = await snapshotTB();
    const tbDiff  = Math.abs(round2(tbAfter.totalDr - tbAfter.totalCr));
    assert('Trial balance balanced after stock transfer', tbDiff < 0.01,
      `diff=${tbDiff}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
