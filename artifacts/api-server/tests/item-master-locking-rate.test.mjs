import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const suffix = `${process.pid}${crypto.randomBytes(5).toString("hex")}`.toUpperCase();
const name = `ZZ Lock Rate UI/API ${suffix}`;
const itemCode = `ZZLR${suffix}`;
let token = "";
let itemId = 0;
let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  try {
    assert.ok(condition, detail || label);
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

try {
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.TEST_USERNAME,
      password: process.env.TEST_PASSWORD,
    }),
  });
  const loginData = await login.json();
  token = loginData.token ?? "";
  if (!token) throw new Error("Disposable test authentication did not return a token");

  const created = await request("POST", "/items", {
    name,
    itemCode,
    unit: "kg",
    hsnCode: "",
    taxRate: 5,
    mrp: 400,
    lockingRate: 350,
    cost: 0,
    reorderLevel: 0,
    status: "active",
  });
  itemId = Number(created.data?.id ?? 0);
  check("create saves the configured Locking Rate", created.status === 201 && itemId > 0
    && Number(created.data?.lockingRate) === 350, JSON.stringify(created.data));

  if (itemId) {
    const listed = await request("GET", "/items");
    const listItem = Array.isArray(listed.data) ? listed.data.find((row) => Number(row.id) === itemId) : null;
    check("Item Master list returns the Locking Rate", listed.status === 200
      && Number(listItem?.lockingRate) === 350);

    const reopened = await request("GET", `/items/${itemId}`);
    check("reopened item retains the saved rate", reopened.status === 200
      && Number(reopened.data?.lockingRate) === 350);

    const edited = await request("PATCH", `/items/${itemId}`, { lockingRate: 325 });
    const reopenedAfterEdit = await request("GET", `/items/${itemId}`);
    check("edit persists and reloads the revised rate", edited.status === 200
      && Number(reopenedAfterEdit.data?.lockingRate) === 325);

    const cleared = await request("PATCH", `/items/${itemId}`, { lockingRate: null });
    const reopenedAfterClear = await request("GET", `/items/${itemId}`);
    check("an empty optional value clears the rate instead of saving zero", cleared.status === 200
      && reopenedAfterClear.data?.lockingRate == null);

    check("negative Locking Rate is rejected",
      (await request("PATCH", `/items/${itemId}`, { lockingRate: -1 })).status === 400);
    check("Locking Rate above normal Rate is rejected",
      (await request("PATCH", `/items/${itemId}`, { lockingRate: 401 })).status === 400);
  }
} catch (error) {
  failed++;
  console.error(`FATAL: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (token && itemId) {
    const removed = await request("DELETE", `/items/${itemId}`);
    check("disposable item is removed", removed.status === 204, JSON.stringify(removed.data));
  }
}

console.log(`\nItem Master Locking Rate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
