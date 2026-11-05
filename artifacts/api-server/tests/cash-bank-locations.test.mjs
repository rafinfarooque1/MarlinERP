/**
 * Cash/Bank account availability regression.
 *
 * Read-only: this suite creates, edits and deletes no business data. It proves
 * that an account is emitted once with its assigned locations, and that a
 * one-or-more-location filter narrows accounts without duplicating them.
 *
 * Required environment: TEST_USERNAME and TEST_PASSWORD.
 * Run: node artifacts/api-server/tests/cash-bank-locations.test.mjs
 */
const BASE = process.env.API_URL || "http://localhost:8080/api";
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;

if (!username || !password) {
  console.error("TEST_USERNAME and TEST_PASSWORD are required; refusing to guess credentials.");
  process.exit(2);
}

let token = "";
let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function request(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

function keyOf(location) {
  return `${location.locationType}:${location.locationType === "headoffice" ? 0 : location.locationId}`;
}

function keysOf(account) {
  const locations = Array.isArray(account.locations) && account.locations.length > 0
    ? account.locations
    : [account];
  return new Set(locations.map(keyOf));
}

async function login() {
  const response = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json();
  token = data.token;
  if (!token) throw new Error("login failed");
}

async function run() {
  await login();
  const all = await request("/accounts/cash-bank");
  assert("consolidated Cash/Bank list responds", all.status === 200);
  assert("Cash/Bank response is an array", Array.isArray(all.data));

  const accountIds = new Set();
  for (const account of all.data ?? []) {
    const id = Number(account.id);
    assert(`account ${id} appears once`, !accountIds.has(id));
    accountIds.add(id);
    assert(`account ${id} has one canonical primary location`, ["headoffice", "warehouse", "outlet"].includes(account.locationType));
    assert(`account ${id} has a canonical location id`, Number.isInteger(Number(account.locationId)));
    const assignedKeys = keysOf(account);
    assert(`account ${id} has at least one assigned location`, assignedKeys.size > 0);
    if (account.source === "module") {
      assert(`managed account ${id} exposes its location memberships`, Array.isArray(account.locations) && account.locations.length > 0);
      assert(`managed account ${id} keeps its primary location among its memberships`, assignedKeys.has(keyOf(account)));
      assert(`managed account ${id} has unique location memberships`, assignedKeys.size === account.locations.length);
    }
    assert(`account ${id} has numeric ledger balance`, Number.isFinite(Number(account.balance)));
  }

  const mapped = (all.data ?? []).find((account) => keysOf(account).size > 0);
  if (!mapped) {
    console.log("  • No Cash/Bank account is available to exercise the location filter.");
  } else {
    const selected = [...keysOf(mapped)][0];
    const narrowed = await request(`/accounts/cash-bank?locationKeys=${encodeURIComponent(selected)}`);
    assert("location-filtered Cash/Bank list responds", narrowed.status === 200);
    assert("location-filtered response is an array", Array.isArray(narrowed.data));
    const selectedKeys = new Set(selected.split(","));
    for (const account of narrowed.data ?? []) {
      const matches = [...keysOf(account)].some((key) => selectedKeys.has(key));
      assert(`filtered account ${account.id} is available at a selected location`, matches);
      assert(`filtered account ${account.id} remains unique`, !accountIds.has(`filtered:${account.id}`));
      accountIds.add(`filtered:${account.id}`);
      assert(`filtered account ${account.id} has numeric posting-slice balance`, Number.isFinite(Number(account.balance)));
    }
  }

  const ledgerBacked = (all.data ?? []).find((account) => Number.isInteger(Number(account.ledgerId)) && Number(account.ledgerId) > 0);
  if (ledgerBacked) {
    const statement = await request(`/accounts/ledger-statement?accountId=${ledgerBacked.ledgerId}`);
    assert("ledger statement responds", statement.status === 200);
    for (const entry of statement.data?.entries ?? []) {
      assert("ledger entry carries narration", typeof entry.narration === "string");
      assert("ledger entry carries a location type field", Object.hasOwn(entry, "locationType"));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});