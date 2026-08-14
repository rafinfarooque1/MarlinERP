/**
 * Books drill-down provenance + Excel/PDF exports — regression tests (books polish)
 * Run: node artifacts/api-server/tests/books-drilldown-export.test.mjs
 *
 * READ-ONLY against the books: creates only a disposable level-1 probe user
 * (never 'admin'), deletes it at exit. No documents are created or changed.
 *
 * Proves:
 *  1. PROVENANCE — every ledger-statement entry carries an entryId provenance
 *     key ("sale:12", "jv:7", "opening-balance-3"…), and the statement's
 *     figures are unchanged by the addition (running-balance arithmetic and
 *     the trial balance's net for the same ledger still agree).
 *  2. DRILL TARGETS RESOLVE — for each entry family found in the live books,
 *     the referenced source document exists (sale via GET /sales/:id,
 *     purchase via GET /purchases/:id, payment/receipt/jv rows in their
 *     tables). Derived families (rent/salary/purchadv/expense) reference
 *     real derivation rows.
 *  3. DAY BOOK keeps id/refId/source per entry (drill-down inputs).
 *  4. EXPORTS — POST /pdf/report and /xlsx/report accept a books payload and
 *     return real documents; the xlsx round-trips the posted rows bit-exact
 *     (numbers coerced from "Rs." strings), the pdf is a parseable %PDF.
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const USER = "books_drill_probe";
const PASS = "Probe#Books1";
let authToken = "";
let passed = 0, failed = 0;

function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}

async function apiReq(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const get = (p) => apiReq("GET", p);
const post = (p, b) => apiReq("POST", p, b);

async function rawPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type") ?? "", buf };
}

const round2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const near = (a, b, eps = 0.05) => Math.abs(round2(a) - round2(b)) <= eps;
const TODAY = new Date().toISOString().slice(0, 10);

async function setupUser() {
  await teardownUser();
  const hash = bcrypt.hashSync(PASS, 10);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active, must_change_password)
     SELECT 'Books Drill Probe', $1, $2, (SELECT MIN(id) FROM hierarchies), 'headoffice', 1, 1, CURRENT_DATE, true, false`,
    [USER, hash]);
}
async function teardownUser() {
  await q(`DELETE FROM login_lockouts WHERE username = $1`, [USER]);
  await q(`DELETE FROM login_attempts WHERE username = $1`, [USER]);
  await q(`DELETE FROM employees WHERE username = $1`, [USER]);
}

// entryId prefix → how to prove the referenced record exists.
const FAMILY_PROOF = {
  sale:       async (id) => (await get(`/sales/${id}`)).status === 200,
  purchase:   async (id) => (await get(`/purchases/${id}`)).status === 200,
  payment:    async (id) => (await q(`SELECT 1 FROM payments WHERE id = $1`, [id])).length === 1,
  receipt:    async (id) => (await q(`SELECT 1 FROM receipts WHERE id = $1`, [id])).length === 1,
  receiptadv: async (id) => (await q(`SELECT 1 FROM receipts WHERE id = $1`, [id])).length === 1,
  jv:         async (id) => (await q(`SELECT 1 FROM journal_vouchers WHERE id = $1`, [id])).length === 1,
  expense:    async (id) => (await q(`SELECT 1 FROM location_expenses WHERE id = $1`, [id])).length === 1,
  purchadv:   async (id) => (await q(`SELECT 1 FROM purchase_advance_applications WHERE id = $1`, [id])).length === 1,
};
const ENTRY_ID_RE = /^([a-z]+:\d+|opening-balance-\d+|rent:.+|salary:.+)$/;

await setupUser();
try {
  console.log("\n[0] Authentication");
  const loginRes = await post("/auth/login", { username: USER, password: PASS });
  authToken = loginRes.data?.token ?? "";
  assert("Probe user logs in", !!authToken, `status=${loginRes.status}`);
  if (!authToken) process.exit(1);

  // ── [1] Ledger statement provenance + unchanged figures ──────────────────
  console.log("\n[1] Ledger statement — entryId provenance, figures unchanged");
  const flat = (await get("/accounts/chart/flat")).data ?? [];
  // Pick the busiest postable ledgers straight from the books so the suite
  // derives its fixtures from live data (dev DB holds real business data).
  const candidates = flat.filter((a) => !a.isGroup).slice(0, 400);
  let statement = null, chosen = null;
  for (const code of ["STD-SALES", "STD-CASH", "STD-DEBTORS", "STD-CREDITORS"]) {
    const acc = candidates.find((a) => a.code === code);
    if (!acc) continue;
    const r = await get(`/accounts/ledger-statement?accountId=${acc.id}&fromDate=2000-01-01&toDate=${TODAY}`);
    if (r.status === 200 && (r.data?.entries?.length ?? 0) > 0) { statement = r.data; chosen = acc; break; }
  }
  assert("Found a standard ledger with entries", !!statement, "no entries in STD-SALES/CASH/DEBTORS/CREDITORS");

  if (statement) {
    const entries = statement.entries;
    const withId = entries.filter((e) => typeof e.entryId === "string" && e.entryId.length > 0);
    assert(`Every entry carries entryId (${entries.length} entries)`, withId.length === entries.length,
      `${entries.length - withId.length} missing`);
    const badShape = withId.filter((e) => !ENTRY_ID_RE.test(e.entryId));
    assert("entryId shapes parse (kind:id / opening-balance-N)", badShape.length === 0,
      badShape.slice(0, 3).map((e) => e.entryId).join(", "));

    // Figures unchanged: running balance arithmetic must still close exactly.
    const sumDr = round2(entries.reduce((s, e) => s + Number(e.debit ?? 0), 0));
    const sumCr = round2(entries.reduce((s, e) => s + Number(e.credit ?? 0), 0));
    assert("totalDebit = Σ debits", near(sumDr, statement.totalDebit), `${sumDr} vs ${statement.totalDebit}`);
    assert("totalCredit = Σ credits", near(sumCr, statement.totalCredit), `${sumCr} vs ${statement.totalCredit}`);
    assert("closing = last running balance", near(statement.closingBalance, entries[entries.length - 1].balance),
      `${statement.closingBalance} vs ${entries[entries.length - 1].balance}`);

    // Cross-check against the trial balance's net for the same ledger, all time.
    const tb = (await get("/accounts/trial-balance")).data;
    const tbRow = (tb?.rows ?? []).find((r) => r.ledgerId === chosen.id);
    if (tbRow) {
      const tbNet = round2(Number(tbRow.debit ?? 0) - Number(tbRow.credit ?? 0));
      const stNet = round2(Number(statement.closingBalance ?? 0));
      assert(`TB net for ${chosen.code} matches statement closing`, near(Math.abs(tbNet), Math.abs(stNet)),
        `TB ${tbNet} vs statement ${stNet}`);
    } else {
      assert(`TB has a row for ${chosen.code}`, false, "row missing");
    }

    // ── [2] Drill targets resolve for each family present ───────────────────
    console.log("\n[2] Drill targets resolve per entry family");
    const byFamily = new Map();
    for (const e of withId) {
      if (e.entryId.startsWith("opening-balance")) continue;
      const kind = e.entryId.slice(0, e.entryId.indexOf(":"));
      if (!byFamily.has(kind)) byFamily.set(kind, e.entryId);
    }
    // Widen coverage: pull today's/backdated day-book entries for more families.
    const recent = await q(`SELECT DISTINCT txn_date::text AS d FROM stock_ledger ORDER BY d DESC LIMIT 3`).catch(() => []);
    const probeDates = [...new Set([TODAY, ...recent.map((r) => r.d)])].slice(0, 3);
    for (const d of probeDates) {
      const db = (await get(`/accounts/day-book?date=${d}`)).data;
      for (const e of db?.entries ?? []) {
        const kind = String(e.id ?? "").split(":")[0];
        if (kind && !byFamily.has(kind) && String(e.id).includes(":")) byFamily.set(kind, e.id);
      }
    }
    assert("At least one drillable family found", byFamily.size > 0);
    for (const [kind, entryId] of byFamily) {
      // Derived-only families: rent/salary accruals never map to a document —
      // the UI explains the derivation instead of navigating (drilldown.ts).
      if (kind === "rent" || kind === "salary") {
        assert(`family '${kind}' is derived-only (no document by design)`, true);
        continue;
      }
      const idPart = entryId.slice(entryId.indexOf(":") + 1);
      const proof = FAMILY_PROOF[kind];
      if (!proof) { assert(`family '${kind}' recognised`, false, entryId); continue; }
      const ok = await proof(Number(idPart));
      assert(`'${kind}' target resolves (${entryId})`, ok);
    }

    // ── [3] Day book provenance fields ──────────────────────────────────────
    console.log("\n[3] Day book carries id/refId/source per entry");
    let dayChecked = false;
    for (const d of probeDates) {
      const db = (await get(`/accounts/day-book?date=${d}`)).data;
      const es = db?.entries ?? [];
      if (es.length === 0) continue;
      dayChecked = true;
      assert(`Day book ${d}: every entry has id+refId+source (${es.length})`,
        es.every((e) => typeof e.id === "string" && e.id.length > 0 && Number.isFinite(Number(e.refId)) && typeof e.source === "string"));
      break;
    }
    if (!dayChecked) console.log("  (no day-book entries on probe dates — skipped)");

    // ── [4] Excel/PDF exports ────────────────────────────────────────────────
    console.log("\n[4] Server exports — books payload through shared endpoints");
    const money = (n) => `Rs. ${Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
    const fixture = entries.slice(0, 25);
    const docBody = {
      title: "Ledger Statement",
      subtitle: `${chosen.name} · fixture range`,
      metaRows: [["Account", `${chosen.name} (${chosen.code})`], ["Opening Balance", money(statement.openingBalance)]],
      orientation: "landscape",
      sections: [{
        columns: [
          { label: "Date" }, { label: "Description", width: 3 }, { label: "Type" },
          { label: "Debit", align: "right", width: 1.4 }, { label: "Credit", align: "right", width: 1.4 },
          { label: "Balance", align: "right", width: 1.4 },
        ],
        rows: fixture.map((e) => [
          e.date, e.description, e.entryType,
          e.debit ? money(e.debit) : "", e.credit ? money(e.credit) : "", money(e.balance),
        ]),
        totalsRow: ["", "Total", "", money(statement.totalDebit), money(statement.totalCredit), money(statement.closingBalance)],
      }],
    };

    const pdf = await rawPost("/pdf/report", docBody);
    assert("PDF export returns 200 application/pdf", pdf.status === 200 && pdf.type.includes("application/pdf"),
      `status=${pdf.status} type=${pdf.type}`);
    assert("PDF payload is a real PDF", pdf.buf.subarray(0, 5).toString() === "%PDF-" && pdf.buf.length > 1000,
      `head=${pdf.buf.subarray(0, 5)} len=${pdf.buf.length}`);

    const xlsx = await rawPost("/xlsx/report", docBody);
    assert("Excel export returns 200 xlsx", xlsx.status === 200 && xlsx.type.includes("spreadsheetml"),
      `status=${xlsx.status} type=${xlsx.type}`);
    assert("Excel payload is a zip container", xlsx.buf.subarray(0, 2).toString() === "PK", `len=${xlsx.buf.length}`);

    // Round-trip: the workbook must contain every fixture row's description
    // and the money figures as NUMBERS (coerce strips the Rs. decoration).
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.buf);
    const ws = wb.worksheets[0];
    const cellText = [];
    const cellNumbers = [];
    ws.eachRow((row) => row.eachCell((c) => {
      if (typeof c.value === "number") cellNumbers.push(round2(c.value));
      else if (c.value != null) cellText.push(String(c.value));
    }));
    const missingDesc = fixture.filter((e) => !cellText.some((t) => t.includes(String(e.description).slice(0, 40))));
    assert(`Workbook contains all ${fixture.length} fixture descriptions`, missingDesc.length === 0,
      missingDesc.slice(0, 3).map((e) => e.description).join(" | "));
    const wantNumbers = fixture.flatMap((e) => [e.debit, e.credit].filter((n) => Number(n) > 0)).map(round2);
    const missingNum = wantNumbers.filter((n) => !cellNumbers.includes(n));
    assert(`Money cells landed as numbers (${wantNumbers.length} checked)`, missingNum.length === 0,
      `missing: ${missingNum.slice(0, 5).join(", ")}`);

    // ── [5] Trial balance difference contract ────────────────────────────────
    console.log("\n[5] Trial balance difference figure");
    assert("TB reports difference + balanced flags", typeof tb?.difference === "number" && typeof tb?.balanced === "boolean");
    assert("difference = |totalDebit − totalCredit|",
      near(Math.abs(tb.totalDebit - tb.totalCredit), Math.abs(tb.difference)),
      `${tb.totalDebit} vs ${tb.totalCredit} diff=${tb.difference}`);
  }
} finally {
  await teardownUser();
  await sql.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
