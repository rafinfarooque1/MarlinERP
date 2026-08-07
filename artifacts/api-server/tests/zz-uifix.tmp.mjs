// Disposable UI-test fixture for the edit-sale stock validation fix.
// Creates: ZZUIFIX item, purchase of 66 into warehouse 2, sale of 60 (shelf = 6).
// Prints the ids needed for the UI test and for cleanup. Run with MODE=clean to remove.
import pg from 'pg';
const BASE = 'http://localhost:8080/api';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (t, p) => pool.query(t, p);
let tok = '';
async function api(m, p, b) {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}
tok = (await api('POST', '/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' })).data.token;
const WH = 2;

if (process.env.MODE === 'clean') {
  const { rows: sales } = await sql(`SELECT id, invoice_number FROM sales WHERE line_items::text LIKE '%ZZUIFIX%' OR id IN (SELECT id FROM sales WHERE location_type='warehouse' AND location_id=$1 AND line_items @> (SELECT COALESCE(json_agg(json_build_object('itemId', id))::jsonb,'[]'::jsonb) FROM items WHERE name LIKE 'ZZUIFIX%'))`, [WH]).catch(() => ({ rows: [] }));
  const { rows: items } = await sql(`SELECT id FROM items WHERE name LIKE 'ZZUIFIX%'`);
  const itemIds = items.map(r => r.id);
  if (itemIds.length) {
    const { rows: s2 } = await sql(`SELECT id, invoice_number FROM sales WHERE location_type='warehouse' AND location_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(line_items::jsonb) li WHERE (li->>'itemId')::int = ANY($2::int[]))`, [WH, itemIds]);
    for (const s of s2) {
      await api('POST', `/sales/${s.id}/cancel`, {});
      await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [s.invoice_number]);
      await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
      await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
    }
    const { rows: purs } = await sql(`SELECT DISTINCT p.id FROM purchases p WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p.line_items::jsonb) li WHERE (li->>'materialId')::int = ANY($1::int[]) AND li->>'materialType'='item')`, [itemIds]);
    for (const p of purs) await api('DELETE', `/purchases/${p.id}`);
    await sql(`DELETE FROM stock_ledger WHERE item_name LIKE 'ZZUIFIX%'`);
    await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type='item' AND source IN ('purchase','sale')`, [itemIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type='item' AND created_at > now() - interval '1 day'`, [itemIds]);
    await sql(`DELETE FROM items WHERE id = ANY($1::int[])`, [itemIds]);
  }
  await sql(`DELETE FROM account_ledgers WHERE name LIKE 'ZZUIFIX%' AND code LIKE 'VEND-%'`);
  await sql(`DELETE FROM vendors WHERE name LIKE 'ZZUIFIX%'`);
  console.log('cleaned', { sales: sales.length, items: itemIds.length });
} else {
  const vendor = (await sql(`INSERT INTO vendors (name, state, gst_number) VALUES ('ZZUIFIX Vendor','Karnataka','29ZZUIF1234F1Z5') RETURNING id`)).rows[0].id;
  const item = (await sql(`INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status) VALUES ('ZZUIFIX Edit Test Mango','KG','08119030',5,100,'FG-ZZUIFIX-1','2900000000121','active') RETURNING id`)).rows[0].id;
  const pur = await api('POST', '/purchases', { vendorId: vendor, purchaseDate: '2026-07-30', locationType: 'warehouse', locationId: WH, lineItems: [{ materialType: 'item', materialId: item, quantity: 66, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }] });
  const sale = await api('POST', '/sales', { outletId: WH, locationType: 'warehouse', locationId: WH, saleDate: '2026-07-31', paymentMode: 'cash', lineItems: [{ itemId: item, quantity: 60, unitPrice: 100, discount: 0 }] });
  const { rows: [st] } = await sql(`SELECT quantity::text AS q FROM stock_entries WHERE item_id=$1 AND material_type='item' AND branch_type='warehouse' AND branch_id=$2`, [item, WH]);
  console.log(JSON.stringify({ vendor, item, purchase: pur.data?.id, saleId: sale.data?.id, invoice: sale.data?.invoiceNumber, shelfNow: st?.q }));
}
await pool.end();
