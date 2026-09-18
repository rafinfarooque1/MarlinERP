/**
 * Bulk attendance correction regression contract.
 *
 * Run against the development API with:
 *   node artifacts/api-server/tests/bulk-attendance.test.mjs
 *
 * The fixture is isolated by a timestamped username and is removed in finally,
 * including any salary accrual/JV rows created by the correction.
 */
const BASE = process.env.API_URL || "http://localhost:8080/api";
const PASSWORD = process.env.TEST_PASSWORD;
const USERNAME = process.env.TEST_USERNAME;
const TAG = `bulk_attendance_${Date.now()}`;

import pg from "pg";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const query = (text, params = []) => sql.query(text, params);

let token = "";
let employeeIds = [];
const checks = [];

function check(id, description, pass, detail = "") {
  checks.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${description}${detail ? ` — ${detail}` : ""}`);
}

async function api(method, path, body, auth = token) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

async function cleanup() {
  if (employeeIds.length === 0) return;
  for (const id of employeeIds) {
    await query("DELETE FROM attendance_punches WHERE employee_id = $1", [id]).catch(() => {});
    await query("DELETE FROM salary_accruals WHERE employee_id = $1", [id]).catch(() => {});
    await query("DELETE FROM attendance WHERE employee_id = $1", [id]).catch(() => {});
    await query("DELETE FROM payroll WHERE employee_id = $1", [id]).catch(() => {});
    await query("DELETE FROM pay_components WHERE employee_id = $1", [id]).catch(() => {});
  }
  const { rows: vouchers } = await query(
    `SELECT id FROM journal_vouchers WHERE narration ILIKE $1`, [`%${TAG}%`],
  );
  for (const voucher of vouchers) {
    await query("DELETE FROM journal_voucher_lines WHERE voucher_id = $1", [voucher.id]).catch(() => {});
    await query("DELETE FROM journal_vouchers WHERE id = $1", [voucher.id]).catch(() => {});
  }
  await query("DELETE FROM employees WHERE id = ANY($1::int[])", [employeeIds]).catch(() => {});
  await query(
    "DELETE FROM activity_log WHERE entity_type = 'attendance_bulk' AND metadata->'employeeIds' @> $1::jsonb",
    [JSON.stringify(employeeIds)],
  ).catch(() => {});
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.log("SKIP: set TEST_USERNAME and TEST_PASSWORD to run the bulk attendance regression harness");
    return;
  }
  const login = await api("POST", "/auth/login", { username: USERNAME, password: PASSWORD }, "");
  token = login.data?.token ?? "";
  check("auth", "Admin fixture login succeeds", login.status === 200 && !!token, `status=${login.status}`);
  if (!token) return;

  const hierarchies = await api("GET", "/hr/hierarchies");
  const hierarchyId = hierarchies.data?.[0]?.id;
  const created = [];
  for (const suffix of ["a", "b"]) {
    const response = await api("POST", "/hr/employees", {
      name: `${TAG}_${suffix}`,
      username: `${TAG}_${suffix}`,
      email: `${TAG}_${suffix}@test.local`,
      hierarchyId,
      branchType: "headoffice",
      branchId: 1,
      salary: 30000,
      joinDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    });
    created.push(response.data);
    if (response.data?.id) employeeIds.push(response.data.id);
  }
  check("fixtures", "Two isolated employees are created", created.length === 2 && employeeIds.length === 2);
  if (employeeIds.length !== 2) return;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const bulk = await api("PUT", "/hr/attendance/bulk", {
    employeeIds,
    date: today,
    status: "present",
    checkIn: null,
    checkOut: null,
  });
  const rowsAfterBulk = await query(
    `SELECT employee_id, status FROM attendance WHERE employee_id = ANY($1::int[]) AND date = $2 ORDER BY employee_id`,
    [employeeIds, today],
  );
  check("bulk", "One request corrects both employees", bulk.status === 200 && bulk.data?.count === 2
    && rowsAfterBulk.rows.length === 2
    && rowsAfterBulk.rows.every((row) => row.status === "present"));

  const accrual = await query(
    `SELECT employee_id, amount FROM salary_accruals
      WHERE employee_id = ANY($1::int[]) AND accrual_date = $2`,
    [employeeIds, today],
  );
  check("payroll", "Bulk correction re-accrues salary for every employee",
    accrual.rows.length === 2 && accrual.rows.every((row) => Number(row.amount) > 0));

  const duplicate = await api("PUT", "/hr/attendance/bulk", {
    employeeIds: [employeeIds[0], employeeIds[0]],
    date: today,
    status: "absent",
  });
  const afterDuplicate = await query(
    "SELECT status FROM attendance WHERE employee_id = $1 AND date = $2",
    [employeeIds[0], today],
  );
  check("duplicates", "Duplicate employee ids are rejected without a write",
    duplicate.status === 400 && afterDuplicate.rows[0]?.status === "present");

  const invalidMember = await api("PUT", "/hr/attendance/bulk", {
    employeeIds: [employeeIds[0], employeeIds[1], 999999999],
    date: today,
    status: "absent",
  });
  const afterInvalid = await query(
    `SELECT employee_id, status FROM attendance
      WHERE employee_id = ANY($1::int[]) AND date = $2 ORDER BY employee_id`,
    [employeeIds, today],
  );
  check("atomic", "A missing employee aborts the entire bulk operation",
    invalidMember.status === 404 && afterInvalid.rows.length === 2
    && afterInvalid.rows.every((row) => row.status === "present"));

  const unauthenticated = await api("PUT", "/hr/attendance/bulk", {
    employeeIds,
    date: today,
    status: "absent",
  }, "");
  check("authorization", "Unauthenticated bulk correction is rejected", unauthenticated.status === 401);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const audit = await query(
    `SELECT metadata FROM activity_log
      WHERE module = 'hr' AND entity_type = 'attendance_bulk'
        AND metadata->'employeeIds' @> $1::jsonb ORDER BY id DESC LIMIT 1`,
    [JSON.stringify(employeeIds)],
  );
  const auditEmployees = audit.rows[0]?.metadata?.employees;
  check("audit", "Bulk audit contains per-employee previous and new attendance values",
    Array.isArray(auditEmployees)
    && auditEmployees.length === 2
    && auditEmployees.every((entry) => entry.before === null
      && entry.after?.status === "present"));

  const individual = await api("PUT", "/hr/attendance", {
    employeeId: employeeIds[0],
    date: today,
    status: "half_day",
    checkIn: null,
    checkOut: null,
  });
  check("individual", "Individual Fix still works after bulk support", individual.status === 200
    && individual.data?.status === "half_day");
}

try {
  await main();
} catch (error) {
  console.error("HARNESS ERROR:", error);
  checks.push({ id: "harness", pass: false });
} finally {
  await cleanup();
  const failed = checks.filter((entry) => !entry.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}