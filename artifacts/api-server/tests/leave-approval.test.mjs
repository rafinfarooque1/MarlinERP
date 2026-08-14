/**
 * Task 183 — leave approval workflow with payroll-safe attendance sync.
 *
 * Proves: pending leave pays NOTHING, approval pays exactly the leave days,
 * rejection/cancellation leave payroll untouched, self-approval is refused,
 * warehouse scoping holds for list and decide, a real check-in survives an
 * overlapping approval, and legacy apply-time stamps come off at rejection.
 *
 * Disposable fixtures only — creates its own employees/role, cleans up at
 * the end and checks the voucher book is still balanced.
 */
const BASE = "http://localhost:8080/api";
let TOKEN = "";

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}${detail ? `\n        ${detail}` : ""}`);
}
const near = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol;

async function raw(method, path, body, token = TOKEN) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, ok: r.ok, data: json };
}
async function api(method, path, body, token = TOKEN) {
  const r = await raw(method, path, body, token);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

// ── Direct SQL for verification (never for the flows under test) ──────────
import pg from "pg";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params = []) => (await sql.query(text, params)).rows;

// Fixture month = the CURRENT month (Asia/Kolkata). The daily salary-accrual
// sweep only prices days of the current month for a fresh employee, so a
// hardcoded past month reads accrual ₹0 forever once the calendar rolls over.
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const Y = Number(TODAY.slice(0, 4)), M = Number(TODAY.slice(5, 7));
const DOM = Number(TODAY.slice(8, 10));
if (DOM < 6) {
  // Leave days D(3)–D(5) must already be priced by the sweep.
  console.log(`SKIP: day of month is ${DOM} (< 6); the accrual checks need D(3)–D(5) in the past.`);
  process.exit(0);
}
const D = (d) => `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// Working-days basis = the month's actual calendar length (Aug 2026 change).
const DIM = new Date(Y, M, 0).getDate();
const LEAVE3 = Math.round((3 * (30000 / DIM)) * 100) / 100; // 3 paid days

async function attRows(empId, from, to) {
  return await q(
    `SELECT date, status, check_in FROM attendance
      WHERE employee_id=$1 AND date BETWEEN $2 AND $3 ORDER BY date`,
    [empId, from, to]);
}
async function accrualJuly(empId) {
  const [r] = await q(
    `SELECT COALESCE(SUM(amount),0) AS total FROM salary_accruals
      WHERE employee_id=$1 AND year=$2 AND month=$3`, [empId, Y, M]);
  return Number(r.total);
}

const created = { employees: [], hierarchies: [] };

// ── Company leave-policy pin/restore ────────────────────────────────────────
let savedGS = null;
async function pinPolicy(patch) {
  savedGS = (await api("GET", "/company/settings")).generalSettings ?? {};
  await api("PATCH", "/company/settings", { generalSettings: { ...savedGS, ...patch } });
}
async function restorePolicy() {
  if (savedGS) await api("PATCH", "/company/settings", { generalSettings: savedGS });
}

async function mkEmployee(name, hierarchyId, branchType, branchId) {
  const emp = await api("POST", "/hr/employees", {
    name, username: name.toLowerCase(),
    email: `${name.toLowerCase()}@test.local`, phone: "9111111111",
    hierarchyId, branchType, branchId, salary: 30000, joinDate: D(1),
  });
  created.employees.push({ id: emp.id, name });
  return emp;
}
const loginAs = async (username) =>
  (await api("POST", "/auth/login", { username, password: "marlin1458" })).token;

async function main() {
  TOKEN = (await api("POST", "/auth/login", {
    username: process.env.TEST_ADMIN_USER || process.env.TEST_USERNAME || "admin",
    password: process.env.TEST_ADMIN_PASSWORD || process.env.TEST_PASSWORD || "marlin1458",
  })).token;

  // Pay basis is COMPANY policy since the Aug 2026 LOP change. Pin what the
  // per-day expectations assume: allowance covering the 3 approved leave days,
  // LOP on. Restored after cleanup. (The working-days basis is the calendar
  // month now — not a setting.)
  await pinPolicy({ paidCasualLeavesPerMonth: 4, lopEnabled: true });
  const me = await api("GET", "/auth/me");
  const adminId = me.id;

  const hiers = await api("GET", "/hr/hierarchies");
  const adminHier = hiers.find((h) => h.level === 1) ?? hiers[0];
  const [wh] = await q(`SELECT id, name FROM warehouses ORDER BY id LIMIT 1`);
  if (!wh) throw new Error("no warehouse in dev DB");
  const stamp = Date.now();

  // View+add but NOT edit on the attendance/leave page: an employee, not an approver.
  const viewerHier = await api("POST", "/hr/hierarchies", { name: `LeaveTestViewer_${stamp}`, reportsToId: adminHier.id });
  created.hierarchies.push(viewerHier.id);
  await api("POST", "/company/permissions", {
    hierarchyId: viewerHier.id, module: "page:/hr/attendance",
    canView: true, canAdd: true, canEdit: false,
  });

  const empA = await mkEmployee(`LeaveTestA_${stamp}`, adminHier.id, "headoffice", 1);
  const apprW = await mkEmployee(`LeaveTestApprW_${stamp}`, adminHier.id, "warehouse", wh.id);
  const empV = await mkEmployee(`LeaveTestV_${stamp}`, viewerHier.id, "warehouse", wh.id);
  console.log(`\nfixtures: empA #${empA.id} (HO), approver #${apprW.id} @ ${wh.name}, viewer #${empV.id} @ ${wh.name}\n`);

  const tokA = await loginAs(empA.username ?? `leavetesta_${stamp}`);
  const tokW = await loginAs(apprW.username ?? `leavetestapprw_${stamp}`);
  const tokV = await loginAs(empV.username ?? `leavetestv_${stamp}`);

  // ── 1. Applying creates a PENDING request with zero payroll effect ────────
  const lv1 = await api("POST", "/hr/leaves", {
    employeeId: empA.id, fromDate: D(3), toDate: D(5), leaveType: "casual", reason: "family event",
  });
  check("A1", "Apply returns a pending request with enriched fields",
    lv1.status === "pending" && lv1.days === 3 && lv1.branchName === "Head Office" && !!lv1.createdAt,
    `status=${lv1.status} days=${lv1.days} branch=${lv1.branchName} createdAt=${lv1.createdAt}`);

  const att1 = await attRows(empA.id, D(3), D(5));
  const acc1 = await accrualJuly(empA.id);
  check("A2", "Pending leave stamps NO attendance and accrues NO salary",
    att1.length === 0 && near(acc1, 0),
    `attendance rows=${att1.length} (expected 0), July accrual ₹${acc1} (expected 0)`);

  // ── 2. Guard rails on the decision ────────────────────────────────────────
  const noNote = await raw("POST", `/hr/leaves/${lv1.id}/approve`, { status: "rejected" });
  check("B1", "Rejecting without a reason is refused (400)",
    noNote.status === 400, `got ${noNote.status}: ${JSON.stringify(noNote.data).slice(0, 120)}`);

  const selfAppr = await raw("POST", `/hr/leaves/${lv1.id}/approve`, { status: "approved" }, tokA);
  check("B2", "Self-approval is refused server-side (403)",
    selfAppr.status === 403, `got ${selfAppr.status}: ${JSON.stringify(selfAppr.data).slice(0, 120)}`);

  // ── 3. Approval stamps the days and pays exactly them ─────────────────────
  const approved = await api("POST", `/hr/leaves/${lv1.id}/approve`, { status: "approved" });
  check("C1", "Approval records approver identity and timestamp",
    approved.status === "approved" && approved.approvedBy === adminId && !!approved.approvedAt && !!approved.approverName,
    `status=${approved.status} approvedBy=${approved.approvedBy} (admin=${adminId}) at=${approved.approvedAt} name=${approved.approverName}`);

  const att2 = await attRows(empA.id, D(3), D(5));
  const acc2 = await accrualJuly(empA.id);
  check("C2", "Approval stamps exactly the leave days and accrues exactly their pay",
    att2.length === 3 && att2.every((r) => r.status === "leave") && near(acc2, LEAVE3),
    `attendance rows=${att2.length}/3 all-leave=${att2.every((r) => r.status === "leave")}, July accrual ₹${acc2} (expected ₹${LEAVE3} = 3 paid days)`);

  const again = await raw("POST", `/hr/leaves/${lv1.id}/approve`, { status: "approved" });
  check("C3", "Deciding an already-decided request is refused (409)",
    again.status === 409, `got ${again.status}`);

  // Payroll agrees with the approved leave.
  await api("POST", "/hr/payroll/generate", { year: Y, month: M, employeeId: empA.id });
  const pr = (await api("GET", `/hr/payroll?year=${Y}&month=${M}`)).find((p) => Number(p.employeeId) === empA.id);
  const earned = Math.round((Number(pr?.baseSalary ?? 0) - Number(pr?.lopDeduction ?? 0)) * 100) / 100;
  check("C4", "Payroll pays exactly the approved leave days",
    pr && near(earned, LEAVE3),
    `earned basic ₹${earned} (base ${pr?.baseSalary} − LOP ${pr?.lopDeduction}); expected ₹${LEAVE3}`);

  // ── 4. Cancellation: own pending only, zero payroll effect ────────────────
  const lv2 = await api("POST", "/hr/leaves", {
    employeeId: empA.id, fromDate: D(13), toDate: D(14), leaveType: "sick",
  });
  const foreignCancel = await raw("POST", `/hr/leaves/${lv2.id}/cancel`, undefined);
  check("D1", "Even an admin cannot cancel someone else's request (403)",
    foreignCancel.status === 403, `got ${foreignCancel.status}`);

  const cancelled = await api("POST", `/hr/leaves/${lv2.id}/cancel`, undefined, tokA);
  const att3 = await attRows(empA.id, D(13), D(14));
  const acc3 = await accrualJuly(empA.id);
  check("D2", "Owner cancels own pending request; payroll untouched",
    cancelled.status === "cancelled" && !!cancelled.cancelledAt && att3.length === 0 && near(acc3, LEAVE3),
    `status=${cancelled.status} cancelledAt=${cancelled.cancelledAt}, attendance rows=${att3.length}, accrual ₹${acc3} (still ₹${LEAVE3})`);

  const cancelAgain = await raw("POST", `/hr/leaves/${lv2.id}/cancel`, undefined, tokA);
  check("D3", "Cancelling a non-pending request is refused (409)",
    cancelAgain.status === 409, `got ${cancelAgain.status}`);

  // ── 5. Rejection: reason recorded, zero payroll effect ────────────────────
  const lv3 = await api("POST", "/hr/leaves", {
    employeeId: empA.id, fromDate: D(20), toDate: D(21), leaveType: "annual",
  });
  const rejected = await api("POST", `/hr/leaves/${lv3.id}/approve`, { status: "rejected", note: "peak season" });
  const att4 = await attRows(empA.id, D(20), D(21));
  const acc4 = await accrualJuly(empA.id);
  check("E1", "Rejection records the reason and approver; payroll untouched",
    rejected.status === "rejected" && rejected.approvalNote === "peak season" && !!rejected.approverName
      && att4.length === 0 && near(acc4, LEAVE3),
    `status=${rejected.status} note=${rejected.approvalNote} by=${rejected.approverName}; attendance rows=${att4.length}, accrual ₹${acc4}`);

  // ── 6. Legacy apply-time stamps come off at rejection ─────────────────────
  const lv4 = await api("POST", "/hr/leaves", {
    employeeId: empA.id, fromDate: D(24), toDate: D(25), leaveType: "other",
  });
  // Simulate the OLD behaviour: the apply-time sync stamped the days already.
  await q(`INSERT INTO attendance (employee_id, date, status) VALUES ($1,$2,'leave'), ($1,$3,'leave')
           ON CONFLICT (employee_id, date) DO UPDATE SET status='leave'`, [empA.id, D(24), D(25)]);
  await api("POST", `/hr/leaves/${lv4.id}/approve`, { status: "rejected", note: "duplicate request" });
  const att5 = await attRows(empA.id, D(24), D(25));
  check("F1", "Rejecting a legacy-stamped request removes the apply-time stamps",
    att5.length === 0, `attendance rows left=${att5.length} (expected 0)`);

  // ── 7. A real check-in survives an overlapping approval ───────────────────
  await api("POST", "/hr/attendance/check-in", {
    employeeId: empV.id, timestamp: new Date().toISOString(), lat: 0, lng: 0,
  }, tokV);
  const lv5 = await api("POST", "/hr/leaves", {
    employeeId: empV.id, fromDate: TODAY, toDate: TODAY, leaveType: "sick",
  }, tokV);
  await api("POST", `/hr/leaves/${lv5.id}/approve`, { status: "approved" });
  const [todayRow] = await attRows(empV.id, TODAY, TODAY);
  check("G1", "Approval never overwrites a day with a real check-in",
    todayRow && todayRow.check_in !== null && todayRow.status !== "leave",
    `today's row: status=${todayRow?.status} check_in=${todayRow?.check_in ? "SET" : "NULL"} (must keep the worked record)`);

  // ── 8. Warehouse scoping ──────────────────────────────────────────────────
  const lvA2 = await api("POST", "/hr/leaves", {
    employeeId: empA.id, fromDate: D(29), toDate: D(29), leaveType: "casual",
  });
  const lvV2 = await api("POST", "/hr/leaves", {
    employeeId: empV.id, fromDate: D(27), toDate: D(27), leaveType: "casual",
  }, tokV);

  const wList = await api("GET", "/hr/leaves", undefined, tokW);
  const wSeesOwnWh = wList.some((l) => l.id === lvV2.id);
  const wSeesHO = wList.some((l) => l.employeeId === empA.id);
  check("H1", "Warehouse approver sees own warehouse's requests and NOT Head Office's",
    wSeesOwnWh && !wSeesHO,
    `sees warehouse request=${wSeesOwnWh}, sees HO request=${wSeesHO}`);

  const outOfScope = await raw("POST", `/hr/leaves/${lvA2.id}/approve`, { status: "approved" }, tokW);
  check("H2", "Warehouse approver cannot decide an out-of-scope request (404)",
    outOfScope.status === 404, `got ${outOfScope.status}`);

  const inScope = await raw("POST", `/hr/leaves/${lvV2.id}/approve`, { status: "approved" }, tokW);
  check("H3", "Warehouse approver CAN decide a request in their own warehouse",
    inScope.ok && inScope.data.status === "approved" && inScope.data.approvedBy === apprW.id,
    `status=${inScope.status} approvedBy=${inScope.data?.approvedBy} (expected ${apprW.id})`);

  const vList = await api("GET", "/hr/leaves", undefined, tokV);
  check("H4", "A non-approver employee sees only their own requests",
    vList.length > 0 && vList.every((l) => l.employeeId === empV.id),
    `${vList.length} row(s), foreign rows=${vList.filter((l) => l.employeeId !== empV.id).length}`);

  const noRight = await raw("POST", `/hr/leaves/${lvA2.id}/approve`, { status: "approved" }, tokV);
  check("H5", "An employee without the Edit right cannot approve at all (403)",
    noRight.status === 403, `got ${noRight.status} (page right must fail before scope)`);

  // ── 9. Server-side filters ────────────────────────────────────────────────
  const fStatus = await api("GET", `/hr/leaves?status=rejected&employeeId=${empA.id}`);
  const fType = await api("GET", `/hr/leaves?leaveType=sick&employeeId=${empA.id}`);
  const fRange = await api("GET", `/hr/leaves?fromDate=${D(20)}&toDate=${D(21)}&employeeId=${empA.id}`);
  check("I1", "Status, type and date-range filters work server-side",
    fStatus.length === 2 && fStatus.every((l) => l.status === "rejected")
      && fType.length === 1 && fType[0].id === lv2.id
      && fRange.length === 1 && fRange[0].id === lv3.id,
    `rejected=${fStatus.length}/2, sick=${fType.length}/1, range→#${fRange[0]?.id} (expected #${lv3.id})`);

  // ── 10. Audit trail ───────────────────────────────────────────────────────
  const audit = await q(
    `SELECT action, description FROM activity_log
      WHERE module='hr' AND entity_type='leave' AND entity_id=$1 ORDER BY id`, [lv1.id]);
  check("J1", "Apply and approve are both in the activity log",
    audit.some((a) => a.action === "CREATE") && audit.some((a) => a.action === "UPDATE" && /approved/.test(a.description)),
    audit.map((a) => `${a.action}: ${a.description.slice(0, 60)}`).join(" | ") || "no rows");

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await cleanup();
  await restorePolicy();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.id).join(", "));
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

async function cleanup() {
  for (const { id, name } of created.employees) {
    await q(`DELETE FROM salary_accruals WHERE employee_id=$1`, [id]);
    await q(`DELETE FROM attendance WHERE employee_id=$1`, [id]);
    await q(`DELETE FROM attendance_punches WHERE employee_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM payroll WHERE employee_id=$1`, [id]);
    await q(`DELETE FROM pay_components WHERE employee_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM leaves WHERE employee_id=$1`, [id]);
    // Vouchers deleted whole (lines first) — never one leg by ledger id.
    const vs = await q(`SELECT id FROM journal_vouchers WHERE narration LIKE $1`, [`%${name}%`]);
    for (const v of vs) {
      await q(`DELETE FROM journal_voucher_lines WHERE voucher_id=$1`, [v.id]);
      await q(`DELETE FROM journal_vouchers WHERE id=$1`, [v.id]);
    }
    await q(`DELETE FROM account_ledgers WHERE code IN ($1,$2,$3)`,
      [`SAL-EMP-${id}`, `SAL-PAY-${id}`, `ADV-EMP-${id}`]).catch(() => {});
    await q(`DELETE FROM employees WHERE id=$1`, [id]).catch(() => {});
  }
  for (const hid of created.hierarchies) {
    await q(`DELETE FROM permissions WHERE hierarchy_id=$1`, [hid]).catch(() => {});
    await q(`DELETE FROM hierarchies WHERE id=$1`, [hid]).catch(() => {});
  }
  const [bal] = await q(
    `SELECT COALESCE(SUM(l.debit),0) dr, COALESCE(SUM(l.credit),0) cr
       FROM journal_vouchers v JOIN journal_voucher_lines l ON l.voucher_id=v.id`);
  const gap = Math.round((Number(bal.dr) - Number(bal.cr)) * 100) / 100;
  console.log(gap === 0
    ? "cleanup left the voucher book balanced"
    : `WARNING: cleanup left the voucher book off by ₹${gap}`);
}

main().catch(async (e) => {
  console.error("\nHARNESS ERROR:", e);
  try { await cleanup(); } catch {}
  try { await sql.end(); } catch {}
  process.exit(2);
});
