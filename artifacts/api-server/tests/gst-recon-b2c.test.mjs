/**
 * Task 297 — GST reconciliation drill-down & invoice-wise GSTR-1 B2C.
 *
 * Proves, against the live dev dataset (no fixtures written):
 *  1. Recon attribution decomposes EXACTLY: for every tax head, the head-level
 *     ledger-vs-register difference equals Σ(per-document differences) +
 *     Σ(other GST-ledger entries) for that head. matched/checked are
 *     consistent with the drill-down detail.
 *  2. GSTR-1 b2c invoice-wise rows aggregate exactly into the b2cs portal
 *     rows per (place of supply, rate); totals are unchanged by the addition;
 *     every b2c row carries invoice value + payment status/mode.
 *  3. Location filter parity: the global x-location-* headers scope
 *     /gst/summary and /gst/gstr1 identically to the explicit query param,
 *     and the headoffice header means company-wide (type-only semantics).
 *  4. Export completeness evidence: gstr1/gstr3b/hsn responses are internally
 *     consistent (section sums == reported totals), so a file built from the
 *     same response reproduces the screen.
 *
 * Run: node tests/gst-recon-b2c.test.mjs   (from artifacts/api-server)
 * Uses TEST_USERNAME/TEST_PASSWORD (falls back to admin/marlin1458).
 */
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const USERNAME = process.env.TEST_USERNAME || "admin";
const PASSWORD = process.env.TEST_PASSWORD || "marlin1458";

const FROM = "2026-04-01";
const TO = "2026-08-14";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
const r2 = (n) => Math.round(n * 100) / 100;

async function api(path, token, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { token } = await login.json();

  // ── 1. Reconciliation attribution decomposition ───────────────────────────
  console.log("\n[1] /gst/reconciliation drill-down");
  const recon = await api(`/gst/reconciliation?fromDate=${FROM}&toDate=${TO}`, token);

  check("has mismatchDocs {outward,inward}", recon.mismatchDocs
    && Array.isArray(recon.mismatchDocs.outward) && Array.isArray(recon.mismatchDocs.inward));
  check("has otherEntries[]", Array.isArray(recon.otherEntries));
  check("has checked counts", recon.checked
    && Number.isFinite(recon.checked.sales) && Number.isFinite(recon.checked.purchases)
    && Number.isFinite(recon.checked.salesMismatched) && Number.isFinite(recon.checked.purchasesMismatched));
  check("checked counts consistent with mismatch lists",
    recon.checked.salesMismatched === recon.mismatchDocs.outward.length
    && recon.checked.purchasesMismatched === recon.mismatchDocs.inward.length,
    `checked=${JSON.stringify(recon.checked)} lists=${recon.mismatchDocs.outward.length}/${recon.mismatchDocs.inward.length}`);

  // pre-existing fields still present (regression: response shape only adds)
  for (const k of ["rows", "dtxDirect", "salesTaxTotal", "salesLumpResidual", "matched", "note"]) {
    check(`legacy field '${k}' present`, k in recon);
  }
  check("6 head rows", recon.rows.length === 6, `got ${recon.rows.length}`);

  // Exact decomposition per head: rows[].difference == Σ doc diffs + Σ otherEntries
  const attributed = Object.fromEntries(recon.rows.map((r) => [r.head, 0]));
  for (const d of recon.mismatchDocs.outward) {
    attributed["Output CGST"] += d.difference.cgst;
    attributed["Output SGST"] += d.difference.sgst;
    attributed["Output IGST"] += d.difference.igst;
  }
  for (const d of recon.mismatchDocs.inward) {
    attributed["Input CGST"] += d.difference.cgst;
    attributed["Input SGST"] += d.difference.sgst;
    attributed["Input IGST"] += d.difference.igst;
  }
  for (const e of recon.otherEntries) {
    check(`otherEntry head known (${e.head})`, e.head in attributed);
    if (e.head in attributed) attributed[e.head] += e.amount;
  }
  for (const row of recon.rows) {
    check(`head '${row.head}' difference fully attributed`,
      near(row.difference, attributed[row.head], 0.05),
      `row.difference=${row.difference} attributed=${r2(attributed[row.head])}`);
  }

  // matched flag must agree with the head rows it summarises
  const allHeadsClean = recon.rows.every((r) => Math.abs(r.difference) < 0.01);
  check("matched flag agrees with head rows", recon.matched === allHeadsClean);

  // every mismatch doc row is drillable + explained
  for (const d of [...recon.mismatchDocs.outward, ...recon.mismatchDocs.inward].slice(0, 20)) {
    check(`mismatch doc ${d.documentNumber} has id/type/reason`,
      Number.isFinite(d.id) && (d.docType === "sale" || d.docType === "purchase")
      && typeof d.reason === "string" && d.reason.length > 0
      && d.ledger && d.register && d.difference && Number.isFinite(d.differenceTotal));
  }
  // otherEntries rows carry provenance for the drill-down
  for (const e of recon.otherEntries.slice(0, 20)) {
    check(`otherEntry ${e.entryId} has provenance`,
      typeof e.entryId === "string" && e.entryId.includes(":")
      && typeof e.source === "string" && typeof e.head === "string"
      && Number.isFinite(e.amount));
  }

  // ── 2. GSTR-1 invoice-wise B2C ────────────────────────────────────────────
  console.log("\n[2] /gst/gstr1 b2c invoice-wise");
  const g1 = await api(`/gst/gstr1?fromDate=${FROM}&toDate=${TO}`, token);
  check("has b2c[]", Array.isArray(g1.b2c));
  check("b2b/b2cs/totals unchanged shape", Array.isArray(g1.b2b) && Array.isArray(g1.b2cs) && g1.totals);

  // Every b2c row carries the new detail columns
  check("all b2c rows have invoiceValue + payment fields", g1.b2c.every((r) =>
    typeof r.invoiceNumber === "string" && typeof r.saleDate === "string"
    && Number.isFinite(r.invoiceValue)
    && typeof r.paymentStatus === "string" && typeof r.paymentModes === "string"));

  // b2c rows aggregate exactly into b2cs per (pos, rate)
  const agg = new Map();
  for (const r of g1.b2c) {
    const k = `${r.placeOfSupply}|${r.taxRate}`;
    const e = agg.get(k) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
    for (const f of Object.keys(e)) e[f] = r2(e[f] + r[f]);
    agg.set(k, e);
  }
  check("b2c covers the same (pos,rate) groups as b2cs", agg.size === g1.b2cs.length,
    `b2c groups=${agg.size} b2cs=${g1.b2cs.length}`);
  for (const row of g1.b2cs) {
    const e = agg.get(`${row.placeOfSupply}|${row.taxRate}`);
    check(`b2cs (${row.placeOfSupply || "—"}, ${row.taxRate}%) equals Σ b2c`,
      !!e && ["taxableValue", "cgst", "sgst", "igst", "taxAmount"].every((f) => near(e[f], row[f])),
      e ? JSON.stringify({ agg: e, row: { taxableValue: row.taxableValue, taxAmount: row.taxAmount } }) : "no group");
  }
  // distinct invoice count matches the totals the screen already showed
  const distinctB2c = new Set(g1.b2c.map((r) => r.invoiceNumber)).size;
  check("distinct b2c invoices == totals.b2cInvoices", distinctB2c === g1.totals.b2cInvoices,
    `${distinctB2c} vs ${g1.totals.b2cInvoices}`);

  // Totals still equal the section sums (regression: no math change)
  const sum = (rows, k) => r2(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0));
  check("totals.taxableValue == Σ b2b + Σ b2cs",
    near(g1.totals.taxableValue, r2(sum(g1.b2b, "taxableValue") + sum(g1.b2cs, "taxableValue")), 0.05));
  check("totals.taxAmount == Σ b2b + Σ b2cs",
    near(g1.totals.taxAmount, r2(sum(g1.b2b, "taxAmount") + sum(g1.b2cs, "taxAmount")), 0.05));
  check("totals.cgst+sgst+igst == taxAmount",
    near(r2(g1.totals.cgst + g1.totals.sgst + g1.totals.igst), g1.totals.taxAmount, 0.05));

  // ── 3. Location filter parity (global header vs explicit param) ──────────
  console.log("\n[3] location filter parity");
  const pairs = [
    ["/gst/summary", "/gst/summary?warehouseId=1"],
    [`/gst/gstr1?fromDate=${FROM}&toDate=${TO}`, `/gst/gstr1?fromDate=${FROM}&toDate=${TO}&warehouseId=1`],
    [`/gst/hsn-summary?fromDate=${FROM}&toDate=${TO}`, `/gst/hsn-summary?fromDate=${FROM}&toDate=${TO}&warehouseId=1`],
  ];
  for (const [hdrPath, paramPath] of pairs) {
    const viaHeader = await api(hdrPath, token, { "x-location-type": "warehouse", "x-location-id": "1" });
    const viaParam = await api(paramPath, token);
    check(`${hdrPath.split("?")[0]} header == param`,
      JSON.stringify(viaHeader) === JSON.stringify(viaParam));
    const hoHeader = await api(hdrPath, token, { "x-location-type": "headoffice" });
    const unfiltered = await api(hdrPath, token);
    check(`${hdrPath.split("?")[0]} HO header == company-wide`,
      JSON.stringify(hoHeader) === JSON.stringify(unfiltered));
  }

  // ── 4. Export completeness: section sums == reported totals ──────────────
  console.log("\n[4] export completeness evidence");
  const hsn = await api(`/gst/hsn-summary?fromDate=${FROM}&toDate=${TO}`, token);
  for (const side of ["outward", "inward"]) {
    check(`hsn totals.${side} == Σ ${side} rows`,
      near(hsn.totals[side].taxableValue, sum(hsn[side], "taxableValue"), 0.05)
      && near(hsn.totals[side].taxAmount, sum(hsn[side], "taxAmount"), 0.05),
      JSON.stringify(hsn.totals[side]));
  }

  // GSTR-3B set-off follows the statutory order; the exportable invariant is
  // conservation: utilised credit + cash payable == total outward tax.
  const g3b = await api(`/gst/gstr3b?month=2026-05`, token);
  check("gstr3b outward.totalTax == cgst+sgst+igst",
    near(g3b.outwardSupplies.totalTax,
      r2(g3b.outwardSupplies.cgst + g3b.outwardSupplies.sgst + g3b.outwardSupplies.igst), 0.05));
  check("gstr3b conservation: (itc − carriedForward) + netPayable == outward tax",
    near(r2(g3b.itc.totalItc - g3b.itcCarriedForward.total + g3b.netPayable.total),
      g3b.outwardSupplies.totalTax, 0.05),
    JSON.stringify({ itc: g3b.itc.totalItc, carried: g3b.itcCarriedForward.total, net: g3b.netPayable.total, out: g3b.outwardSupplies.totalTax }));

  // recon head rows reproduce in the export exactly (same response object) —
  // the screen and CSV/PDF are built from ONE fetch, so consistency above is
  // the parity proof; here we assert the response is stable across two reads.
  const recon2 = await api(`/gst/reconciliation?fromDate=${FROM}&toDate=${TO}`, token);
  check("recon response deterministic across reads",
    JSON.stringify(recon2.rows) === JSON.stringify(recon.rows)
    && recon2.mismatchDocs.outward.length === recon.mismatchDocs.outward.length);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
